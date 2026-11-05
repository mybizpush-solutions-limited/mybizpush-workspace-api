import { randomUUID } from "node:crypto";
import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";
import { SEED_ROLES } from "../../modules/access/catalog";

// Permission engine (API-CHANGES A103): roles with permission sets, scoped
// assignments to people or groups, and per-person grant/deny overrides.
// Seeds the system roles (mirroring today's access levels) and the standard
// roles; existing heads, managers, owners and leads get theirs implicitly.
export const up: Migration = async ({ context: qi }) => {
  const scope = DataTypes.ENUM("organization", "department", "team", "product", "project");

  await ignoreDuplicate(
    qi.createTable("access_roles", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      key: { type: DataTypes.STRING(60), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(80), allowNull: false },
      description: { type: DataTypes.STRING(240), allowNull: false, defaultValue: "" },
      is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      default_scope: { ...scope, allowNull: false, defaultValue: "organization" },
      permissions: { type: DataTypes.ARRAY(DataTypes.STRING(60)), allowNull: false, defaultValue: [] },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );

  await ignoreDuplicate(
    qi.createTable("access_assignments", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      role_id: { type: DataTypes.UUID, allowNull: false, references: { model: "access_roles", key: "id" }, onDelete: "CASCADE" },
      subject_type: { type: DataTypes.ENUM("user", "department", "team"), allowNull: false },
      subject_id: { type: DataTypes.UUID, allowNull: false },
      scope_type: { type: DataTypes.ENUM("organization", "department", "team", "product", "project"), allowNull: false },
      scope_id: { type: DataTypes.UUID, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("access_assignments", ["subject_type", "subject_id"], { name: "access_assignments_subject" }));
  await ignoreDuplicate(
    qi.addIndex("access_assignments", ["role_id", "subject_type", "subject_id", "scope_type", "scope_id"], {
      name: "access_assignments_unique",
      unique: true,
    }),
  );

  await ignoreDuplicate(
    qi.createTable("access_overrides", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      permission: { type: DataTypes.STRING(60), allowNull: false },
      effect: { type: DataTypes.ENUM("grant", "deny"), allowNull: false },
      scope_type: { type: DataTypes.ENUM("organization", "department", "team", "product", "project"), allowNull: false },
      scope_id: { type: DataTypes.UUID, allowNull: true },
      reason: { type: DataTypes.STRING(240), allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("access_overrides", ["user_id"], { name: "access_overrides_user" }));
  await ignoreDuplicate(qi.addIndex("access_overrides", ["permission"], { name: "access_overrides_permission" }));

  const now = new Date();
  for (const r of SEED_ROLES) {
    await qi.sequelize.query(
      `INSERT INTO access_roles (id, key, name, description, is_system, default_scope, permissions, created_at, updated_at)
       VALUES (:id, :key, :name, :description, :system, :scope, ARRAY[:perms]::varchar[], :now, :now)
       ON CONFLICT (key) DO NOTHING`,
      { replacements: { id: randomUUID(), key: r.key, name: r.name, description: r.description, system: r.system, scope: r.defaultScope, perms: r.permissions, now } },
    );
  }
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("access_overrides");
  await qi.dropTable("access_assignments");
  await qi.dropTable("access_roles");
  for (const t of ["enum_access_roles_default_scope", "enum_access_assignments_subject_type", "enum_access_assignments_scope_type", "enum_access_overrides_effect", "enum_access_overrides_scope_type"]) {
    await qi.sequelize.query(`DROP TYPE IF EXISTS "${t}";`);
  }
};
