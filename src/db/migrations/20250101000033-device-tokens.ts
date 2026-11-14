import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Push notification targets: one row per device's Expo push token
// (API-CHANGES A003).
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("device_tokens", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      token: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      platform: { type: DataTypes.ENUM("ios", "android", "web"), allowNull: false },
      device_name: { type: DataTypes.STRING(120), allowNull: true },
      app_version: { type: DataTypes.STRING(40), allowNull: true },
      last_seen_at: { type: DataTypes.DATE, allowNull: false },
      disabled_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("device_tokens", ["user_id"], { name: "device_tokens_user" }));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("device_tokens");
  await qi.sequelize.query('DROP TYPE IF EXISTS "enum_device_tokens_platform";');
};
