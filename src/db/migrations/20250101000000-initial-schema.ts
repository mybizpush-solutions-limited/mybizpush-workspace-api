import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";

// Initial schema. Column names are snake_case to match the models' underscored
// mapping. Enum types are created with the same names Sequelize models expect.
export const up: Migration = async ({ context: qi }) => {
  const now = qi.sequelize.literal("now()");
  const uuid = () => ({
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: qi.sequelize.literal("gen_random_uuid()"),
  });
  const created = { type: DataTypes.DATE, allowNull: false, defaultValue: now };
  const userRef = (allowNull = true, onDelete = "SET NULL") => ({
    type: DataTypes.UUID,
    allowNull,
    references: { model: "users", key: "id" },
    onDelete,
  });

  await qi.sequelize.query('create extension if not exists "pgcrypto";');

  await qi.createTable("users", {
    id: uuid(),
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    password_hash: { type: DataTypes.STRING, allowNull: false },
    avatar_color: { type: DataTypes.STRING, allowNull: false, defaultValue: "#960095" },
    access_level: { type: DataTypes.ENUM("member", "admin", "executive_admin"), allowNull: false, defaultValue: "member" },
    roles: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    created_at: created,
    updated_at: created,
  });

  await qi.createTable("departments", {
    id: uuid(),
    slug: { type: DataTypes.STRING, allowNull: false, unique: true },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    head_id: userRef(),
    created_at: created,
    updated_at: created,
  });

  await qi.createTable("projects", {
    id: uuid(),
    department_id: { type: DataTypes.UUID, allowNull: false, references: { model: "departments", key: "id" }, onDelete: "CASCADE" },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    manager_id: userRef(),
    progress: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_at: created,
    updated_at: created,
  });

  await qi.createTable("labels", {
    id: uuid(),
    name: { type: DataTypes.STRING, allowNull: false },
    color: { type: DataTypes.STRING, allowNull: false },
  });

  const workItemColumns = () => ({
    project_id: { type: DataTypes.UUID, allowNull: false, references: { model: "projects", key: "id" }, onDelete: "CASCADE" },
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    status: { type: DataTypes.ENUM("todo", "in_progress", "in_review", "blocked", "done"), allowNull: false, defaultValue: "todo" },
    priority: { type: DataTypes.ENUM("low", "medium", "high", "urgent"), allowNull: false, defaultValue: "medium" },
    reporter_id: userRef(),
    due_date: { type: DataTypes.DATE, allowNull: true },
    feedback_awaiting_from: userRef(),
    feedback_requested_by: userRef(),
    feedback_requested_at: { type: DataTypes.DATE, allowNull: true },
    created_at: created,
    updated_at: created,
  });

  await qi.createTable("tasks", { id: uuid(), ...workItemColumns() });
  await qi.createTable("issues", {
    id: uuid(),
    ...workItemColumns(),
    severity: { type: DataTypes.ENUM("minor", "major", "critical"), allowNull: true },
  });

  await qi.createTable("comments", {
    id: uuid(),
    item_id: { type: DataTypes.UUID, allowNull: false },
    item_type: { type: DataTypes.ENUM("task", "issue"), allowNull: false },
    author_id: userRef(),
    body: { type: DataTypes.TEXT, allowNull: false },
    created_at: created,
  });

  await qi.createTable("activity", {
    id: uuid(),
    item_id: { type: DataTypes.UUID, allowNull: false },
    item_type: { type: DataTypes.ENUM("task", "issue"), allowNull: false },
    actor_id: userRef(),
    kind: { type: DataTypes.ENUM("created", "status_changed", "assigned", "commented", "feedback_requested", "feedback_provided", "pr_linked"), allowNull: false },
    data: { type: DataTypes.JSONB, allowNull: true },
    created_at: created,
  });

  await qi.createTable("pull_requests", {
    id: uuid(),
    item_id: { type: DataTypes.UUID, allowNull: false },
    item_type: { type: DataTypes.ENUM("task", "issue"), allowNull: false },
    number: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    url: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.ENUM("open", "merged", "closed", "draft"), allowNull: false, defaultValue: "open" },
    author_id: userRef(),
  });

  await qi.createTable("attachments", {
    id: uuid(),
    item_id: { type: DataTypes.UUID, allowNull: false },
    item_type: { type: DataTypes.ENUM("task", "issue"), allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    size: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    type: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
    url: { type: DataTypes.STRING, allowNull: false },
    created_at: created,
  });

  await qi.createTable("notifications", {
    id: uuid(),
    user_id: { type: DataTypes.UUID, allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
    kind: { type: DataTypes.ENUM("assigned", "mentioned", "feedback_requested", "status_changed", "commented"), allowNull: false },
    item_id: { type: DataTypes.UUID, allowNull: false },
    item_type: { type: DataTypes.ENUM("task", "issue"), allowNull: false },
    from_user_id: userRef(),
    message: { type: DataTypes.TEXT, allowNull: false },
    read: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: created,
  });

  await qi.createTable("meetings", {
    id: uuid(),
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    organizer_id: userRef(),
    starts_at: { type: DataTypes.DATE, allowNull: false },
    ends_at: { type: DataTypes.DATE, allowNull: false },
    meet_url: { type: DataTypes.STRING, allowNull: false },
    created_at: created,
  });

  await qi.createTable("notification_preferences", {
    user_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
    meeting_reminders: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    pending_tasks: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    feedback_requests: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    mentions: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    events: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    digest_frequency: { type: DataTypes.ENUM("off", "daily", "weekly"), allowNull: false, defaultValue: "daily" },
  });

  // ---- Join tables (composite PKs) ----
  await qi.createTable("department_members", {
    department_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "departments", key: "id" }, onDelete: "CASCADE" },
    user_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
  });
  await qi.createTable("project_members", {
    project_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "projects", key: "id" }, onDelete: "CASCADE" },
    user_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
  });
  await qi.createTable("task_assignees", {
    task_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "tasks", key: "id" }, onDelete: "CASCADE" },
    user_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
  });
  await qi.createTable("task_labels", {
    task_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "tasks", key: "id" }, onDelete: "CASCADE" },
    label_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "labels", key: "id" }, onDelete: "CASCADE" },
  });
  await qi.createTable("issue_assignees", {
    issue_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "issues", key: "id" }, onDelete: "CASCADE" },
    user_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
  });
  await qi.createTable("issue_labels", {
    issue_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "issues", key: "id" }, onDelete: "CASCADE" },
    label_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "labels", key: "id" }, onDelete: "CASCADE" },
  });
  await qi.createTable("comment_mentions", {
    comment_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "comments", key: "id" }, onDelete: "CASCADE" },
    user_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
  });
  await qi.createTable("meeting_attendees", {
    meeting_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "meetings", key: "id" }, onDelete: "CASCADE" },
    user_id: { type: DataTypes.UUID, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE" },
  });

  // ---- Indexes ----
  await qi.addIndex("projects", ["department_id"]);
  await qi.addIndex("tasks", ["project_id"]);
  await qi.addIndex("tasks", ["status"]);
  await qi.addIndex("issues", ["project_id"]);
  await qi.addIndex("issues", ["status"]);
  await qi.addIndex("comments", ["item_id"]);
  await qi.addIndex("activity", ["item_id"]);
  await qi.addIndex("activity", ["created_at"]);
  await qi.addIndex("notifications", ["user_id", "read"]);
};

export const down: Migration = async ({ context: qi }) => {
  const tables = [
    "meeting_attendees", "comment_mentions", "issue_labels", "issue_assignees",
    "task_labels", "task_assignees", "project_members", "department_members",
    "notification_preferences", "meetings", "notifications", "attachments",
    "pull_requests", "activity", "comments", "issues", "tasks", "labels",
    "projects", "departments", "users",
  ];
  for (const t of tables) await qi.dropTable(t, { cascade: true });
};
