import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { addEnumValues, ignoreDuplicate } from "../migration-helpers";

// Staff queries, targets, appraisals and report exports (A501 to A504).
export const up: Migration = async ({ context: qi }) => {
  for (const table of ["comments", "attachments", "activity", "notifications"]) {
    await addEnumValues(qi, table, "item_type", ["appraisal"]);
  }
  const stamps = () => ({ created_at: { type: DataTypes.DATE, allowNull: false }, updated_at: { type: DataTypes.DATE, allowNull: false } });
  const user = () => ({ type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" });
  const owner = () => ({ type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE" });

  await ignoreDuplicate(
    qi.createTable("staff_queries", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      seq: { type: DataTypes.INTEGER, autoIncrement: true, allowNull: false },
      staff_id: owner(),
      issued_by: user(),
      category: { type: DataTypes.STRING(14), allowNull: false },
      subject: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
      deadline_at: { type: DataTypes.DATE, allowNull: false },
      status: { type: DataTypes.STRING(14), allowNull: false, defaultValue: "issued" },
      response: { type: DataTypes.TEXT, allowNull: true },
      responded_at: { type: DataTypes.DATE, allowNull: true },
      attachment_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      decision: { type: DataTypes.STRING(14), allowNull: true },
      decision_note: { type: DataTypes.TEXT, allowNull: true },
      reviewed_by: user(),
      reviewed_at: { type: DataTypes.DATE, allowNull: true },
      resolved_by: user(),
      resolved_at: { type: DataTypes.DATE, allowNull: true },
      reminder_sent_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("staff_queries", ["staff_id", "status"], { name: "staff_queries_staff" }));
  await ignoreDuplicate(qi.addIndex("staff_queries", ["issued_by"], { name: "staff_queries_issuer" }));
  await ignoreDuplicate(qi.addIndex("staff_queries", ["updated_at"], { name: "staff_queries_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("staff_query_events", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      query_id: { type: DataTypes.UUID, allowNull: false, references: { model: "staff_queries", key: "id" }, onDelete: "CASCADE" },
      kind: { type: DataTypes.STRING(14), allowNull: false },
      actor_id: user(),
      note: { type: DataTypes.TEXT, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
    }),
  );
  await ignoreDuplicate(qi.addIndex("staff_query_events", ["query_id"], { name: "staff_query_events_query" }));

  await ignoreDuplicate(
    qi.createTable("targets", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(200), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      owner_type: { type: DataTypes.STRING(12), allowNull: false },
      owner_id: { type: DataTypes.UUID, allowNull: false },
      period: { type: DataTypes.STRING(8), allowNull: false },
      start_date: { type: DataTypes.DATEONLY, allowNull: false },
      end_date: { type: DataTypes.DATEONLY, allowNull: false },
      unit: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "count" },
      unit_label: { type: DataTypes.STRING(40), allowNull: true },
      start_value: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
      target_value: { type: DataTypes.DOUBLE, allowNull: false },
      current_value: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
      source: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "manual" },
      source_config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      reviewer_id: user(),
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "active" },
      evaluation: { type: DataTypes.JSONB, allowNull: true },
      created_by: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("targets", ["owner_type", "owner_id"], { name: "targets_owner" }));
  await ignoreDuplicate(qi.addIndex("targets", ["status", "end_date"], { name: "targets_status_end" }));
  await ignoreDuplicate(qi.addIndex("targets", ["updated_at"], { name: "targets_updated_at" }));

  const targetRef = { type: DataTypes.UUID, allowNull: false, references: { model: "targets", key: "id" }, onDelete: "CASCADE" };
  await ignoreDuplicate(
    qi.createTable("target_assignments", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      target_id: targetRef,
      user_id: owner(),
      target_value: { type: DataTypes.DOUBLE, allowNull: false },
      current_value: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("target_assignments", ["target_id", "user_id"], { name: "target_assignments_unique", unique: true }));
  await ignoreDuplicate(qi.addIndex("target_assignments", ["user_id"], { name: "target_assignments_user" }));

  await ignoreDuplicate(
    qi.createTable("target_progress", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      target_id: targetRef,
      assignment_id: { type: DataTypes.UUID, allowNull: true, references: { model: "target_assignments", key: "id" }, onDelete: "SET NULL" },
      value: { type: DataTypes.DOUBLE, allowNull: false },
      delta: { type: DataTypes.DOUBLE, allowNull: false },
      source: { type: DataTypes.STRING(12), allowNull: false },
      note: { type: DataTypes.TEXT, allowNull: true },
      evidence: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      recorded_by: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("target_progress", ["target_id", "created_at"], { name: "target_progress_target" }));
  await ignoreDuplicate(qi.addIndex("target_progress", ["updated_at"], { name: "target_progress_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("appraisal_cycles", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(120), allowNull: false },
      start_date: { type: DataTypes.DATEONLY, allowNull: false },
      end_date: { type: DataTypes.DATEONLY, allowNull: false },
      self_due_at: { type: DataTypes.DATE, allowNull: true },
      manager_due_at: { type: DataTypes.DATE, allowNull: true },
      status: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "draft" },
      areas: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      created_by: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("appraisal_cycles", ["updated_at"], { name: "appraisal_cycles_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("appraisals", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      cycle_id: { type: DataTypes.UUID, allowNull: false, references: { model: "appraisal_cycles", key: "id" }, onDelete: "CASCADE" },
      user_id: owner(),
      manager_id: user(),
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "pending_self" },
      self_ratings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      self_comments: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      self_submitted_at: { type: DataTypes.DATE, allowNull: true },
      evidence: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      manager_ratings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      manager_feedback: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      overall_rating: { type: DataTypes.DOUBLE, allowNull: true },
      manager_submitted_at: { type: DataTypes.DATE, allowNull: true },
      stats: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("appraisals", ["cycle_id", "user_id"], { name: "appraisals_unique", unique: true }));
  await ignoreDuplicate(qi.addIndex("appraisals", ["manager_id"], { name: "appraisals_manager" }));
  await ignoreDuplicate(qi.addIndex("appraisals", ["updated_at"], { name: "appraisals_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("report_exports", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      requested_by: owner(),
      report_type: { type: DataTypes.STRING(14), allowNull: false },
      params: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      format: { type: DataTypes.STRING(4), allowNull: false },
      status: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "queued" },
      file_name: { type: DataTypes.STRING(200), allowNull: true },
      size_bytes: { type: DataTypes.INTEGER, allowNull: true },
      rows: { type: DataTypes.INTEGER, allowNull: true },
      error: { type: DataTypes.STRING(500), allowNull: true },
      file_data: { type: DataTypes.BLOB, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("report_exports", ["requested_by", "created_at"], { name: "report_exports_requester" }));
};

export const down: Migration = async ({ context: qi }) => {
  for (const t of ["report_exports", "appraisals", "appraisal_cycles", "target_progress", "target_assignments", "targets", "staff_query_events", "staff_queries"]) {
    await qi.dropTable(t);
  }
};
