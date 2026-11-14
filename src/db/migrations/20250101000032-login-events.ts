import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Sign-in history: one row per attempt (success or failure). Powers the
// "Sessions and devices" screen and security review (API-CHANGES A002).
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("login_events", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      email: { type: DataTypes.STRING, allowNull: false },
      kind: { type: DataTypes.ENUM("login", "register", "failed"), allowNull: false },
      session_id: { type: DataTypes.STRING, allowNull: true },
      ip: { type: DataTypes.STRING, allowNull: true },
      user_agent: { type: DataTypes.STRING(400), allowNull: true },
      device: { type: DataTypes.STRING(120), allowNull: true },
      platform: { type: DataTypes.STRING(20), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("login_events", ["user_id", "created_at"], { name: "login_events_user_created" }));
  await ignoreDuplicate(qi.addIndex("login_events", ["email", "created_at"], { name: "login_events_email_created" }));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("login_events");
  await qi.sequelize.query('DROP TYPE IF EXISTS "enum_login_events_kind";');
};
