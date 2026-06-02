import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Repositories linked to a project (a project can span several repos).
export const up: Migration = async ({ context: qi }) => {
  const now = qi.sequelize.literal("now()");
  await qi.createTable("project_repos", {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: qi.sequelize.literal("gen_random_uuid()") },
    project_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "projects", key: "id" },
      onDelete: "CASCADE",
    },
    owner: { type: DataTypes.STRING, allowNull: false },
    repo: { type: DataTypes.STRING, allowNull: false },
    full_name: { type: DataTypes.STRING, allowNull: false },
    html_url: { type: DataTypes.STRING, allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    is_private: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    added_by: { type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
  });
  await ignoreDuplicate(qi.addIndex("project_repos", ["project_id"]));
  await ignoreDuplicate(
    qi.addIndex("project_repos", {
      fields: ["project_id", "full_name"],
      unique: true,
      name: "project_repos_project_full_name_uq",
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("project_repos");
};
