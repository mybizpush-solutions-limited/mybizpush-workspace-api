import { QueryTypes, Sequelize } from "sequelize";
import { badRequest } from "./errors";

// Everything we need to talk to a managed database, derived from the single
// thing we ask a project for: its connection string. We keep the parsed pieces
// so the UI can show "which host / which database" without ever handling the
// credential itself, and so pg_dump can be given discrete flags rather than a
// URI on the command line (argv is world-readable via `ps`).

export interface ParsedConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** libpq sslmode, defaulted to "require" — every hosted provider needs it. */
  sslMode: string;
  /** Safe to store and display: credentials replaced with dots. */
  masked: string;
}

const DEFAULT_PORT = 5432;

export function parseConnectionString(raw: string): ParsedConnection {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw badRequest("That doesn't look like a connection string (expected postgres://…)");
  }

  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw badRequest("Only postgres:// connection strings are supported");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname) throw badRequest("Connection string is missing a host");
  if (!database) throw badRequest("Connection string is missing a database name");

  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const port = url.port ? Number(url.port) : DEFAULT_PORT;

  // Providers spell this a few ways (?sslmode=, ?ssl=true). Hosted Postgres is
  // TLS-only in practice, so "require" is the right default when unstated — but
  // a self-hosted or LAN database often has no TLS at all, which is why the
  // stored sslMode can override this (see resolveSslMode).
  const sslParam = url.searchParams.get("sslmode") ?? url.searchParams.get("ssl_mode");
  const sslMode = sslParam ?? (url.searchParams.get("ssl") === "false" ? "disable" : "require");

  const masked = `${url.protocol}//${user ? `${url.username}${password ? ":••••••" : ""}@` : ""}${url.hostname}:${port}/${database}`;

  return { host: url.hostname, port, database, user, password, sslMode, masked };
}

// Neon / Supabase / Railway / Render all terminate TLS with certificates our
// container has no root for. Verification is only meaningful when the operator
// explicitly asked for it via sslmode=verify-full.
export function sslOptionsFor(sslMode: string) {
  if (sslMode === "disable") return false;
  if (sslMode === "verify-full" || sslMode === "verify-ca") return { require: true };
  return { require: true, rejectUnauthorized: false };
}

// Reconcile the mode derived from the connection string with the explicit
// on/off toggle held against the database. Undefined = no opinion, keep what
// the string said. Turning SSL on preserves a stricter mode (verify-full) if
// one was already set, rather than quietly relaxing it to plain "require".
export function resolveSslMode(derived: string, ssl?: boolean): string {
  if (ssl === undefined) return derived;
  if (!ssl) return "disable";
  return derived === "disable" ? "require" : derived;
}

// Postgres says this when it's built or configured without TLS. It's a common
// and completely fixable state for a self-hosted database, so the raw message
// gets the fix appended rather than leaving someone to guess.
export function annotateConnectionError(message: string): string {
  if (/does not support SSL/i.test(message)) {
    return `${message} — turn SSL off for this database and try again.`;
  }
  return message;
}

export interface ConnectionProbe {
  serverVersion: string;
  sizeBytes: number;
  tableCount: number;
}

// Reject after `ms` regardless of what the underlying driver decides to do.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${ms / 1000}s connecting to the database`)),
        ms,
      );
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Open a short-lived connection to a *managed* database (never our own) to
// confirm the credential still works and collect the couple of numbers the
// console shows. Deliberately single-connection and short-timeout: this runs on
// demand from the UI and must never hold resources open.
export const PROBE_TIMEOUT_MS = 10_000;

export async function probeConnection(parsed: ParsedConnection): Promise<ConnectionProbe> {
  const probe = new Sequelize(parsed.database, parsed.user, parsed.password, {
    host: parsed.host,
    port: parsed.port,
    dialect: "postgres",
    logging: false,
    // `acquire` bounds how long Sequelize waits for a pooled connection;
    // `connectionTimeoutMillis` is node-postgres's own dial timeout. Both are
    // needed — `connectTimeout` is a MySQL option and is silently ignored here.
    pool: { max: 1, min: 0, idle: 1_000, acquire: PROBE_TIMEOUT_MS },
    dialectOptions: {
      ssl: sslOptionsFor(parsed.sslMode),
      connectionTimeoutMillis: PROBE_TIMEOUT_MS,
      query_timeout: PROBE_TIMEOUT_MS,
      statement_timeout: PROBE_TIMEOUT_MS,
    },
    retry: { max: 0 },
  });

  try {
    // Last line of defence. A firewalled host black-holes the SYN, and without
    // this the request would sit on the OS TCP timeout (over a minute) while
    // someone waits on a form that's really just reporting a typo'd address.
    await withTimeout(probe.authenticate(), PROBE_TIMEOUT_MS);
    // QueryTypes.SELECT makes this resolve to the rows themselves rather than
    // Sequelize's [results, metadata] tuple.
    const rows = await probe.query<{ version: string; size: string; tables: string }>(
      `SELECT version() AS version,
              pg_database_size(current_database())::text AS size,
              (SELECT count(*)::text FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')) AS tables`,
      { type: QueryTypes.SELECT },
    );
    const row = rows[0];
    return {
      // "PostgreSQL 16.2 on aarch64…" → "16.2"; the rest is noise in a table cell.
      serverVersion: row?.version?.match(/PostgreSQL ([\d.]+)/)?.[1] ?? "",
      sizeBytes: Number(row?.size ?? 0),
      tableCount: Number(row?.tables ?? 0),
    };
  } finally {
    await probe.close().catch(() => undefined);
  }
}

// Postgres error objects carry more useful text than the Error message alone
// (e.g. "password authentication failed for user"). Surface that to the UI.
export function connectionErrorMessage(err: unknown): string {
  const e = err as { original?: { message?: string }; parent?: { message?: string }; message?: string };
  const raw = e?.original?.message ?? e?.parent?.message ?? e?.message ?? "Connection failed";
  return annotateConnectionError(raw).slice(0, 500);
}
