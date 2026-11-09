import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { addRolePermissions, ignoreDuplicate, removeRolePermissions } from "../migration-helpers";

// Records visible only to who they concern, private files, and a sending identity
// per product (API-CHANGES A1001 to A1006).
export const up: Migration = async ({ context: qi }) => {
  // Held organization wide, task.view would open everything to everyone.
  await removeRolePermissions(qi, { member: ["task.view"], admin: ["task.view"], hr_officer: ["task.view"] });

  // What each person could last see, so a change reaches all their devices.
  await ignoreDuplicate(
    qi.createTable("sync_record_access", {
      user_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      collection: { type: DataTypes.STRING(40), allowNull: false, primaryKey: true },
      record_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
      granted: { type: DataTypes.BOOLEAN, allowNull: false },
      changed_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("sync_record_access", ["user_id", "collection", "changed_at"], { name: "sync_record_access_changes" }));

  // Files. Older rows stay as they are ("upload", public) until they're moved.
  const att = await qi.describeTable("attachments");
  if (!att.delivery) await qi.addColumn("attachments", "delivery", { type: DataTypes.STRING(14), allowNull: false, defaultValue: "upload" });
  if (!att.resource_type) await qi.addColumn("attachments", "resource_type", { type: DataTypes.STRING(8), allowNull: true });
  if (!att.format) await qi.addColumn("attachments", "format", { type: DataTypes.STRING(20), allowNull: true });
  await ignoreDuplicate(qi.addIndex("attachments", ["item_id"], { name: "attachments_item" }));

  const products = await qi.describeTable("products");
  if (!products.sender_name) await qi.addColumn("products", "sender_name", { type: DataTypes.STRING(120), allowNull: true });
  if (!products.sender_email) await qi.addColumn("products", "sender_email", { type: DataTypes.STRING(254), allowNull: true });
  // The only address the owner has given. Others stay empty and use the default.
  await qi.sequelize.query(`UPDATE products SET sender_email = 'info@mybizpush.com', sender_name = 'MyBizPush' WHERE lower(name) = 'mybizpush' AND sender_email IS NULL`);

  const org = await qi.describeTable("organization_settings");
  // Empty means the configured default (ORG_SENDER_EMAIL, ORG_SENDER_NAME).
  if (!org.sender_name) await qi.addColumn("organization_settings", "sender_name", { type: DataTypes.STRING(120), allowNull: true });
  if (!org.sender_email) await qi.addColumn("organization_settings", "sender_email", { type: DataTypes.STRING(254), allowNull: true });
};

export const down: Migration = async ({ context: qi }) => {
  for (const c of ["sender_email", "sender_name"]) await qi.removeColumn("organization_settings", c).catch(() => undefined);
  for (const c of ["sender_email", "sender_name"]) await qi.removeColumn("products", c).catch(() => undefined);
  for (const c of ["format", "resource_type", "delivery"]) await qi.removeColumn("attachments", c).catch(() => undefined);
  await qi.dropTable("sync_record_access");
  await addRolePermissions(qi, { member: ["task.view"], admin: ["task.view"], hr_officer: ["task.view"] });
};
