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
  // TLS-only in practice, so "require" is the right default when unstated.
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

export interface ConnectionProbe {
  serverVersion: string;
  sizeBytes: number;
  tableCount: number;
}

// Open a short-lived connection to a *managed* database (never our own) to
// confirm the credential still works and collect the couple of numbers the
// console shows. Deliberately single-connection and short-timeout: this runs on
// demand from the UI and must never hold resources open.
export async function probeConnection(parsed: ParsedConnection): Promise<ConnectionProbe> {
  const probe = new Sequelize(parsed.database, parsed.user, parsed.password, {
    host: parsed.host,
    port: parsed.port,
    dialect: "postgres",
    logging: false,
    pool: { max: 1, min: 0, idle: 1_000 },
    dialectOptions: { ssl: sslOptionsFor(parsed.sslMode), connectTimeout: 10_000 },
    retry: { max: 0 },
  });

  try {
    await probe.authenticate();
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
  return (e?.original?.message ?? e?.parent?.message ?? e?.message ?? "Connection failed").slice(0, 500);
}
