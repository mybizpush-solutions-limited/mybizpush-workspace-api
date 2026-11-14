import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { addEnumValues, addRolePermissions, ignoreDuplicate, removeRolePermissions } from "../migration-helpers";

// Task workflow (API-CHANGES A201 to A205). Additive: every existing status and
// column keeps working, so the web app is unaffected until it opts in.
export const up: Migration = async ({ context: qi }) => {
  await addEnumValues(qi, "tasks", "status", ["draft", "assigned", "accepted", "submitted", "revision_required", "approved", "rejected", "cancelled"]);
  await addEnumValues(qi, "notifications", "kind", ["submitted", "approved", "rejected", "revision_requested", "reviewer_assigned", "blocked", "deadline"]);
  await addEnumValues(qi, "activity", "kind", ["submitted", "reviewed", "dependency_changed"]);

  const user = () => ({ type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" });
  const stamps = () => ({ created_at: { type: DataTypes.DATE, allowNull: false }, updated_at: { type: DataTypes.DATE, allowNull: false } });

  await ignoreDuplicate(
    qi.createTable("task_templates", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(120), allowNull: false },
      title: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
      description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      expected_deliverable: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      priority: { type: DataTypes.STRING(10), allowNull: true },
      product_id: { type: DataTypes.UUID, allowNull: true, references: { model: "products", key: "id" }, onDelete: "CASCADE" },
      project_id: { type: DataTypes.UUID, allowNull: true, references: { model: "projects", key: "id" }, onDelete: "CASCADE" },
      department_id: { type: DataTypes.UUID, allowNull: true, references: { model: "departments", key: "id" }, onDelete: "SET NULL" },
      reviewer_id: user(),
      default_due_days: { type: DataTypes.INTEGER, allowNull: true },
      checklist: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      label_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      created_by: user(),
      archived_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("task_templates", ["updated_at"], { name: "task_templates_updated_at" }));

  const columns = await qi.describeTable("tasks");
  const add = async (name: string, spec: Parameters<typeof qi.addColumn>[2]) => {
    if (!columns[name]) await qi.addColumn("tasks", name, spec);
  };
  await add("reviewer_id", user());
  await add("product_id", { type: DataTypes.UUID, allowNull: true, references: { model: "products", key: "id" }, onDelete: "SET NULL" });
  await add("team_id", { type: DataTypes.UUID, allowNull: true, references: { model: "teams", key: "id" }, onDelete: "SET NULL" });
  await add("start_date", { type: DataTypes.DATE, allowNull: true });
  await add("expected_deliverable", { type: DataTypes.TEXT, allowNull: false, defaultValue: "" });
  await add("template_id", { type: DataTypes.UUID, allowNull: true, references: { model: "task_templates", key: "id" }, onDelete: "SET NULL" });
  await add("blocked_reason", { type: DataTypes.STRING(500), allowNull: true });
  await add("revision_count", { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
  await add("submitted_at", { type: DataTypes.DATE, allowNull: true });
  await add("reviewed_at", { type: DataTypes.DATE, allowNull: true });
  await add("completed_at", { type: DataTypes.DATE, allowNull: true });
  await add("source_type", { type: DataTypes.STRING(30), allowNull: true });
  await add("source_id", { type: DataTypes.STRING(80), allowNull: true });

  // Existing rows: inherit the product from the project, and treat a done task
  // as completed when it was last touched.
  await qi.sequelize.query(`UPDATE tasks t SET product_id = p.product_id FROM projects p WHERE t.project_id = p.id AND t.product_id IS NULL AND p.product_id IS NOT NULL`);
  await qi.sequelize.query(`UPDATE tasks SET completed_at = updated_at WHERE status = 'done' AND completed_at IS NULL`);

  for (const [name, cols] of [
    ["tasks_reviewer_id", ["reviewer_id"]],
    ["tasks_product_id", ["product_id"]],
    ["tasks_team_id", ["team_id"]],
    ["tasks_status_due", ["status", "due_date"]],
  ] as const) {
    await ignoreDuplicate(qi.addIndex("tasks", [...cols], { name }));
  }

  await ignoreDuplicate(
    qi.createTable("task_dependencies", {
      task_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "tasks", key: "id" }, onDelete: "CASCADE" },
      depends_on_id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: "tasks", key: "id" }, onDelete: "CASCADE" },
    }),
  );
  await ignoreDuplicate(qi.addIndex("task_dependencies", ["depends_on_id"], { name: "task_dependencies_depends_on" }));

  await ignoreDuplicate(
    qi.createTable("task_group_assignments", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      task_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tasks", key: "id" }, onDelete: "CASCADE" },
      group_type: { type: DataTypes.STRING(12), allowNull: false },
      group_id: { type: DataTypes.UUID, allowNull: false },
      user_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      created_by: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("task_group_assignments", ["task_id"], { name: "task_group_assignments_task" }));

  await ignoreDuplicate(
    qi.createTable("task_submissions", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      task_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tasks", key: "id" }, onDelete: "CASCADE" },
      round: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      submitted_by: user(),
      reviewer_id: user(),
      notes: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      links: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      evidence: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      attachment_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("task_submissions", ["task_id", "created_at"], { name: "task_submissions_task" }));
  await ignoreDuplicate(qi.addIndex("task_submissions", ["updated_at"], { name: "task_submissions_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("task_reviews", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      task_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tasks", key: "id" }, onDelete: "CASCADE" },
      submission_id: { type: DataTypes.UUID, allowNull: true, references: { model: "task_submissions", key: "id" }, onDelete: "SET NULL" },
      reviewer_id: user(),
      decision: { type: DataTypes.STRING(20), allowNull: false },
      feedback: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      new_reviewer_id: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("task_reviews", ["task_id", "created_at"], { name: "task_reviews_task" }));
  await ignoreDuplicate(qi.addIndex("task_reviews", ["updated_at"], { name: "task_reviews_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("task_status_history", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      task_id: { type: DataTypes.UUID, allowNull: false, references: { model: "tasks", key: "id" }, onDelete: "CASCADE" },
      from_status: { type: DataTypes.STRING(20), allowNull: true },
      to_status: { type: DataTypes.STRING(20), allowNull: false },
      actor_id: user(),
      note: { type: DataTypes.TEXT, allowNull: true },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("task_status_history", ["task_id", "created_at"], { name: "task_status_history_task" }));
  await ignoreDuplicate(qi.addIndex("task_status_history", ["updated_at"], { name: "task_status_history_updated_at" }));

  // task.manage_templates is new. report.view moves off the org-wide default
  // roles: holding it at organization scope would show every person the whole
  // company's reports (SCREENS 7.5). People still always see their own work.
  await addRolePermissions(qi, {
    chief: ["task.manage_templates"],
    product_manager: ["task.manage_templates", "report.view"],
    project_manager: ["report.view"],
    department_head: ["task.manage_templates", "report.view"],
    team_lead: ["report.view"],
  });
  await removeRolePermissions(qi, { member: ["report.view"], admin: ["report.view"], contributor: ["report.view"] });
};

export const down: Migration = async ({ context: qi }) => {
  await addRolePermissions(qi, { member: ["report.view"], admin: ["report.view"], contributor: ["report.view"] });
  for (const t of ["task_status_history", "task_reviews", "task_submissions", "task_group_assignments", "task_dependencies"]) {
    await qi.dropTable(t);
  }
  for (const c of ["source_id", "source_type", "completed_at", "reviewed_at", "submitted_at", "revision_count", "blocked_reason", "template_id", "expected_deliverable", "start_date", "team_id", "product_id", "reviewer_id"]) {
    await qi.removeColumn("tasks", c).catch(() => undefined);
  }
  await qi.dropTable("task_templates");
};
