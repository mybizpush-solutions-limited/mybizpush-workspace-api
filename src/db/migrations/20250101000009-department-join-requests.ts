import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Request → approve/reject flow for joining a department after onboarding.
export const up: Migration = async ({ context: qi }) => {
  const now = qi.sequelize.literal("now()");
  await ignoreDuplicate(
    qi.createTable("department_join_requests", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      department_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: "departments", key: "id" },
        onDelete: "CASCADE",
      },
      status: { type: DataTypes.ENUM("pending", "approved", "rejected"), allowNull: false, defaultValue: "pending" },
      decided_by: { type: DataTypes.UUID, allowNull: true },
      decided_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: now },
    }),
  );
  await ignoreDuplicate(qi.addIndex("department_join_requests", ["department_id", "status"]));
  await ignoreDuplicate(qi.addIndex("department_join_requests", ["user_id"]));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("department_join_requests");
};
