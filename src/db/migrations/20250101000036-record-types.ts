import { QueryTypes } from "sequelize";
import type { Migration } from "../umzug";

// Comments, attachments, activity and notifications can now belong to more
// than tasks and issues (API-CHANGES A008). Postgres enums are extended in
// place, so existing rows are untouched. Values cannot be removed from an enum,
// so `down` is a no-op.
const TABLES = ["comments", "attachments", "activity", "notifications"];
const NEW_VALUES = ["meeting", "announcement", "query", "content", "campaign", "target", "project", "product"];

export const up: Migration = async ({ context: qi }) => {
  for (const table of TABLES) {
    // Look the enum type up rather than assuming Sequelize's naming.
    const [row] = await qi.sequelize.query<{ typname: string }>(
      `SELECT t.typname FROM pg_attribute a
         JOIN pg_class c ON a.attrelid = c.oid
         JOIN pg_type t ON a.atttypid = t.oid
        WHERE c.relname = :table AND a.attname = 'item_type' AND a.attnum > 0`,
      { replacements: { table }, type: QueryTypes.SELECT },
    );
    if (!row) throw new Error(`No item_type enum on ${table}`);
    for (const value of NEW_VALUES) {
      await qi.sequelize.query(`ALTER TYPE "${row.typname}" ADD VALUE IF NOT EXISTS '${value}'`);
    }
  }
};

export const down: Migration = async () => {
  // Enum values can't be dropped without rebuilding the type; leaving them is harmless.
};
