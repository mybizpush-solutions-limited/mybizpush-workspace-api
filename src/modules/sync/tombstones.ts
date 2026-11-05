import {
  DataTypes,
  Model,
  type CreationOptional,
  type DestroyOptions,
  type InferAttributes,
  type InferCreationAttributes,
  type ModelStatic,
  type Transaction,
} from "sequelize";
import { sequelize } from "../../db/sequelize";
import { Comment, Issue, Meeting, Notification, Task } from "../../models";

// Deletion records for offline sync (API-CHANGES A006). Clients hold copies of
// records; when one is deleted they need to hear about it on their next pull.
// Hooks below write a tombstone for every destroyed row, including bulk
// destroys (deleting a project removes its tasks, comments, notifications).

export class SyncTombstone extends Model<InferAttributes<SyncTombstone>, InferCreationAttributes<SyncTombstone>> {
  declare id: CreationOptional<number>;
  declare collection: string;
  declare recordId: string;
  declare userId: CreationOptional<string | null>;
  declare deletedAt: Date;
}
SyncTombstone.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    collection: { type: DataTypes.STRING(40), allowNull: false },
    recordId: { type: DataTypes.STRING(80), allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: true },
    deletedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: "sync_tombstones", timestamps: false },
);

type Row = { id: string; userId?: string | null };
type BulkOptions = DestroyOptions & { syncDoomed?: Row[] };

async function writeTombstones(collection: string, rows: Row[], perUser: boolean, transaction?: Transaction | null) {
  if (!rows.length) return;
  const deletedAt = new Date();
  await SyncTombstone.bulkCreate(
    rows.map((r) => ({ collection, recordId: r.id, userId: perUser ? (r.userId ?? null) : null, deletedAt })),
    { transaction: transaction ?? undefined },
  );
}

// perUser: the collection is private to its owner (userId column), so the
// tombstone is only sent to that user.
function track(model: ModelStatic<Model>, collection: string, perUser = false) {
  model.addHook("afterDestroy", async (instance: Model, options: DestroyOptions) => {
    const row = instance.get() as Row;
    await writeTombstones(collection, [row], perUser, options.transaction);
  });
  // Bulk destroy only knows its WHERE clause, so capture the ids first.
  model.addHook("beforeBulkDestroy", async (options: BulkOptions) => {
    if (options.individualHooks) return; // afterDestroy will run per row
    const rows = await model.findAll({
      where: options.where,
      attributes: perUser ? ["id", "userId"] : ["id"],
      transaction: options.transaction ?? undefined,
    });
    options.syncDoomed = rows.map((r) => r.get() as Row);
  });
  model.addHook("afterBulkDestroy", async (options: BulkOptions) => {
    if (options.syncDoomed) await writeTombstones(collection, options.syncDoomed, perUser, options.transaction);
  });
}

let registered = false;
export function registerTombstoneHooks(): void {
  if (registered) return;
  registered = true;
  track(Task, "tasks");
  track(Issue, "issues");
  track(Comment, "comments");
  track(Meeting, "meetings");
  track(Notification, "notifications", true);
}
