import { DataTypes, QueryTypes } from "sequelize";
import type { Migration } from "../umzug";
import { addRolePermissions, ignoreDuplicate, removeRolePermissions } from "../migration-helpers";

const APPROVERS = { chief: ["staff.approve_changes"], admin: ["staff.approve_changes"], hr_officer: ["staff.approve_changes"] };

// Staff profile edits wait for approval; approvers can also change a person's sign-in email.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("profile_change_requests", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      changes: { type: DataTypes.JSONB, allowNull: false },
      status: { type: DataTypes.ENUM("pending", "approved", "rejected", "cancelled"), allowNull: false, defaultValue: "pending" },
      reviewer_id: { type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" },
      reviewed_at: { type: DataTypes.DATE, allowNull: true },
      review_note: { type: DataTypes.STRING(500), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("profile_change_requests", ["status", "created_at"], { name: "profile_change_requests_status" }));
  await ignoreDuplicate(qi.addIndex("profile_change_requests", ["user_id", "status"], { name: "profile_change_requests_user" }));
  await addRolePermissions(qi, APPROVERS);

  const [row] = await qi.sequelize.query<{ typname: string }>(
    `SELECT t.typname FROM pg_attribute a
       JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_type t ON a.atttypid = t.oid
      WHERE c.relname = 'notifications' AND a.attname = 'item_type' AND a.attnum > 0`,
    { type: QueryTypes.SELECT },
  );
  if (row) await qi.sequelize.query(`ALTER TYPE "${row.typname}" ADD VALUE IF NOT EXISTS 'profile_change'`);
};

export const down: Migration = async ({ context: qi }) => {
  await removeRolePermissions(qi, APPROVERS);
  await qi.dropTable("profile_change_requests");
  await qi.sequelize.query('DROP TYPE IF EXISTS "enum_profile_change_requests_status"');
};
