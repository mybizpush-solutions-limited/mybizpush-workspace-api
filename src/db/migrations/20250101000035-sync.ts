import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Offline sync support (API-CHANGES A006):
// - updated_at on tables that only had created_at, so "changed since" works
// - sync_tombstones, so clients learn about deletions
// - updated_at indexes for the delta queries
const ADD_UPDATED_AT = ["comments", "notifications", "meetings"];
const INDEX_UPDATED_AT = ["tasks", "issues", "comments", "notifications", "meetings"];

export const up: Migration = async ({ context: qi }) => {
  for (const table of ADD_UPDATED_AT) {
    const columns = await qi.describeTable(table);
    if (!columns.updated_at) {
      await qi.addColumn(table, "updated_at", { type: DataTypes.DATE, allowNull: true });
      await qi.sequelize.query(`UPDATE "${table}" SET updated_at = created_at WHERE updated_at IS NULL`);
      await qi.changeColumn(table, "updated_at", { type: DataTypes.DATE, allowNull: false });
    }
  }
  for (const table of INDEX_UPDATED_AT) {
    await ignoreDuplicate(qi.addIndex(table, ["updated_at"], { name: `${table}_updated_at` }));
  }

  await ignoreDuplicate(
    qi.createTable("sync_tombstones", {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      collection: { type: DataTypes.STRING(40), allowNull: false },
      record_id: { type: DataTypes.STRING(80), allowNull: false },
      // Set for per-user collections (notifications) so only the owner pulls it.
      user_id: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(
    qi.addIndex("sync_tombstones", ["collection", "deleted_at"], { name: "sync_tombstones_collection_deleted" }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("sync_tombstones");
  for (const table of INDEX_UPDATED_AT) {
    await qi.removeIndex(table, `${table}_updated_at`).catch(() => undefined);
  }
  for (const table of ADD_UPDATED_AT) {
    await qi.removeColumn(table, "updated_at").catch(() => undefined);
  }
};
