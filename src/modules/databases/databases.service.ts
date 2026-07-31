import { Op } from "sequelize";
import { conflict, notFound } from "../../lib/errors";
import { encryptSecret, decryptSecret } from "../../lib/crypto";
import {
  connectionErrorMessage,
  parseConnectionString,
  probeConnection,
  resolveSslMode,
} from "../../lib/pgconn";
import { isCloudinaryConfigured } from "../../lib/cloudinary";
import { pgDumpVersion } from "../../lib/pgdump";
import { env } from "../../config/env";
import { assertCanManageDatabases, type Auth } from "../../lib/permissions";
import {
  DatabaseBackup,
  DatabaseBackupSchedule,
  Project,
  ProjectDatabase,
  type DbEnvironment,
} from "../../models";
import { serializeBackup, type SerializedBackup } from "./backups.serialize";
import { serializeSchedule, type SerializedSchedule } from "./schedules.helpers";

export interface SerializedDatabase {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  environment: DbEnvironment;
  provider: string;
  /** Credentials replaced with dots — the real string never leaves the server. */
  connectionMasked: string;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  sslMode: string;
  /** Convenience view of sslMode for the toggle in the UI. */
  ssl: boolean;
  status: string;
  lastCheckedAt: string | null;
  lastError: string;
  sizeBytes: number;
  tableCount: number;
  serverVersion: string;
  retentionCount: number;
  notes: string;
  backupCount: number;
  lastBackup: SerializedBackup | null;
  schedule: SerializedSchedule | null;
  createdAt: string;
  updatedAt: string;
}

interface Extras {
  projectName?: string;
  backupCount?: number;
  lastBackup?: DatabaseBackup | null;
  schedule?: DatabaseBackupSchedule | null;
}

function serialize(db: ProjectDatabase, extras: Extras = {}): SerializedDatabase {
  return {
    id: db.id,
    projectId: db.projectId,
    projectName: extras.projectName ?? (db.get("project") as Project | undefined)?.name ?? "",
    name: db.name,
    environment: db.environment,
    provider: db.provider,
    connectionMasked: `postgres://${db.username ? `${db.username}:••••••@` : ""}${db.host}:${db.port}/${db.databaseName}`,
    host: db.host,
    port: db.port,
    databaseName: db.databaseName,
    username: db.username,
    sslMode: db.sslMode,
    ssl: db.sslMode !== "disable",
    status: db.status,
    lastCheckedAt: db.lastCheckedAt?.toISOString() ?? null,
    lastError: db.lastError,
    // BIGINT arrives from pg as a string; the UI wants a number.
    sizeBytes: Number(db.sizeBytes ?? 0),
    tableCount: db.tableCount,
    serverVersion: db.serverVersion,
    retentionCount: db.retentionCount,
    notes: db.notes,
    backupCount: extras.backupCount ?? 0,
    lastBackup: extras.lastBackup ? serializeBackup(extras.lastBackup) : null,
    schedule: extras.schedule ? serializeSchedule(extras.schedule) : null,
    createdAt: db.createdAt.toISOString(),
    updatedAt: db.updatedAt.toISOString(),
  };
}

// Load a database, having confirmed the caller holds an admin-or-above access
// level. Connection strings are production credentials, so this is the gate on
// every route in the module — there is no read-only tier and no project-level
// path in (see canManageDatabases).
export async function loadManaged(id: string, auth: Auth): Promise<ProjectDatabase> {
  assertCanManageDatabases(auth);
  const db = await ProjectDatabase.findByPk(id);
  if (!db) throw notFound("Database not found");
  return db;
}

// Decrypt on demand, never as part of a read path that returns to the client.
//
// The stored sslMode wins over whatever the connection string implies: the
// string usually says nothing about TLS, and parseConnectionString then assumes
// "require" — which is wrong for the self-hosted databases that answer
// "the server does not support SSL connections". The toggle is the authority.
export function connectionFor(db: ProjectDatabase) {
  const parsed = parseConnectionString(decryptSecret(db.connectionString));
  return { ...parsed, sslMode: db.sslMode || parsed.sslMode };
}

// Attach the counts / last backup / schedule that the console renders, for a
// whole page of databases in three queries rather than three per row.
async function decorate(dbs: ProjectDatabase[]): Promise<SerializedDatabase[]> {
  if (dbs.length === 0) return [];
  const ids = dbs.map((d) => d.id);

  const [backups, schedules, projects] = await Promise.all([
    DatabaseBackup.findAll({ where: { databaseId: { [Op.in]: ids } }, order: [["createdAt", "DESC"]] }),
    DatabaseBackupSchedule.findAll({ where: { databaseId: { [Op.in]: ids } } }),
    Project.findAll({
      where: { id: { [Op.in]: [...new Set(dbs.map((d) => d.projectId))] } },
      attributes: ["id", "name"],
    }),
  ]);

  const counts = new Map<string, number>();
  const latest = new Map<string, DatabaseBackup>();
  for (const b of backups) {
    counts.set(b.databaseId, (counts.get(b.databaseId) ?? 0) + 1);
    if (!latest.has(b.databaseId)) latest.set(b.databaseId, b); // ordered DESC
  }
  const scheduleBy = new Map(schedules.map((s) => [s.databaseId, s]));
  const projectBy = new Map(projects.map((p) => [p.id, p.name]));

  return dbs.map((db) =>
    serialize(db, {
      projectName: projectBy.get(db.projectId) ?? "",
      backupCount: counts.get(db.id) ?? 0,
      lastBackup: latest.get(db.id) ?? null,
      schedule: scheduleBy.get(db.id) ?? null,
    }),
  );
}

export interface CreateDatabaseInput {
  projectId: string;
  name: string;
  connectionString: string;
  /** Off for servers built without TLS; omitted means "trust the URL". */
  ssl?: boolean;
  environment?: DbEnvironment;
  provider?: string;
  retentionCount?: number;
  notes?: string;
}

export type UpdateDatabaseInput = Partial<Omit<CreateDatabaseInput, "projectId">>;

export const databasesService = {
  // Every database we manage, optionally narrowed to one project. Members never
  // reach this — the console is deliberately not a directory of our credentials.
  async list(auth: Auth, projectId?: string): Promise<SerializedDatabase[]> {
    assertCanManageDatabases(auth);
    const where = projectId ? { projectId } : {};
    const dbs = await ProjectDatabase.findAll({ where, order: [["createdAt", "ASC"]] });
    return decorate(dbs);
  },

  async byId(id: string, auth: Auth): Promise<SerializedDatabase> {
    const db = await loadManaged(id, auth);
    return (await decorate([db]))[0]!;
  },

  async create(input: CreateDatabaseInput, auth: Auth): Promise<SerializedDatabase> {
    assertCanManageDatabases(auth);
    if (!(await Project.findByPk(input.projectId))) throw notFound("Project not found");
    const parsed = parseConnectionString(input.connectionString);

    // Two entries for the same database on one project is nearly always a
    // duplicate paste rather than an intent. The identity is host+PORT+database:
    // one box routinely runs several instances on different ports, all of them
    // serving a database called "postgres" — dev on :5488 and prod on :7654 is
    // an ordinary setup, not a duplicate.
    const existing = await ProjectDatabase.findOne({
      where: {
        projectId: input.projectId,
        host: parsed.host,
        port: parsed.port,
        databaseName: parsed.database,
      },
    });
    if (existing) {
      throw conflict(
        `${parsed.database} on ${parsed.host}:${parsed.port} is already registered as "${existing.name}"`,
      );
    }

    const sslMode = resolveSslMode(parsed.sslMode, input.ssl);
    const db = await ProjectDatabase.create({
      projectId: input.projectId,
      name: input.name,
      environment: input.environment ?? "development",
      provider: input.provider ?? providerFromHost(parsed.host),
      connectionString: encryptSecret(input.connectionString.trim()),
      host: parsed.host,
      port: parsed.port,
      databaseName: parsed.database,
      username: parsed.user,
      sslMode,
      retentionCount: input.retentionCount ?? 7,
      notes: input.notes ?? "",
      createdBy: auth.sub,
    });

    // Probe immediately so a typo'd credential surfaces on the card the moment
    // it's added, not the first time a scheduled backup fails at 2am. Probe with
    // the *resolved* mode — `parsed` still carries the URL's assumption.
    await probeAndSave(db, { ...parsed, sslMode });
    return (await decorate([db]))[0]!;
  },

  async update(id: string, patch: UpdateDatabaseInput, auth: Auth): Promise<SerializedDatabase> {
    const db = await loadManaged(id, auth);

    if (patch.connectionString) {
      const parsed = parseConnectionString(patch.connectionString);
      db.connectionString = encryptSecret(patch.connectionString.trim());
      db.host = parsed.host;
      db.port = parsed.port;
      db.databaseName = parsed.database;
      db.username = parsed.user;
      db.sslMode = resolveSslMode(parsed.sslMode, patch.ssl);
      db.status = "unknown";
      db.lastError = "";
    } else if (patch.ssl !== undefined) {
      // Toggling SSL on its own is the common fix after a failed probe, so it
      // must work without re-entering the credential.
      db.sslMode = resolveSslMode(db.sslMode, patch.ssl);
      db.status = "unknown";
      db.lastError = "";
    }
    if (patch.name !== undefined) db.name = patch.name;
    if (patch.environment !== undefined) db.environment = patch.environment;
    if (patch.provider !== undefined) db.provider = patch.provider;
    if (patch.retentionCount !== undefined) db.retentionCount = patch.retentionCount;
    if (patch.notes !== undefined) db.notes = patch.notes;
    await db.save();

    if (patch.connectionString || patch.ssl !== undefined) {
      await probeAndSave(db, connectionFor(db));
    }
    return (await decorate([db]))[0]!;
  },

  // Removing a database takes its backup artifacts with it — leaving orphaned
  // dumps of a production database lying in Cloudinary is worse than losing them.
  async remove(id: string, auth: Auth): Promise<void> {
    const db = await loadManaged(id, auth);
    const { deleteArtifacts } = await import("./backups.service");
    const backups = await DatabaseBackup.findAll({ where: { databaseId: db.id } });
    for (const backup of backups) await deleteArtifacts(backup);
    await DatabaseBackup.destroy({ where: { databaseId: db.id } });
    await DatabaseBackupSchedule.destroy({ where: { databaseId: db.id } });
    await db.destroy();
  },

  // On-demand connection check from the UI.
  async test(id: string, auth: Auth): Promise<SerializedDatabase> {
    const db = await loadManaged(id, auth);
    await probeAndSave(db, connectionFor(db));
    return (await decorate([db]))[0]!;
  },

  // What the host can actually do right now. The UI uses this to warn up front
  // rather than letting someone schedule backups that can never run.
  async capabilities() {
    const version = await pgDumpVersion();
    return {
      pgDumpAvailable: Boolean(version),
      pgDumpVersion: version ?? "",
      cloudinaryConfigured: isCloudinaryConfigured(),
      cloudinaryMaxMb: env.BACKUP_CLOUDINARY_MAX_MB,
      defaultTimezone: env.BACKUP_DEFAULT_TIMEZONE,
      schedulerEnabled: env.ENABLE_BACKUP_SCHEDULER,
    };
  },
};

// Run a connection probe and record the outcome. Never throws — a database
// that's down is a status on the card, not a failed request.
export async function probeAndSave(
  db: ProjectDatabase,
  parsed = connectionFor(db),
): Promise<void> {
  try {
    const probe = await probeConnection(parsed);
    db.status = "ok";
    db.lastError = "";
    db.sizeBytes = probe.sizeBytes;
    db.tableCount = probe.tableCount;
    db.serverVersion = probe.serverVersion;
  } catch (err) {
    db.status = "error";
    db.lastError = connectionErrorMessage(err);
  }
  db.lastCheckedAt = new Date();
  await db.save();
}

// Best-effort guess so the card shows a provider badge without asking for one.
function providerFromHost(host: string): string {
  const known: [RegExp, string][] = [
    [/neon\.tech$/, "neon"],
    [/supabase\.(co|com|net)$/, "supabase"],
    [/railway\.(app|internal)$/, "railway"],
    [/render\.com$/, "render"],
    [/rds\.amazonaws\.com$/, "aws-rds"],
    [/digitalocean\.com$/, "digitalocean"],
    [/aivencloud\.com$/, "aiven"],
    [/^(localhost|127\.0\.0\.1)$/, "local"],
  ];
  return known.find(([re]) => re.test(host))?.[1] ?? "";
}
