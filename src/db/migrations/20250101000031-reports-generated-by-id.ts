import type { QueryInterface } from "sequelize";
import type { Migration } from "../umzug";

// The models define the FK attribute `generatedById`, which Sequelize maps to
// the column `generated_by_id` (global `underscored: true` in db/sequelize.ts).
// The original migrations created the column as `generated_by` instead, so any
// INSERT failed with `column "generated_by_id" ... does not exist` — e.g. POST
// /meeting-reports. Rename the columns to what the models expect, preserving
// existing values. Guarded so it is a no-op where the rename already happened.
export const up: Migration = async ({ context: qi }) => {
  await renameIfExists(qi, "reports", "generated_by", "generated_by_id");
  await renameIfExists(qi, "meeting_reports", "generated_by", "generated_by_id");
};

export const down: Migration = async ({ context: qi }) => {
  await renameIfExists(qi, "reports", "generated_by_id", "generated_by");
  await renameIfExists(qi, "meeting_reports", "generated_by_id", "generated_by");
};

async function renameIfExists(
  qi: QueryInterface,
  table: string,
  from: string,
  to: string,
): Promise<void> {
  const columns = (await qi.describeTable(table)) as Record<string, unknown>;
  if (!columns[from]) return; // already renamed (or table predates the column)
  await qi.renameColumn(table, from, to);
}
