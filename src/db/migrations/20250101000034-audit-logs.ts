import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { ignoreDuplicate } from "../migration-helpers";

// Audit trail for administrative and permission changes (API-CHANGES A007,
// PRD 4.7 and 24): who did what, to what, in which scope, before and after.
export const up: Migration = async ({ context: qi }) => {
  await ignoreDuplicate(
    qi.createTable("audit_logs", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      // Null for system actions (jobs, migrations). Kept when the actor is
      // deleted so history survives.
      actor_id: { type: DataTypes.UUID, allowNull: true },
      action: { type: DataTypes.STRING(80), allowNull: false },
      target_type: { type: DataTypes.STRING(40), allowNull: false },
      target_id: { type: DataTypes.STRING(80), allowNull: true },
      scope_type: { type: DataTypes.STRING(20), allowNull: true },
      scope_id: { type: DataTypes.STRING(80), allowNull: true },
      before: { type: DataTypes.JSONB, allowNull: true },
      after: { type: DataTypes.JSONB, allowNull: true },
      ip: { type: DataTypes.STRING, allowNull: true },
      user_agent: { type: DataTypes.STRING(400), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("audit_logs", ["created_at"], { name: "audit_logs_created" }));
  await ignoreDuplicate(qi.addIndex("audit_logs", ["target_type", "target_id", "created_at"], { name: "audit_logs_target" }));
  await ignoreDuplicate(qi.addIndex("audit_logs", ["actor_id", "created_at"], { name: "audit_logs_actor" }));
  await ignoreDuplicate(qi.addIndex("audit_logs", ["action", "created_at"], { name: "audit_logs_action" }));
};

export const down: Migration = async ({ context: qi }) => {
  await qi.dropTable("audit_logs");
};
