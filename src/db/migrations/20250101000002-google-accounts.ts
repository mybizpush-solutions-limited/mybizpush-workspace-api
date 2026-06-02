import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Per-user Google OAuth tokens + a link from meetings to their Calendar event.
export const up: Migration = async ({ context: qi }) => {
  const now = qi.sequelize.literal("now()");
  await qi.createTable("google_accounts", {
    user_id: {
      type: DataTypes.UUID,
      primaryKey: true,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },
    email: { type: DataTypes.STRING, allowNull: true },
    access_token: { type: DataTypes.TEXT, allowNull: true },
    refresh_token: { type: DataTypes.TEXT, allowNull: true },
    scope: { type: DataTypes.TEXT, allowNull: true },
    token_type: { type: DataTypes.STRING, allowNull: true },
    expiry_date: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
  });

  await ignoreDuplicate(
    qi.addColumn("meetings", "google_event_id", { type: DataTypes.STRING, allowNull: true }),
  );
};

export const down: Migration = async ({ context: qi }) => {
  await qi.removeColumn("meetings", "google_event_id");
  await qi.dropTable("google_accounts");
};
