import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Staff administration (API-CHANGES A106, PRD 3.2, 11.3): profile fields,
// account status (suspension blocks sign-in), and invitations.
export const up: Migration = async ({ context: qi }) => {
  const cols = await qi.describeTable("users");
  const add = async (name: string, spec: Parameters<typeof qi.addColumn>[2]) => {
    if (!cols[name]) await qi.addColumn("users", name, spec);
  };
  await add("phone", { type: DataTypes.STRING(32), allowNull: true });
  await add("employee_id", { type: DataTypes.STRING(40), allowNull: true, unique: true });
  await add("employment_status", {
    type: DataTypes.ENUM("active", "on_leave", "contract", "probation"),
    allowNull: false,
    defaultValue: "active",
  });
  await add("status", { type: DataTypes.ENUM("active", "suspended"), allowNull: false, defaultValue: "active" });
  await add("suspended_at", { type: DataTypes.DATE, allowNull: true });
  await add("suspended_reason", { type: DataTypes.STRING(240), allowNull: true });
  await add("date_joined", { type: DataTypes.DATEONLY, allowNull: true });
  await add("reports_to_id", { type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" });

  await ignoreDuplicate(
    qi.createTable("invitations", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      email: { type: DataTypes.STRING, allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: true },
      token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      invited_by: { type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" },
      // What the person gets on accepting (any may be empty).
      department_id: { type: DataTypes.UUID, allowNull: true },
      team_id: { type: DataTypes.UUID, allowNull: true },
      product_id: { type: DataTypes.UUID, allowNull: true },
      product_title: { type: DataTypes.STRING(80), allowNull: true },
      role_id: { type: DataTypes.UUID, allowNull: true },
      job_titles: { type: DataTypes.ARRAY(DataTypes.STRING(40)), allowNull: false, defaultValue: [] },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "manual" }, // manual | import
      expires_at: { type: DataTypes.DATE, allowNull: false },
      accepted_at: { type: DataTypes.DATE, allowNull: true },
      accepted_user_id: { type: DataTypes.UUID, allowNull: true },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("invitations", ["email"], { name: "invitations_email" }));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("invitations");
  for (const c of ["reports_to_id", "date_joined", "suspended_reason", "suspended_at", "status", "employment_status", "employee_id", "phone"]) {
    await qi.removeColumn("users", c).catch(() => undefined);
  }
  await qi.sequelize.query('DROP TYPE IF EXISTS "enum_users_employment_status";');
  await qi.sequelize.query('DROP TYPE IF EXISTS "enum_users_status";');
};
