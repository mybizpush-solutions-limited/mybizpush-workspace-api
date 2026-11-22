import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { addRolePermissions, ignoreDuplicate, removeRolePermissions } from "../migration-helpers";

// Remote/onsite staff and office attendance by QR code.
export const up: Migration = async ({ context: qi }) => {
  const users = await qi.describeTable("users");
  if (!users.work_mode) {
    await qi.addColumn("users", "work_mode", { type: DataTypes.ENUM("onsite", "remote", "hybrid"), allowNull: false, defaultValue: "onsite" });
  }

  await ignoreDuplicate(
    qi.createTable("offices", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(120), allowNull: false },
      address: { type: DataTypes.STRING(300), allowNull: true },
      late_after: { type: DataTypes.STRING(5), allowNull: false, defaultValue: "09:15" },
      code_secret: { type: DataTypes.STRING(64), allowNull: false },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: { type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );

  await ignoreDuplicate(
    qi.createTable("attendance_records", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      office_id: { type: DataTypes.UUID, allowNull: false, references: { model: "offices", key: "id" }, onDelete: "CASCADE" },
      day: { type: DataTypes.DATEONLY, allowNull: false },
      check_in_at: { type: DataTypes.DATE, allowNull: false },
      check_out_at: { type: DataTypes.DATE, allowNull: true },
      status: { type: DataTypes.ENUM("present", "late"), allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("attendance_records", ["user_id", "day"], { unique: true, name: "attendance_records_user_day" }));
  await ignoreDuplicate(qi.addIndex("attendance_records", ["day"], { name: "attendance_records_day" }));

  await addRolePermissions(qi, { chief: ["attendance.view", "attendance.manage"], hr_officer: ["attendance.view", "attendance.manage"] });
};

export const down: Migration = async ({ context: qi }) => {
  await removeRolePermissions(qi, { chief: ["attendance.view", "attendance.manage"], hr_officer: ["attendance.view", "attendance.manage"] });
  await qi.dropTable("attendance_records");
  await qi.dropTable("offices");
  await qi.removeColumn("users", "work_mode").catch(() => undefined);
  await qi.sequelize.query('DROP TYPE IF EXISTS "enum_attendance_records_status";');
  await qi.sequelize.query('DROP TYPE IF EXISTS "enum_users_work_mode";');
};
