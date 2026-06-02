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
