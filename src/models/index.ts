import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../db/sequelize";

// Domain enums (kept in sync with ui/src/types/index.ts).
export const ACCESS_LEVELS = ["member", "admin", "chief", "executive_admin"] as const;
// "Org managers" (chief or executive admin) may manage departments, projects and
// schedule meetings. Promoting access levels and deleting members stay exec-only.
export function isOrgManager(level: string): boolean {
  return level === "chief" || level === "executive_admin";
}
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
  "Frontend", "Backend", "DevOps", "SMM", "Marketer", "Graphics Designer", "UI/UX Designer",
  "Video Editor", "CEO", "CTO", "CIO", "CSO", "CMO", "COO",
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
  // Optional second @domain address (e.g. an executive's role email). Either
  // email can be used to sign in; both are shown on the profile.
  declare secondaryEmail: CreationOptional<string | null>;
  declare passwordHash: string;
  declare avatarColor: CreationOptional<string>;
  declare avatarUrl: CreationOptional<string | null>;
  declare accessLevel: CreationOptional<AccessLevel>;
  declare roles: CreationOptional<string[]>;
  declare onboarded: CreationOptional<boolean>;
  // Cosmetic golden "Chief" badge — auto for the chief access level, but can be
  // granted independently to any user by an executive admin.
  declare chiefBadge: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
User.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    secondaryEmail: { type: DataTypes.STRING, allowNull: true, unique: true },
    passwordHash: { type: DataTypes.STRING, allowNull: false },
    avatarColor: { type: DataTypes.STRING, allowNull: false, defaultValue: "#960095" },
    avatarUrl: { type: DataTypes.STRING, allowNull: true },
    accessLevel: { type: DataTypes.ENUM(...ACCESS_LEVELS), allowNull: false, defaultValue: "member" },
    roles: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    onboarded: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    chiefBadge: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
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
  // Legacy "home" department. Projects are now independent and worked on by many
  // departments (the project_departments join); kept nullable for back-compat.
  declare departmentId: CreationOptional<string | null>;
  declare name: string;
  declare description: CreationOptional<string>;
  // What the project is built with, e.g. "Node.js + TypeScript (Express,
  // Sequelize, Postgres)". Surfaced to the AI so briefs target the real stack.
  declare techStack: CreationOptional<string>;
  declare managerId: CreationOptional<string | null>;
  declare progress: CreationOptional<number>;
  declare avatarUrl: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Project.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    departmentId: { type: DataTypes.UUID, allowNull: true },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    techStack: { type: DataTypes.STRING(400), allowNull: false, defaultValue: "" },
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
  declare departmentId: CreationOptional<string | null>; // which department "lane"
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
    departmentId: { type: DataTypes.UUID, allowNull: true },
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
  declare departmentId: CreationOptional<string | null>; // which department "lane"
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
    departmentId: { type: DataTypes.UUID, allowNull: true },
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

// ---- DocumentationLink ----------------------------------------------------
// A documentation/reference URL linked to a task or issue (Google Doc, Notion,
// spec, design, etc.) — analogous to a linked PR but just a titled link.
export class DocumentationLink extends Model<
  InferAttributes<DocumentationLink>,
  InferCreationAttributes<DocumentationLink>
> {
  declare id: CreationOptional<string>;
  declare itemId: string;
  declare itemType: ItemType;
  declare title: string;
  declare url: string;
  declare addedBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}
DocumentationLink.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    itemId: { type: DataTypes.UUID, allowNull: false },
    itemType: { type: DataTypes.ENUM(...ITEM_TYPES), allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    url: { type: DataTypes.STRING, allowNull: false },
    addedBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "documentation_links", updatedAt: false },
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
// Structured recurrence for a meeting (translated to an iCalendar RRULE for
// Google Calendar). `null` = one-off meeting.
export interface RecurrenceRule {
  freq: "daily" | "weekly" | "monthly";
  interval: number; // every N days/weeks/months (1 = every, 2 = biweekly, …)
  count?: number | null; // end after N occurrences
  until?: string | null; // end on this date (YYYY-MM-DD), exclusive of count
}

export class Meeting extends Model<InferAttributes<Meeting>, InferCreationAttributes<Meeting>> {
  declare id: CreationOptional<string>;
  declare title: string;
  declare description: CreationOptional<string | null>;
  declare organizerId: CreationOptional<string | null>;
  declare startsAt: Date;
  declare endsAt: Date;
  declare meetUrl: string;
  declare googleEventId: CreationOptional<string | null>;
  declare recurrence: CreationOptional<RecurrenceRule | null>;
  // Third-party invitees by email (not app users) — added to the Google invite.
  declare externalEmails: CreationOptional<string[]>;
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
    recurrence: { type: DataTypes.JSONB, allowNull: true },
    externalEmails: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "meetings", updatedAt: false },
);

// ---- ProjectRepo (GitHub repos linked to a project) ------------------------
export class ProjectRepo extends Model<InferAttributes<ProjectRepo>, InferCreationAttributes<ProjectRepo>> {
  declare id: CreationOptional<string>;
  declare projectId: string;
  declare departmentId: CreationOptional<string | null>; // which department "lane"
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
    departmentId: { type: DataTypes.UUID, allowNull: true },
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

// ---- BlacklistedEmail ------------------------------------------------------
// Emails banned from ever signing up again (set when an exec blacklists a user).
export class BlacklistedEmail extends Model<
  InferAttributes<BlacklistedEmail>,
  InferCreationAttributes<BlacklistedEmail>
> {
  declare id: CreationOptional<string>;
  declare email: string;
  declare reason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
BlacklistedEmail.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    reason: { type: DataTypes.STRING, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "blacklisted_emails" },
);

// ---- CustomRole ------------------------------------------------------------
// Team roles an executive admin has added beyond the built-in ROLES list. The
// effective role catalog is ROLES + these, and everyone picks from it.
export class CustomRole extends Model<
  InferAttributes<CustomRole>,
  InferCreationAttributes<CustomRole>
> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
CustomRole.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false, unique: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "custom_roles" },
);

// ---- Analytics -------------------------------------------------------------
// A tracked website. `publicKey` is the only identifier that leaves the server
// (it lives in the snippet's data-site attribute), so it's non-guessable but
// safe to expose.
export class AnalyticsSite extends Model<
  InferAttributes<AnalyticsSite>,
  InferCreationAttributes<AnalyticsSite>
> {
  declare id: CreationOptional<string>;
  declare projectId: CreationOptional<string | null>;
  declare name: string;
  declare domain: string;
  declare publicKey: string;
  declare allowedOrigins: CreationOptional<string[]>;
  // Read-only key that lets another of our apps render this site's numbers
  // without a Dev Space session. Null = sharing off.
  declare shareKey: CreationOptional<string | null>;
  // Branding scraped from the site's homepage so the sites list is scannable.
  // URLs only — the images are loaded straight from the site by the browser.
  declare faviconUrl: CreationOptional<string>;
  declare ogImageUrl: CreationOptional<string>;
  declare siteTitle: CreationOptional<string>;
  declare siteDescription: CreationOptional<string>;
  declare brandingFetchedAt: CreationOptional<Date | null>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
AnalyticsSite.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    projectId: { type: DataTypes.UUID, allowNull: true },
    name: { type: DataTypes.STRING, allowNull: false },
    domain: { type: DataTypes.STRING, allowNull: false },
    publicKey: { type: DataTypes.STRING(32), allowNull: false, unique: true },
    allowedOrigins: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    shareKey: { type: DataTypes.STRING(32), allowNull: true, unique: true },
    faviconUrl: { type: DataTypes.STRING(1000), allowNull: false, defaultValue: "" },
    ogImageUrl: { type: DataTypes.STRING(1000), allowNull: false, defaultValue: "" },
    siteTitle: { type: DataTypes.STRING(300), allowNull: false, defaultValue: "" },
    siteDescription: { type: DataTypes.STRING(600), allowNull: false, defaultValue: "" },
    brandingFetchedAt: { type: DataTypes.DATE, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "analytics_sites" },
);

export const ANALYTICS_EVENT_KINDS = ["pageview", "event"] as const;
export type AnalyticsEventKind = (typeof ANALYTICS_EVENT_KINDS)[number];

// One raw hit. Deliberately denormalised (no joins on the read path) and free of
// personal data — the visitor is a salted daily hash, never an IP or a cookie.
export class AnalyticsEvent extends Model<
  InferAttributes<AnalyticsEvent>,
  InferCreationAttributes<AnalyticsEvent>
> {
  declare id: CreationOptional<string>;
  declare siteId: string;
  declare ts: Date;
  declare kind: CreationOptional<AnalyticsEventKind>;
  declare name: CreationOptional<string>;
  declare path: CreationOptional<string>;
  declare referrerHost: CreationOptional<string>;
  declare referrerPath: CreationOptional<string>;
  declare utmSource: CreationOptional<string>;
  declare utmMedium: CreationOptional<string>;
  declare utmCampaign: CreationOptional<string>;
  declare country: CreationOptional<string>;
  declare deviceType: CreationOptional<string>;
  declare browser: CreationOptional<string>;
  declare os: CreationOptional<string>;
  declare visitorHash: string;
  declare sessionId: CreationOptional<string>;
  declare durationMs: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
}
AnalyticsEvent.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    siteId: { type: DataTypes.UUID, allowNull: false },
    ts: { type: DataTypes.DATE, allowNull: false },
    kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "pageview" },
    name: { type: DataTypes.STRING(80), allowNull: false, defaultValue: "" },
    path: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "/" },
    referrerHost: { type: DataTypes.STRING(255), allowNull: false, defaultValue: "" },
    referrerPath: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    utmSource: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
    utmMedium: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
    utmCampaign: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
    country: { type: DataTypes.STRING(2), allowNull: false, defaultValue: "" },
    deviceType: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "" },
    browser: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "" },
    os: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "" },
    visitorHash: { type: DataTypes.STRING(64), allowNull: false },
    sessionId: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },
    durationMs: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "analytics_events", updatedAt: false },
);

// Per-day, per-path rollup rebuilt by the analytics cron so dashboards over long
// ranges never scan the raw event log.
export class AnalyticsDaily extends Model<
  InferAttributes<AnalyticsDaily>,
  InferCreationAttributes<AnalyticsDaily>
> {
  declare id: CreationOptional<string>;
  declare siteId: string;
  declare day: string;
  declare path: CreationOptional<string>;
  declare pageviews: CreationOptional<number>;
  declare visitors: CreationOptional<number>;
  declare sessions: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
AnalyticsDaily.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    siteId: { type: DataTypes.UUID, allowNull: false },
    day: { type: DataTypes.DATEONLY, allowNull: false },
    path: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "/" },
    pageviews: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    visitors: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sessions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "analytics_daily" },
);

// ---- Blog console ----------------------------------------------------------
// A project's connection to the blog API that powers its public website. Posts
// themselves are never stored here — the site's own API stays authoritative.
export class BlogChannel extends Model<
  InferAttributes<BlogChannel>,
  InferCreationAttributes<BlogChannel>
> {
  declare id: CreationOptional<string>;
  declare projectId: string;
  declare name: string;
  declare kind: CreationOptional<string>;
  declare apiBaseUrl: string;
  declare serviceToken: string;
  declare siteUrl: CreationOptional<string>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
BlogChannel.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    projectId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    kind: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "hyparrow" },
    apiBaseUrl: { type: DataTypes.STRING(500), allowNull: false },
    serviceToken: { type: DataTypes.TEXT, allowNull: false },
    siteUrl: { type: DataTypes.STRING(500), allowNull: false, defaultValue: "" },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "blog_channels" },
);

// Who may work on a project's blog. Assignment is restricted to the project
// manager, a head of an involved department, or an executive admin.
export const BLOG_EDITOR_ROLES = ["editor", "publisher"] as const;
export type BlogEditorRole = (typeof BLOG_EDITOR_ROLES)[number];

export class BlogEditor extends Model<
  InferAttributes<BlogEditor>,
  InferCreationAttributes<BlogEditor>
> {
  declare id: CreationOptional<string>;
  declare projectId: string;
  declare userId: string;
  declare role: CreationOptional<BlogEditorRole>;
  declare assignedBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
BlogEditor.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    projectId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    role: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "editor" },
    assignedBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "blog_editors" },
);

// ---- Managed databases -----------------------------------------------------
export const DB_ENVIRONMENTS = ["development", "staging", "production"] as const;
export type DbEnvironment = (typeof DB_ENVIRONMENTS)[number];

export const DB_STATUSES = ["unknown", "ok", "error"] as const;
export type DbStatus = (typeof DB_STATUSES)[number];

export const BACKUP_STATUSES = ["running", "succeeded", "failed"] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export const BACKUP_TRIGGERS = ["manual", "scheduled"] as const;
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];

export const BACKUP_STORAGES = ["cloudinary", "local"] as const;
export type BackupStorage = (typeof BACKUP_STORAGES)[number];

export const BACKUP_FREQUENCIES = ["hourly", "daily", "weekly", "monthly"] as const;
export type BackupFrequency = (typeof BACKUP_FREQUENCIES)[number];

// A Postgres database a project depends on. `connectionString` is the only
// secret and is stored encrypted; every other column is a non-secret projection
// of it so the console never has to decrypt just to render a row.
export class ProjectDatabase extends Model<
  InferAttributes<ProjectDatabase>,
  InferCreationAttributes<ProjectDatabase>
> {
  declare id: CreationOptional<string>;
  declare projectId: string;
  declare name: string;
  declare environment: CreationOptional<DbEnvironment>;
  declare provider: CreationOptional<string>;
  declare connectionString: string;
  declare host: CreationOptional<string>;
  declare port: CreationOptional<number>;
  declare databaseName: CreationOptional<string>;
  declare username: CreationOptional<string>;
  declare sslMode: CreationOptional<string>;
  declare status: CreationOptional<DbStatus>;
  declare lastCheckedAt: CreationOptional<Date | null>;
  declare lastError: CreationOptional<string>;
  declare sizeBytes: CreationOptional<number>;
  declare tableCount: CreationOptional<number>;
  declare serverVersion: CreationOptional<string>;
  declare retentionCount: CreationOptional<number>;
  declare notes: CreationOptional<string>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
ProjectDatabase.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    projectId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    environment: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "development" },
    provider: { type: DataTypes.STRING(40), allowNull: false, defaultValue: "" },
    connectionString: { type: DataTypes.TEXT, allowNull: false },
    host: { type: DataTypes.STRING(255), allowNull: false, defaultValue: "" },
    port: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5432 },
    databaseName: { type: DataTypes.STRING(255), allowNull: false, defaultValue: "" },
    username: { type: DataTypes.STRING(255), allowNull: false, defaultValue: "" },
    sslMode: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "require" },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "unknown" },
    lastCheckedAt: { type: DataTypes.DATE, allowNull: true },
    lastError: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    // BIGINT comes back as a string from pg; the services coerce on read.
    sizeBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    tableCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    serverVersion: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" },
    retentionCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 7 },
    notes: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "project_databases" },
);

// One dump attempt. Rows are written before the dump starts (status "running")
// so a crash mid-backup is visible rather than silently absent.
export class DatabaseBackup extends Model<
  InferAttributes<DatabaseBackup>,
  InferCreationAttributes<DatabaseBackup>
> {
  declare id: CreationOptional<string>;
  declare databaseId: string;
  declare projectId: string;
  declare status: CreationOptional<BackupStatus>;
  declare trigger: CreationOptional<BackupTrigger>;
  declare format: CreationOptional<string>;
  declare storage: CreationOptional<BackupStorage>;
  declare storageNote: CreationOptional<string>;
  declare fileName: CreationOptional<string>;
  declare fileSizeBytes: CreationOptional<number>;
  declare checksum: CreationOptional<string>;
  declare cloudinaryPublicId: CreationOptional<string>;
  declare cloudinaryFormat: CreationOptional<string>;
  declare localPath: CreationOptional<string>;
  declare startedAt: Date;
  declare finishedAt: CreationOptional<Date | null>;
  declare durationMs: CreationOptional<number>;
  declare error: CreationOptional<string>;
  declare pgDumpVersion: CreationOptional<string>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
DatabaseBackup.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    databaseId: { type: DataTypes.UUID, allowNull: false },
    projectId: { type: DataTypes.UUID, allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "running" },
    trigger: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "manual" },
    format: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "custom" },
    storage: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "local" },
    storageNote: { type: DataTypes.STRING(300), allowNull: false, defaultValue: "" },
    fileName: { type: DataTypes.STRING(300), allowNull: false, defaultValue: "" },
    fileSizeBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    checksum: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "" },
    cloudinaryPublicId: { type: DataTypes.STRING(400), allowNull: false, defaultValue: "" },
    cloudinaryFormat: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" },
    localPath: { type: DataTypes.STRING(700), allowNull: false, defaultValue: "" },
    startedAt: { type: DataTypes.DATE, allowNull: false },
    finishedAt: { type: DataTypes.DATE, allowNull: true },
    durationMs: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    error: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    pgDumpVersion: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "database_backups" },
);

// At most one schedule per database. `nextRunAt` is precomputed from the
// frequency + wall-clock fields so the ticker is a single indexed query.
export class DatabaseBackupSchedule extends Model<
  InferAttributes<DatabaseBackupSchedule>,
  InferCreationAttributes<DatabaseBackupSchedule>
> {
  declare id: CreationOptional<string>;
  declare databaseId: string;
  declare enabled: CreationOptional<boolean>;
  declare frequency: CreationOptional<BackupFrequency>;
  declare hour: CreationOptional<number>;
  declare minute: CreationOptional<number>;
  declare dayOfWeek: CreationOptional<number>;
  declare dayOfMonth: CreationOptional<number>;
  declare timezone: CreationOptional<string>;
  declare format: CreationOptional<string>;
  declare storageTarget: CreationOptional<BackupStorage>;
  declare lastRunAt: CreationOptional<Date | null>;
  declare nextRunAt: CreationOptional<Date | null>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
DatabaseBackupSchedule.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    databaseId: { type: DataTypes.UUID, allowNull: false, unique: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    frequency: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "daily" },
    hour: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2 },
    minute: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    dayOfWeek: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    dayOfMonth: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "Africa/Lagos" },
    format: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "custom" },
    storageTarget: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "cloudinary" },
    lastRunAt: { type: DataTypes.DATE, allowNull: true },
    nextRunAt: { type: DataTypes.DATE, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "database_backup_schedules" },
);

// ---- Join (through) models -------------------------------------------------
// Defined explicitly with timestamps:false so they match the migration's
// timestamp-free join tables (the global define() default adds timestamps).
const through = (tableName: string) => sequelize.define(tableName, {}, { tableName, timestamps: false });
const DepartmentMembers = through("department_members");
const ProjectMembers = through("project_members");
const ProjectDepartments = through("project_departments");
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
// Many-to-many: the departments working on a project (the "lanes").
Project.belongsToMany(Department, { through: ProjectDepartments, as: "departments", foreignKey: "projectId", otherKey: "departmentId" });
Department.belongsToMany(Project, { through: ProjectDepartments, as: "workingProjects", foreignKey: "departmentId", otherKey: "projectId" });
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
Task.hasMany(DocumentationLink, { as: "docs", foreignKey: "itemId", constraints: false, scope: { itemType: "task" } });
Issue.hasMany(DocumentationLink, { as: "docs", foreignKey: "itemId", constraints: false, scope: { itemType: "issue" } });

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

BlogChannel.belongsTo(Project, { as: "project", foreignKey: "projectId" });
Project.hasMany(BlogChannel, { as: "blogChannels", foreignKey: "projectId" });
BlogEditor.belongsTo(User, { as: "user", foreignKey: "userId" });
BlogEditor.belongsTo(Project, { as: "project", foreignKey: "projectId" });

AnalyticsSite.belongsTo(Project, { as: "project", foreignKey: "projectId" });
Project.hasMany(AnalyticsSite, { as: "analyticsSites", foreignKey: "projectId" });
AnalyticsEvent.belongsTo(AnalyticsSite, { as: "site", foreignKey: "siteId" });
AnalyticsDaily.belongsTo(AnalyticsSite, { as: "site", foreignKey: "siteId" });

ProjectDatabase.belongsTo(Project, { as: "project", foreignKey: "projectId" });
Project.hasMany(ProjectDatabase, { as: "databases", foreignKey: "projectId" });
DatabaseBackup.belongsTo(ProjectDatabase, { as: "database", foreignKey: "databaseId" });
ProjectDatabase.hasMany(DatabaseBackup, { as: "backups", foreignKey: "databaseId" });
ProjectDatabase.hasOne(DatabaseBackupSchedule, { as: "schedule", foreignKey: "databaseId" });
DatabaseBackupSchedule.belongsTo(ProjectDatabase, { as: "database", foreignKey: "databaseId" });

Notification.belongsTo(User, { as: "recipient", foreignKey: "userId" });
Notification.belongsTo(User, { as: "fromUser", foreignKey: "fromUserId" });

export const models = {
  User, Department, Project, Label, Task, Issue, Comment, Activity,
  PullRequest, Attachment, Notification, Meeting, NotificationPreference, GoogleAccount, GithubAccount, ProjectRepo,
  BlacklistedEmail, CustomRole, DocumentationLink,
  AnalyticsSite, AnalyticsEvent, AnalyticsDaily, BlogChannel, BlogEditor,
  ProjectDatabase, DatabaseBackup, DatabaseBackupSchedule,
};
