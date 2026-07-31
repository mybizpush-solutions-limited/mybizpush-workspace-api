import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { env } from "../config/env";
import { AppError } from "./errors";
import { annotateConnectionError, type ParsedConnection } from "./pgconn";

// Thin wrapper around the real pg_dump binary. We shell out rather than
// reimplementing a dump in JS because only pg_dump produces something we'd
// actually trust to restore from — extensions, sequences, constraints and all.

export const BACKUP_FORMATS = ["custom", "plain"] as const;
export type BackupFormat = (typeof BACKUP_FORMATS)[number];

// "custom" is pg_dump's own compressed archive, restored with pg_restore and
// selectively (single table, schema-only, …). "plain" is a gzipped .sql file,
// restorable by piping into psql — slower and bigger, but readable and portable.
export const FORMAT_EXTENSION: Record<BackupFormat, string> = {
  custom: "dump",
  plain: "sql.gz",
};

let versionCache: string | null | undefined;

// Ask the binary who it is. Cached — the answer can't change without a restart.
export async function pgDumpVersion(): Promise<string | null> {
  if (versionCache !== undefined) return versionCache;
  versionCache = await new Promise<string | null>((resolve) => {
    const child = spawn(env.PG_DUMP_PATH, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) =>
      resolve(code === 0 ? (out.match(/([\d.]+)/)?.[1] ?? out.trim()) : null),
    );
  });
  return versionCache;
}

export async function assertPgDumpAvailable(): Promise<string> {
  const version = await pgDumpVersion();
  if (!version) {
    throw new AppError(
      503,
      `pg_dump was not found (looked for "${env.PG_DUMP_PATH}"). Install the postgresql-client package on the API host or set PG_DUMP_PATH.`,
      "pg_dump_unavailable",
    );
  }
  return version;
}

export interface DumpResult {
  filePath: string;
  sizeBytes: number;
  /** sha256 of the artifact, so a restored download can be verified. */
  checksum: string;
  pgDumpVersion: string;
}

// pg_dump chatters progress and warnings on stderr even on success, so we keep
// a bounded tail and only surface it when the exit code says something failed.
function tail(text: string, max = 2000): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

export async function runPgDump(
  parsed: ParsedConnection,
  format: BackupFormat,
  filePath: string,
): Promise<DumpResult> {
  const version = await assertPgDumpAvailable();
  await mkdir(dirname(filePath), { recursive: true });

  // The credential goes through the environment, never argv — anything on the
  // command line is visible to every process on the host via `ps`.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PGPASSWORD: parsed.password,
    PGSSLMODE: parsed.sslMode,
    PGCONNECT_TIMEOUT: "15",
  };

  const args = [
    "--host", parsed.host,
    "--port", String(parsed.port),
    "--username", parsed.user,
    "--dbname", parsed.database,
    "--no-password", // never block on an interactive prompt
    "--format", format === "custom" ? "custom" : "plain",
    // No --file: pg_dump writes to stdout by default, which lets us hash and
    // compress in a single pass. (`--file -` is *not* stdout to pg_dump — it
    // silently creates a file literally named "-".)
  ];

  const child = spawn(env.PG_DUMP_PATH, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = tail(stderr + chunk.toString(), 8000);
  });

  const hash = createHash("sha256");
  const out = createWriteStream(filePath);

  const timer = setTimeout(() => child.kill("SIGKILL"), env.BACKUP_TIMEOUT_MS);
  timer.unref();

  // Hash the bytes we actually persist, so the checksum covers the gzip layer
  // too and can be verified against a plain `sha256sum` of the download.
  const hashing = async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  };

  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(signal === "SIGKILL" ? -1 : (code ?? 1)));
  });

  try {
    const stages =
      format === "plain"
        ? [child.stdout, createGzip({ level: 6 }), hashing, out]
        : [child.stdout, hashing, out];
    // @ts-expect-error — pipeline's variadic overloads don't model a mixed
    // stream/generator array, but the runtime contract holds.
    await pipeline(...stages);
    const code = await exited;

    if (code === -1) {
      throw new AppError(
        504,
        `pg_dump timed out after ${Math.round(env.BACKUP_TIMEOUT_MS / 60000)} minutes`,
        "pg_dump_timeout",
      );
    }
    if (code !== 0) {
      throw new AppError(
        502,
        annotateConnectionError(`pg_dump exited with code ${code}: ${stderr.trim() || "no output"}`),
        "pg_dump_failed",
      );
    }

    const { size } = await stat(filePath);
    if (size === 0) {
      throw new AppError(502, "pg_dump produced an empty file", "pg_dump_empty");
    }
    return {
      filePath,
      sizeBytes: size,
      checksum: hash.digest("hex"),
      pgDumpVersion: version,
    };
  } catch (err) {
    child.kill("SIGKILL");
    await unlink(filePath).catch(() => undefined);
    if (err instanceof AppError) throw err;
    // A connection refusal or a version mismatch lands here; stderr is where
    // pg_dump explains itself, so prefer it over the stream error.
    throw new AppError(
      502,
      annotateConnectionError(stderr.trim() || (err as Error).message || "pg_dump failed"),
      "pg_dump_failed",
    );
  } finally {
    clearTimeout(timer);
  }
}
