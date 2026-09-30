import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// GitHub commits synced from every repo linked to a project, with authors
// matched to workspace users where possible. Engineers often work through
// commits without logging workspace tasks; this table is the workspace's
// record of that work, feeding the project commit feed and the staff reports.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("project_commits", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      project_id: { type: DataTypes.UUID, allowNull: false },
      repo_full_name: { type: DataTypes.STRING(300), allowNull: false },
      sha: { type: DataTypes.STRING(40), allowNull: false },
      // First line of the commit message.
      message: { type: DataTypes.STRING(500), allowNull: false, defaultValue: "" },
      // Remaining message lines (the commit description).
      body: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      url: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      author_name: { type: DataTypes.STRING(200), allowNull: false, defaultValue: "" },
      author_login: { type: DataTypes.STRING(200), allowNull: false, defaultValue: "" },
      author_email: { type: DataTypes.STRING(320), allowNull: false, defaultValue: "" },
      // Matched workspace user (via linked GitHub account, git email or exact
      // author name); null when nobody matches.
      author_user_id: { type: DataTypes.UUID, allowNull: true },
      committed_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("project_commits", ["repo_full_name", "sha"], { unique: true }));
  await ignoreDuplicate(qi.addIndex("project_commits", ["project_id", "committed_at"]));
  await ignoreDuplicate(qi.addIndex("project_commits", ["author_user_id", "committed_at"]));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("project_commits");
};