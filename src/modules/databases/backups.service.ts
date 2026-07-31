import { randomBytes } from "node:crypto";
import { access, mkdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Op } from "sequelize";
import { env } from "../../config/env";
import { AppError, badRequest, notFound } from "../../lib/errors";
import {
  destroyAsset,
  isCloudinaryConfigured,
  signedDownloadUrl,
  uploadFile,
} from "../../lib/cloudinary";
import {
  FORMAT_EXTENSION,
  assertPgDumpAvailable,
  runPgDump,
  type BackupFormat,
} from "../../lib/pgdump";
import { assertCanManageDatabases, type Auth } from "../../lib/permissions";
import { DatabaseBackup, ProjectDatabase, type BackupStorage } from "../../models";
import { redis } from "../../redis/client";
import { serializeBackup, type SerializedBackup } from "./backups.serialize";
import { connectionFor, loadManaged } from "./databases.service";

// Root of the local artifact volume. Relative paths resolve against the process
// cwd so a dev checkout works without configuration; in Docker this must point
// at a mounted volume or backups vanish with the container.
const STORAGE_ROOT = isAbsolute(env.BACKUP_STORAGE_DIR)
  ? env.BACKUP_STORAGE_DIR
  : resolve(process.cwd(), env.BACKUP_STORAGE_DIR);

// One dump per database at a time. Two concurrent pg_dumps against the same
// database is pure contention, and the second would usually be a double-click.
const inFlight = new Set<string>();

const DOWNLOAD_TOKEN_PREFIX = "dlbackup:";

function timestampSlug(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function fileNameFor(db: ProjectDatabase, format: BackupFormat, at: Date): string {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe(db.databaseName || db.name)}-${safe(db.environment)}-${timestampSlug(at)}.${FORMAT_EXTENSION[format]}`;
}

export interface RunBackupOptions {
  trigger: "manual" | "scheduled";
  format?: BackupFormat;
  storageTarget?: BackupStorage;
  userId?: string | null;
}

interface PreparedRun {
  backup: DatabaseBackup;
  filePath: string;
  format: BackupFormat;
}

// Claim the slot and write the "running" row. Split out from the dump itself so
// a manual trigger can hand the row straight back to the UI (202) instead of
// holding an HTTP request open for however long the dump takes.
//
// The row exists *before* pg_dump starts on purpose: a crash or a deploy
// mid-dump then leaves visible evidence rather than nothing at all.
async function prepareRun(db: ProjectDatabase, options: RunBackupOptions): Promise<PreparedRun> {
  if (inFlight.has(db.id)) {
    throw new AppError(409, "A backup of this database is already running", "backup_in_progress");
  }
  // Fail before writing a row if the host simply can't take backups.
  await assertPgDumpAvailable();
  inFlight.add(db.id);

  try {
    const format: BackupFormat = (options.format ?? "custom") as BackupFormat;
    const startedAt = new Date();
    const fileName = fileNameFor(db, format, startedAt);
    const filePath = join(STORAGE_ROOT, db.id, fileName);

    const backup = await DatabaseBackup.create({
      databaseId: db.id,
      projectId: db.projectId,
      status: "running",
      trigger: options.trigger,
      format,
      fileName,
      startedAt,
      createdBy: options.userId ?? null,
    });
    return { backup, filePath, format };
  } catch (err) {
    inFlight.delete(db.id);
    throw err;
  }
}

// The slow half: dump → store → record → prune. Failures are recorded on the
// row and rethrown, so a scheduled run leaves its reason in the history.
async function executeRun(
  db: ProjectDatabase,
  { backup, filePath, format }: PreparedRun,
  options: RunBackupOptions,
): Promise<void> {
  const startedAt = backup.startedAt;
  const dir = join(STORAGE_ROOT, db.id);
  try {
    await mkdir(dir, { recursive: true });
    const result = await runPgDump(connectionFor(db), format, filePath);

    backup.fileSizeBytes = result.sizeBytes;
    backup.checksum = result.checksum;
    backup.pgDumpVersion = result.pgDumpVersion;
    backup.localPath = filePath;
    backup.storage = "local";

    // Cloudinary is the default home, but it isn't always a viable one: raw
    // uploads are capped by plan (10MB free, ~100MB paid), so an oversized dump
    // stays on the volume rather than failing the whole backup.
    const wantsCloud = (options.storageTarget ?? "cloudinary") === "cloudinary";
    const maxBytes = env.BACKUP_CLOUDINARY_MAX_MB * 1024 * 1024;

    if (!wantsCloud) {
      backup.storageNote = "Kept on the API volume (local storage was requested)";
    } else if (!isCloudinaryConfigured()) {
      backup.storageNote = "Kept on the API volume — Cloudinary is not configured";
    } else if (result.sizeBytes > maxBytes) {
      backup.storageNote = `Kept on the API volume — ${formatBytes(result.sizeBytes)} exceeds the ${env.BACKUP_CLOUDINARY_MAX_MB}MB Cloudinary limit`;
    } else {
      try {
        const uploaded = await uploadFile(filePath, {
          folder: `${env.CLOUDINARY_UPLOAD_FOLDER}/db-backups/${db.id}`,
          // Strip the extension: Cloudinary appends the format itself for raw.
          publicId: backup.fileName.replace(/\.(dump|sql\.gz)$/, ""),
          tags: ["db-backup", db.projectId, db.environment],
          // "authenticated" keeps the dump off the public CDN — a guessable
          // public URL to a production dump would be a serious hole.
          type: "authenticated",
        });
        backup.storage = "cloudinary";
        backup.cloudinaryPublicId = uploaded.public_id;
        backup.cloudinaryFormat = uploaded.format ?? "";
        backup.storageNote = "";

        if (!env.BACKUP_KEEP_LOCAL_COPY) {
          await unlink(filePath).catch(() => undefined);
          backup.localPath = "";
        }
      } catch (err) {
        // An upload failure must not lose the dump we just spent minutes taking.
        backup.storageNote = `Kept on the API volume — Cloudinary upload failed: ${(err as Error).message}`.slice(0, 300);
      }
    }

    backup.status = "succeeded";
    backup.finishedAt = new Date();
    backup.durationMs = backup.finishedAt.getTime() - startedAt.getTime();
    await backup.save();

    await pruneOldBackups(db);
  } catch (err) {
    backup.status = "failed";
    backup.finishedAt = new Date();
    backup.durationMs = backup.finishedAt.getTime() - startedAt.getTime();
    backup.error = ((err as Error).message ?? "Backup failed").slice(0, 2000);
    await backup.save();
    await unlink(filePath).catch(() => undefined);
    throw err;
  } finally {
    inFlight.delete(db.id);
  }
}

// Run a backup to completion. Used by the scheduler, which has no caller to
// keep waiting and does want to log the outcome.
export async function runBackup(
  db: ProjectDatabase,
  options: RunBackupOptions,
): Promise<SerializedBackup> {
  const prepared = await prepareRun(db, options);
  await executeRun(db, prepared, options);
  return serializeBackup(prepared.backup);
}

// Kick a backup off and return the "running" row immediately. The UI polls the
// backup list to watch it finish — a dump of any real database outlives the
// timeouts of every proxy between the browser and here.
export async function startBackup(
  db: ProjectDatabase,
  options: RunBackupOptions,
): Promise<SerializedBackup> {
  const prepared = await prepareRun(db, options);
  void executeRun(db, prepared, options).catch(() => undefined); // recorded on the row
  return serializeBackup(prepared.backup);
}

// Keep the newest `retentionCount` successful backups; older artifacts and rows
// go. Failed rows are kept — they're the audit trail for why a night was missed.
async function pruneOldBackups(db: ProjectDatabase): Promise<void> {
  const keep = Math.max(1, db.retentionCount);
  const stale = await DatabaseBackup.findAll({
    where: { databaseId: db.id, status: "succeeded" },
    order: [["createdAt", "DESC"]],
    offset: keep,
  });
  for (const backup of stale) {
    await deleteArtifacts(backup);
    await backup.destroy();
  }
}

// Remove the stored file(s) for a backup, wherever they ended up. Best effort:
// a missing artifact shouldn't block deleting the row that points at it.
export async function deleteArtifacts(backup: DatabaseBackup): Promise<void> {
  if (backup.cloudinaryPublicId) {
    await destroyAsset(backup.cloudinaryPublicId, "raw", "authenticated").catch(() => undefined);
  }
  if (backup.localPath) {
    await unlink(backup.localPath).catch(() => undefined);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export const backupsService = {
  async list(databaseId: string, auth: Auth): Promise<SerializedBackup[]> {
    await loadManaged(databaseId, auth);
    const backups = await DatabaseBackup.findAll({
      where: { databaseId },
      order: [["createdAt", "DESC"]],
      limit: 100,
    });
    return backups.map(serializeBackup);
  },

  async trigger(
    databaseId: string,
    auth: Auth,
    options: { format?: BackupFormat; storageTarget?: BackupStorage } = {},
  ): Promise<SerializedBackup> {
    const db = await loadManaged(databaseId, auth);
    return startBackup(db, {
      trigger: "manual",
      format: options.format,
      storageTarget: options.storageTarget,
      userId: auth.sub,
    });
  },

  async remove(backupId: string, auth: Auth): Promise<void> {
    const backup = await DatabaseBackup.findByPk(backupId);
    if (!backup) throw notFound("Backup not found");
    assertCanManageDatabases(auth);
    await deleteArtifacts(backup);
    await backup.destroy();
  },

  // A short-lived link the browser can follow directly. Cloudinary-hosted
  // artifacts get a signed Cloudinary URL; local ones get a one-time token that
  // the (unauthenticated, token-gated) file route accepts — a plain <a download>
  // can't carry a bearer header.
  async downloadUrl(
    backupId: string,
    auth: Auth,
    apiOrigin: string,
  ): Promise<{ url: string; expiresIn: number; fileName: string }> {
    const backup = await DatabaseBackup.findByPk(backupId);
    if (!backup) throw notFound("Backup not found");
    assertCanManageDatabases(auth);
    if (backup.status !== "succeeded") throw badRequest("That backup did not complete");

    const ttl = env.BACKUP_DOWNLOAD_TTL_SECONDS;

    if (backup.storage === "cloudinary" && backup.cloudinaryPublicId) {
      return {
        url: signedDownloadUrl(backup.cloudinaryPublicId, backup.cloudinaryFormat, ttl, backup.fileName),
        expiresIn: ttl,
        fileName: backup.fileName,
      };
    }

    if (!backup.localPath) throw notFound("The file for that backup is no longer available");
    await access(backup.localPath).catch(() => {
      throw notFound("The file for that backup is no longer on this host");
    });

    const token = randomBytes(24).toString("base64url");
    await redis.set(`${DOWNLOAD_TOKEN_PREFIX}${token}`, backup.id, "EX", ttl);
    return {
      url: `${apiOrigin}/api/v1/databases/backups/file?token=${token}`,
      expiresIn: ttl,
      fileName: backup.fileName,
    };
  },

  // Redeem a download token. Single use — the file is streamed once and the
  // token is dropped, so a link pasted into a chat is dead on arrival.
  async redeemDownloadToken(token: string): Promise<DatabaseBackup> {
    const key = `${DOWNLOAD_TOKEN_PREFIX}${token}`;
    const backupId = await redis.get(key);
    if (!backupId) throw notFound("That download link has expired");
    await redis.del(key);
    const backup = await DatabaseBackup.findByPk(backupId);
    if (!backup?.localPath) throw notFound("Backup file not found");
    return backup;
  },

  // A dump interrupted by a deploy or a crash leaves a "running" row forever.
  // Called at boot so the history is honest about what actually happened.
  async reconcileStale(): Promise<number> {
    const cutoff = new Date(Date.now() - env.BACKUP_TIMEOUT_MS * 2);
    const [count] = await DatabaseBackup.update(
      {
        status: "failed",
        error: "Interrupted — the API restarted while this backup was running",
        finishedAt: new Date(),
      },
      { where: { status: "running", startedAt: { [Op.lt]: cutoff } } },
    );
    return count;
  },
};
