import { QueryTypes, type QueryInterface } from "sequelize";

// Postgres SQLSTATE codes for "object already exists".
const ALREADY_EXISTS = new Set([
  "42P07", // duplicate_table / duplicate_index / relation already exists
  "42701", // duplicate_column
  "42710", // duplicate_object (e.g. type, constraint)
  "42P06", // duplicate_schema
]);

function errorCode(err: unknown): string | undefined {
  const e = err as { original?: { code?: string }; parent?: { code?: string }; code?: string };
  return e?.original?.code ?? e?.parent?.code ?? e?.code;
}

// Add values to a Postgres enum column, looking the enum type up rather than
// assuming its name. Values can't be removed again, so these are forever.
export async function addEnumValues(qi: QueryInterface, table: string, column: string, values: string[]): Promise<void> {
  const [row] = await qi.sequelize.query<{ typname: string }>(
    `SELECT t.typname FROM pg_attribute a
       JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_type t ON a.atttypid = t.oid
      WHERE c.relname = :table AND a.attname = :column AND a.attnum > 0`,
    { replacements: { table, column }, type: QueryTypes.SELECT },
  );
  if (!row) throw new Error(`No column ${table}.${column}`);
  for (const value of values) {
    await qi.sequelize.query(`ALTER TYPE "${row.typname}" ADD VALUE IF NOT EXISTS '${value}'`);
  }
}

// Give seeded roles new permissions. Custom edits to a role are kept.
export async function addRolePermissions(qi: QueryInterface, byRole: Record<string, string[]>): Promise<void> {
  for (const [key, perms] of Object.entries(byRole)) {
    await qi.sequelize.query(
      `UPDATE access_roles
          SET permissions = ARRAY(SELECT DISTINCT unnest(permissions || ARRAY[:perms]::varchar[])), updated_at = now()
        WHERE key = :key`,
      { replacements: { key, perms } },
    );
  }
}

export async function removeRolePermissions(qi: QueryInterface, byRole: Record<string, string[]>): Promise<void> {
  for (const [key, perms] of Object.entries(byRole)) {
    await qi.sequelize.query(
      `UPDATE access_roles
          SET permissions = ARRAY(SELECT p FROM unnest(permissions) p WHERE p <> ALL (ARRAY[:perms]::varchar[])), updated_at = now()
        WHERE key = :key`,
      { replacements: { key, perms } },
    );
  }
}

// Run a DDL operation, swallowing "already exists" errors so migrations are
// idempotent and can safely re-run after a partial/interrupted apply.
export async function ignoreDuplicate<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (err) {
    if (ALREADY_EXISTS.has(errorCode(err) ?? "")) return undefined;
    throw err;
  }
}
