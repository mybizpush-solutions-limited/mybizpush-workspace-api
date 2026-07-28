import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// The Dev Space blog console stores NO post content — each project's own site
// API remains the source of truth. What lives here is the connection to that
// API (`blog_channels`) and who is allowed to use it (`blog_editors`).
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("blog_channels", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      project_id: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      // Which remote API dialect to speak. Only "hyparrow" exists today.
      kind: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "hyparrow" },
      api_base_url: { type: DataTypes.STRING(500), allowNull: false },
      service_token: { type: DataTypes.TEXT, allowNull: false },
      // Public site root, used to build "View on site" links.
      site_url: { type: DataTypes.STRING(500), allowNull: false, defaultValue: "" },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(
    qi.addIndex("blog_channels", ["project_id"], { name: "blog_channels_project_id" }),
  );

  await ignoreDuplicate(
    qi.createTable("blog_editors", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      project_id: { type: DataTypes.UUID, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false },
      // "editor" writes and submits; "publisher" also approves/rejects.
      role: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "editor" },
      assigned_by: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(
    qi.addIndex("blog_editors", ["project_id", "user_id"], {
      unique: true,
      name: "blog_editors_project_user",
    }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("blog_editors");
  await qi.dropTable("blog_channels");
};
