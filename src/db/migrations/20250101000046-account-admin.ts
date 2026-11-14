import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Two-step sign-in and organization settings (API-CHANGES A902, A903). The two-step
// columns and table use the same names as the MFA work on main, so people's
// enrolments stay valid when those lines of work meet. Adding them is safe either
// way: each step tolerates the column or table already being there.
export const up: Migration = async ({ context: qi }) => {
  const add = (column: string, spec: Parameters<typeof qi.addColumn>[2]) => ignoreDuplicate(qi.addColumn("users", column, spec));
  await add("totp_secret_encrypted", { type: DataTypes.TEXT, allowNull: true });
  await add("totp_enabled", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await add("totp_confirmed_at", { type: DataTypes.DATE, allowNull: true });
  await add("totp_last_step", { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 });

  // Used codes are kept, so there's a record of when one got someone in.
  await ignoreDuplicate(
    qi.createTable("mfa_recovery_codes", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      code_hash: { type: DataTypes.STRING, allowNull: false },
      used_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("mfa_recovery_codes", ["user_id"], { name: "mfa_recovery_codes_user" }));

  // One row, always id 1.
  await ignoreDuplicate(
    qi.createTable("organization_settings", {
      id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
      name: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "MyBizPush" },
      logo_url: { type: DataTypes.STRING, allowNull: true },
      timezone: { type: DataTypes.STRING(60), allowNull: false, defaultValue: "Africa/Lagos" },
      working_days: { type: DataTypes.ARRAY(DataTypes.INTEGER), allowNull: false, defaultValue: [1, 2, 3, 4, 5] },
      updated_by: { type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await qi.sequelize.query(`INSERT INTO organization_settings (id, created_at, updated_at) VALUES (1, now(), now()) ON CONFLICT (id) DO NOTHING`);
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("organization_settings");
  await qi.dropTable("mfa_recovery_codes");
  for (const c of ["totp_last_step", "totp_confirmed_at", "totp_enabled", "totp_secret_encrypted"]) {
    await qi.removeColumn("users", c).catch(() => undefined);
  }
};
