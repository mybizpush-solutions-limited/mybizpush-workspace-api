import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";

// Per-user GitHub OAuth: stores the user's access token plus their resolved
// GitHub identity and whether they're a verified member of the configured org.
export const up: Migration = async ({ context: qi }) => {
  const now = qi.sequelize.literal("now()");
  await qi.createTable("github_accounts", {
    user_id: {
      type: DataTypes.UUID,
      primaryKey: true,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },
    github_id: { type: DataTypes.STRING, allowNull: true },
    login: { type: DataTypes.STRING, allowNull: true },
    name: { type: DataTypes.STRING, allowNull: true },
    avatar_url: { type: DataTypes.STRING, allowNull: true },
    access_token: { type: DataTypes.TEXT, allowNull: true },
    scope: { type: DataTypes.TEXT, allowNull: true },
    token_type: { type: DataTypes.STRING, allowNull: true },
    org_member: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
  });
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("github_accounts");
};
