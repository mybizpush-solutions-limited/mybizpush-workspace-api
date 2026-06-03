import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../db/sequelize";

// Domain enums (kept in sync with ui/src/types/index.ts).
export const ACCESS_LEVELS = ["member", "admin", "executive_admin"] as const;
export const WORK_STATUSES = ["todo", "in_progress", "in_review", "blocked", "done"] as const;
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const ITEM_TYPES = ["task", "issue"] as const;
export const ISSUE_SEVERITIES = ["minor", "major", "critical"] as const;
export const ACTIVITY_KINDS = [
  "created", "status_changed", "assigned", "commented",
  "feedback_requested", "feedback_provided", "pr_linked",
] as const;
export const NOTIFICATION_KINDS = [
  "assigned", "mentioned", "feedback_requested", "status_changed", "commented",
] as const;
export const PR_STATUSES = ["open", "merged", "closed", "draft"] as const;
export const DIGEST_FREQUENCIES = ["off", "daily", "weekly"] as const;
// Selectable team roles (kept in sync with ui/src/types/index.ts `Role`).
export const ROLES = [
  "Frontend", "Backend", "DevOps", "SMM", "Graphics Designer", "UI/UX Designer",
  "Video Editor", "CEO", "CTO", "CIO", "CSO", "CMO",
] as const;

export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type WorkStatus = (typeof WORK_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type ItemType = (typeof ITEM_TYPES)[number];

// ---- User -----------------------------------------------------------------
export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare email: string;
  declare passwordHash: string;
  declare avatarColor: CreationOptional<string>;
  declare avatarUrl: CreationOptional<string | null>;
  declare accessLevel: CreationOptional<AccessLevel>;
  declare roles: CreationOptional<string[]>;
  declare onboarded: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
User.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING, allowNull: false },
    avatarColor: { type: DataTypes.STRING, allowNull: false, defaultValue: "#960095" },
    avatarUrl: { type: DataTypes.STRING, allowNull: true },
    accessLevel: { type: DataTypes.ENUM(...ACCESS_LEVELS), allowNull: false, defaultValue: "member" },
    roles: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    onboarded: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "users" },
);

// ---- Department -----------------------------------------------------------
export class Department extends Model<InferAttributes<Department>, InferCreationAttributes<Department>> {
  declare id: CreationOptional<string>;
  declare slug: string;
  declare name: string;
  declare description: CreationOptional<string>;
  declare headId: CreationOptional<string | null>;
  declare avatarUrl: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Department.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    slug: { type: DataTypes.STRING, allowNull: false, unique: true },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    headId: { type: DataTypes.UUID, allowNull: true },
    avatarUrl: { type: DataTypes.STRING, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "departments" },
);

// ---- DepartmentJoinRequest (request → approve/reject by head/exec admin) ----
export const JOIN_REQUEST_STATUSES = ["pending", "approved", "rejected"] as const;
export class DepartmentJoinRequest extends Model<
  InferAttributes<DepartmentJoinRequest>,
  InferCreationAttributes<DepartmentJoinRequest>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare departmentId: string;
  declare status: CreationOptional<(typeof JOIN_REQUEST_STATUSES)[number]>;
  declare decidedBy: CreationOptional<string | null>;
  declare decidedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
}
DepartmentJoinRequest.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    departmentId: { type: DataTypes.UUID, allowNull: false },
    status: { type: DataTypes.ENUM(...JOIN_REQUEST_STATUSES), allowNull: false, defaultValue: "pending" },
    decidedBy: { type: DataTypes.UUID, allowNull: true },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "department_join_requests", updatedAt: false },
);

// ---- Project --------------------------------------------------------------
export class Project extends Model<InferAttributes<Project>, InferCreationAttributes<Project>> {
  declare id: CreationOptional<string>;
  declare departmentId: string;
  declare name: string;
  declare description: CreationOptional<string>;
  declare managerId: CreationOptional<string | null>;
  declare progress: CreationOptional<number>;
  declare avatarUrl: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Project.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    departmentId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    managerId: { type: DataTypes.UUID, allowNull: true },
    progress: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, validate: { min: 0, max: 100 } },
    avatarUrl: { type: DataTypes.STRING, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "projects" },
);

// ---- Label ----------------------------------------------------------------
export class Label extends Model<InferAttributes<Label>, InferCreationAttributes<Label>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare color: string;
}
Label.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    color: { type: DataTypes.STRING, allowNull: false },
  },
  { sequelize, tableName: "labels", timestamps: false },
);

// ---- Task -----------------------------------------------------------------
export class Task extends Model<InferAttributes<Task>, InferCreationAttributes<Task>> {
  declare id: CreationOptional<string>;
  declare projectId: string;
  declare title: string;
  declare description: CreationOptional<string>;
  declare status: CreationOptional<WorkStatus>;
  declare priority: CreationOptional<Priority>;
  declare reporterId: CreationOptional<string | null>;
  declare dueDate: CreationOptional<Date | null>;
  declare feedbackAwaitingFrom: CreationOptional<string | null>;
  declare feedbackRequestedBy: CreationOptional<string | null>;
  declare feedbackRequestedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Task.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    projectId: { type: DataTypes.UUID, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    status: { type: DataTypes.ENUM(...WORK_STATUSES), allowNull: false, defaultValue: "todo" },
    priority: { type: DataTypes.ENUM(...PRIORITIES), allowNull: false, defaultValue: "medium" },
    reporterId: { type: DataTypes.UUID, allowNull: true },
    dueDate: { type: DataTypes.DATE, allowNull: true },
    feedbackAwaitingFrom: { type: DataTypes.UUID, allowNull: true },
    feedbackRequestedBy: { type: DataTypes.UUID, allowNull: true },
    feedbackRequestedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "tasks" },
);

// ---- Issue ----------------------------------------------------------------
export class Issue extends Model<InferAttributes<Issue>, InferCreationAttributes<Issue>> {
  declare id: CreationOptional<string>;
  declare projectId: string;
  declare title: string;
  declare description: CreationOptional<string>;
  declare status: CreationOptional<WorkStatus>;
  declare priority: CreationOptional<Priority>;
  declare severity: CreationOptional<(typeof ISSUE_SEVERITIES)[number] | null>;
  declare reporterId: CreationOptional<string | null>;
  declare dueDate: CreationOptional<Date | null>;
  declare feedbackAwaitingFrom: CreationOptional<string | null>;
  declare feedbackRequestedBy: CreationOptional<string | null>;
  declare feedbackRequestedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Issue.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    projectId: { type: DataTypes.UUID, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    status: { type: DataTypes.ENUM(...WORK_STATUSES), allowNull: false, defaultValue: "todo" },
    priority: { type: DataTypes.ENUM(...PRIORITIES), allowNull: false, defaultValue: "medium" },
    severity: { type: DataTypes.ENUM(...ISSUE_SEVERITIES), allowNull: true },
    reporterId: { type: DataTypes.UUID, allowNull: true },
    dueDate: { type: DataTypes.DATE, allowNull: true },
    feedbackAwaitingFrom: { type: DataTypes.UUID, allowNull: true },
    feedbackRequestedBy: { type: DataTypes.UUID, allowNull: true },
    feedbackRequestedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "issues" },
);

// ---- Comment --------------------------------------------------------------
export class Comment extends Model<InferAttributes<Comment>, InferCreationAttributes<Comment>> {
  declare id: CreationOptional<string>;
  declare itemId: string;
  declare itemType: ItemType;
  declare authorId: CreationOptional<string | null>;
  declare body: string;
  // Set when this comment is mirrored to/from a GitHub issue comment — used to
  // dedupe the echo webhook and prevent app↔GitHub comment loops.
  declare githubCommentId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}
Comment.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    itemId: { type: DataTypes.UUID, allowNull: false },
    itemType: { type: DataTypes.ENUM(...ITEM_TYPES), allowNull: false },
    authorId: { type: DataTypes.UUID, allowNull: true },
    body: { type: DataTypes.TEXT, allowNull: false },
    githubCommentId: { type: DataTypes.STRING, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "comments", updatedAt: false },
);

// ---- Activity -------------------------------------------------------------
export class Activity extends Model<InferAttributes<Activity>, InferCreationAttributes<Activity>> {
  declare id: CreationOptional<string>;
  declare itemId: string;
  declare itemType: ItemType;
  declare actorId: CreationOptional<string | null>;
  declare kind: (typeof ACTIVITY_KINDS)[number];
  declare data: CreationOptional<Record<string, unknown> | null>;
  declare createdAt: CreationOptional<Date>;
}
Activity.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    itemId: { type: DataTypes.UUID, allowNull: false },
    itemType: { type: DataTypes.ENUM(...ITEM_TYPES), allowNull: false },
    actorId: { type: DataTypes.UUID, allowNull: true },
    kind: { type: DataTypes.ENUM(...ACTIVITY_KINDS), allowNull: false },
    data: { type: DataTypes.JSONB, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "activity", updatedAt: false },
);

// ---- PullRequest ----------------------------------------------------------
export class PullRequest extends Model<InferAttributes<PullRequest>, InferCreationAttributes<PullRequest>> {
  declare id: CreationOptional<string>;
  declare itemId: string;
  declare itemType: ItemType;
  declare number: number;
  declare title: string;
  declare url: string;
  declare status: CreationOptional<(typeof PR_STATUSES)[number]>;
  declare authorId: CreationOptional<string | null>;
  // Enrichment refreshed on link + via webhooks (check_run / pull_request_review).
  declare checkState: CreationOptional<string | null>;
  declare reviewDecision: CreationOptional<string | null>;
  declare headSha: CreationOptional<string | null>;
}
PullRequest.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    itemId: { type: DataTypes.UUID, allowNull: false },
    itemType: { type: DataTypes.ENUM(...ITEM_TYPES), allowNull: false },
    number: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    url: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.ENUM(...PR_STATUSES), allowNull: false, defaultValue: "open" },
    authorId: { type: DataTypes.UUID, allowNull: true },
    checkState: { type: DataTypes.STRING, allowNull: true },
    reviewDecision: { type: DataTypes.STRING, allowNull: true },
    headSha: { type: DataTypes.STRING, allowNull: true },
  },
  { sequelize, tableName: "pull_requests", timestamps: false },
);

// ---- GithubIssueLink (mirror between an app issue and a GitHub issue) ------
export class GithubIssueLink extends Model<
  InferAttributes<GithubIssueLink>,
  InferCreationAttributes<GithubIssueLink>
> {
  declare id: CreationOptional<string>;
  declare itemId: string;
  declare itemType: ItemType;
  declare owner: string;
  declare repo: string;
  declare fullName: string;
  declare number: number;
  declare url: string;
  declare state: CreationOptional<string>;
  declare createdAt: CreationOptional<Date>;
}
GithubIssueLink.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    itemId: { type: DataTypes.UUID, allowNull: false },
    itemType: { type: DataTypes.ENUM(...ITEM_TYPES), allowNull: false },
    owner: { type: DataTypes.STRING, allowNull: false },
    repo: { type: DataTypes.STRING, allowNull: false },
    fullName: { type: DataTypes.STRING, allowNull: false },
    number: { type: DataTypes.INTEGER, allowNull: false },
    url: { type: DataTypes.STRING, allowNull: false },
    state: { type: DataTypes.STRING, allowNull: false, defaultValue: "open" },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "github_issue_links", updatedAt: false },
);

// ---- Attachment -----------------------------------------------------------
export class Attachment extends Model<InferAttributes<Attachment>, InferCreationAttributes<Attachment>> {
  declare id: CreationOptional<string>;
  declare itemId: string;
  declare itemType: ItemType;
  declare name: string;
  declare size: CreationOptional<number>;
  declare type: CreationOptional<string>;
  declare url: string;
  declare publicId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}
Attachment.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    itemId: { type: DataTypes.UUID, allowNull: false },
    itemType: { type: DataTypes.ENUM(...ITEM_TYPES), allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    size: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    type: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
    url: { type: DataTypes.STRING, allowNull: false },
    publicId: { type: DataTypes.STRING, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "attachments", updatedAt: false },
);

// ---- Notification ---------------------------------------------------------
export class Notification extends Model<InferAttributes<Notification>, InferCreationAttributes<Notification>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare kind: (typeof NOTIFICATION_KINDS)[number];
  declare itemId: string;
  declare itemType: ItemType;
  declare fromUserId: CreationOptional<string | null>;
  declare message: string;
  declare read: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
}
Notification.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.ENUM(...NOTIFICATION_KINDS), allowNull: false },
    itemId: { type: DataTypes.UUID, allowNull: false },
    itemType: { type: DataTypes.ENUM(...ITEM_TYPES), allowNull: false },
    fromUserId: { type: DataTypes.UUID, allowNull: true },
    message: { type: DataTypes.TEXT, allowNull: false },
    read: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "notifications", updatedAt: false },
);

// ---- Meeting --------------------------------------------------------------
export class Meeting extends Model<InferAttributes<Meeting>, InferCreationAttributes<Meeting>> {
  declare id: CreationOptional<string>;
  declare title: string;
  declare description: CreationOptional<string | null>;
  declare organizerId: CreationOptional<string | null>;
  declare startsAt: Date;
  declare endsAt: Date;
  declare meetUrl: string;
  declare googleEventId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}
Meeting.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    organizerId: { type: DataTypes.UUID, allowNull: true },
    startsAt: { type: DataTypes.DATE, allowNull: false },
    endsAt: { type: DataTypes.DATE, allowNull: false },
    meetUrl: { type: DataTypes.STRING, allowNull: false },
    googleEventId: { type: DataTypes.STRING, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "meetings", updatedAt: false },
);

// ---- ProjectRepo (GitHub repos linked to a project) ------------------------
export class ProjectRepo extends Model<InferAttributes<ProjectRepo>, InferCreationAttributes<ProjectRepo>> {
  declare id: CreationOptional<string>;
  declare projectId: string;
  declare owner: string;
  declare repo: string;
  declare fullName: string;
  declare htmlUrl: CreationOptional<string | null>;
  declare description: CreationOptional<string | null>;
  declare isPrivate: CreationOptional<boolean>;
  declare addedBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}
ProjectRepo.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    projectId: { type: DataTypes.UUID, allowNull: false },
    owner: { type: DataTypes.STRING, allowNull: false },
    repo: { type: DataTypes.STRING, allowNull: false },
    fullName: { type: DataTypes.STRING, allowNull: false },
    htmlUrl: { type: DataTypes.STRING, allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    isPrivate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    addedBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "project_repos", updatedAt: false },
);

// ---- GoogleAccount (per-user OAuth tokens) ---------------------------------
export class GoogleAccount extends Model<
  InferAttributes<GoogleAccount>,
  InferCreationAttributes<GoogleAccount>
> {
  declare userId: string;
  declare email: CreationOptional<string | null>;
  declare accessToken: CreationOptional<string | null>;
  declare refreshToken: CreationOptional<string | null>;
  declare scope: CreationOptional<string | null>;
  declare tokenType: CreationOptional<string | null>;
  declare expiryDate: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
GoogleAccount.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true },
    email: { type: DataTypes.STRING, allowNull: true },
    accessToken: { type: DataTypes.TEXT, allowNull: true },
    refreshToken: { type: DataTypes.TEXT, allowNull: true },
    scope: { type: DataTypes.TEXT, allowNull: true },
    tokenType: { type: DataTypes.STRING, allowNull: true },
    expiryDate: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "google_accounts" },
);

// ---- GithubAccount (per-user OAuth token + identity) -----------------------
export class GithubAccount extends Model<
  InferAttributes<GithubAccount>,
  InferCreationAttributes<GithubAccount>
> {
  declare userId: string;
  declare githubId: CreationOptional<string | null>;
  declare login: CreationOptional<string | null>;
  declare name: CreationOptional<string | null>;
  declare avatarUrl: CreationOptional<string | null>;
  declare accessToken: CreationOptional<string | null>;
  declare scope: CreationOptional<string | null>;
  declare tokenType: CreationOptional<string | null>;
  declare orgMember: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
GithubAccount.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true },
    githubId: { type: DataTypes.STRING, allowNull: true },
    login: { type: DataTypes.STRING, allowNull: true },
    name: { type: DataTypes.STRING, allowNull: true },
    avatarUrl: { type: DataTypes.STRING, allowNull: true },
    accessToken: { type: DataTypes.TEXT, allowNull: true },
    scope: { type: DataTypes.TEXT, allowNull: true },
    tokenType: { type: DataTypes.STRING, allowNull: true },
    orgMember: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "github_accounts" },
);

// ---- NotificationPreference -----------------------------------------------
export class NotificationPreference extends Model<
  InferAttributes<NotificationPreference>,
  InferCreationAttributes<NotificationPreference>
> {
  declare userId: string;
  declare meetingReminders: CreationOptional<boolean>;
  declare pendingTasks: CreationOptional<boolean>;
  declare feedbackRequests: CreationOptional<boolean>;
  declare mentions: CreationOptional<boolean>;
  declare events: CreationOptional<boolean>;
  declare digestFrequency: CreationOptional<(typeof DIGEST_FREQUENCIES)[number]>;
}
NotificationPreference.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true },
    meetingReminders: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    pendingTasks: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    feedbackRequests: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    mentions: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    events: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    digestFrequency: { type: DataTypes.ENUM(...DIGEST_FREQUENCIES), allowNull: false, defaultValue: "daily" },
  },
  { sequelize, tableName: "notification_preferences", timestamps: false },
);

// ---- Join (through) models -------------------------------------------------
// Defined explicitly with timestamps:false so they match the migration's
// timestamp-free join tables (the global define() default adds timestamps).
const through = (tableName: string) => sequelize.define(tableName, {}, { tableName, timestamps: false });
const DepartmentMembers = through("department_members");
const ProjectMembers = through("project_members");
const TaskAssignees = through("task_assignees");
const TaskLabels = through("task_labels");
const IssueAssignees = through("issue_assignees");
const IssueLabels = through("issue_labels");
const CommentMentions = through("comment_mentions");
const MeetingAttendees = through("meeting_attendees");

// ---- Associations ---------------------------------------------------------
Department.belongsTo(User, { as: "head", foreignKey: "headId" });
Department.belongsToMany(User, { through: DepartmentMembers, as: "members", foreignKey: "departmentId", otherKey: "userId" });
User.belongsToMany(Department, { through: DepartmentMembers, as: "departments", foreignKey: "userId", otherKey: "departmentId" });
DepartmentJoinRequest.belongsTo(User, { as: "user", foreignKey: "userId" });
DepartmentJoinRequest.belongsTo(Department, { as: "department", foreignKey: "departmentId" });

Project.belongsTo(Department, { foreignKey: "departmentId" });
Department.hasMany(Project, { as: "projects", foreignKey: "departmentId" });
Project.belongsTo(User, { as: "manager", foreignKey: "managerId" });
Project.belongsToMany(User, { through: ProjectMembers, as: "members", foreignKey: "projectId", otherKey: "userId" });
User.belongsToMany(Project, { through: ProjectMembers, as: "projects", foreignKey: "userId", otherKey: "projectId" });

Task.belongsTo(Project, { foreignKey: "projectId" });
Project.hasMany(Task, { as: "tasks", foreignKey: "projectId" });
Task.belongsTo(User, { as: "reporter", foreignKey: "reporterId" });
Task.belongsToMany(User, { through: TaskAssignees, as: "assignees", foreignKey: "taskId", otherKey: "userId" });
Task.belongsToMany(Label, { through: TaskLabels, as: "labels", foreignKey: "taskId", otherKey: "labelId" });

Issue.belongsTo(Project, { foreignKey: "projectId" });
Project.hasMany(Issue, { as: "issues", foreignKey: "projectId" });
Issue.belongsTo(User, { as: "reporter", foreignKey: "reporterId" });
Issue.belongsToMany(User, { through: IssueAssignees, as: "assignees", foreignKey: "issueId", otherKey: "userId" });
Issue.belongsToMany(Label, { through: IssueLabels, as: "labels", foreignKey: "issueId", otherKey: "labelId" });

// Polymorphic (scoped) — attachments & pull requests hang off either item type.
Task.hasMany(Attachment, { as: "attachments", foreignKey: "itemId", constraints: false, scope: { itemType: "task" } });
Task.hasMany(PullRequest, { as: "pullRequests", foreignKey: "itemId", constraints: false, scope: { itemType: "task" } });
Task.hasOne(GithubIssueLink, { as: "githubIssue", foreignKey: "itemId", constraints: false, scope: { itemType: "task" } });
Issue.hasMany(Attachment, { as: "attachments", foreignKey: "itemId", constraints: false, scope: { itemType: "issue" } });
Issue.hasMany(PullRequest, { as: "pullRequests", foreignKey: "itemId", constraints: false, scope: { itemType: "issue" } });
Issue.hasOne(GithubIssueLink, { as: "githubIssue", foreignKey: "itemId", constraints: false, scope: { itemType: "issue" } });

Comment.belongsTo(User, { as: "author", foreignKey: "authorId" });
Comment.belongsToMany(User, { through: CommentMentions, as: "mentions", foreignKey: "commentId", otherKey: "userId" });

Meeting.belongsTo(User, { as: "organizer", foreignKey: "organizerId" });
Meeting.belongsToMany(User, { through: MeetingAttendees, as: "attendees", foreignKey: "meetingId", otherKey: "userId" });

User.hasOne(NotificationPreference, { as: "preferences", foreignKey: "userId" });
NotificationPreference.belongsTo(User, { foreignKey: "userId" });

User.hasOne(GoogleAccount, { as: "googleAccount", foreignKey: "userId" });
GoogleAccount.belongsTo(User, { foreignKey: "userId" });

User.hasOne(GithubAccount, { as: "githubAccount", foreignKey: "userId" });
GithubAccount.belongsTo(User, { foreignKey: "userId" });

Project.hasMany(ProjectRepo, { as: "repos", foreignKey: "projectId" });
ProjectRepo.belongsTo(Project, { foreignKey: "projectId" });

Notification.belongsTo(User, { as: "recipient", foreignKey: "userId" });
Notification.belongsTo(User, { as: "fromUser", foreignKey: "fromUserId" });

export const models = {
  User, Department, Project, Label, Task, Issue, Comment, Activity,
  PullRequest, Attachment, Notification, Meeting, NotificationPreference, GoogleAccount, GithubAccount, ProjectRepo,
};
