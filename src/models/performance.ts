import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db/sequelize";

// Staff queries, targets, appraisals and report exports (API-CHANGES A501 to A504).
// Re-exported by models/index.ts.

export const QUERY_CATEGORIES = ["attendance", "conduct", "performance", "policy", "other"] as const;
export const QUERY_STATUSES = ["issued", "responded", "under_review", "resolved", "withdrawn"] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];
export const QUERY_DECISIONS = ["no_action", "warning", "final_warning", "suspension", "other"] as const;

export class StaffQuery extends Model<InferAttributes<StaffQuery>, InferCreationAttributes<StaffQuery>> {
  declare id: CreationOptional<string>;
  declare seq: CreationOptional<number>;
  declare staffId: string;
  declare issuedBy: CreationOptional<string | null>;
  declare category: (typeof QUERY_CATEGORIES)[number];
  declare subject: string;
  declare body: string;
  declare deadlineAt: Date;
  declare status: CreationOptional<QueryStatus>;
  declare response: CreationOptional<string | null>;
  declare respondedAt: CreationOptional<Date | null>;
  declare attachmentIds: CreationOptional<string[]>;
  declare decision: CreationOptional<(typeof QUERY_DECISIONS)[number] | null>;
  declare decisionNote: CreationOptional<string | null>;
  declare reviewedBy: CreationOptional<string | null>;
  declare reviewedAt: CreationOptional<Date | null>;
  declare resolvedBy: CreationOptional<string | null>;
  declare resolvedAt: CreationOptional<Date | null>;
  declare reminderSentAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
StaffQuery.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    seq: { type: DataTypes.INTEGER, autoIncrement: true, allowNull: false },
    staffId: { type: DataTypes.UUID, allowNull: false },
    issuedBy: { type: DataTypes.UUID, allowNull: true },
    category: { type: DataTypes.STRING(14), allowNull: false },
    subject: { type: DataTypes.STRING(200), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false },
    deadlineAt: { type: DataTypes.DATE, allowNull: false },
    status: { type: DataTypes.STRING(14), allowNull: false, defaultValue: "issued" },
    response: { type: DataTypes.TEXT, allowNull: true },
    respondedAt: { type: DataTypes.DATE, allowNull: true },
    attachmentIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
    decision: { type: DataTypes.STRING(14), allowNull: true },
    decisionNote: { type: DataTypes.TEXT, allowNull: true },
    reviewedBy: { type: DataTypes.UUID, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    resolvedBy: { type: DataTypes.UUID, allowNull: true },
    resolvedAt: { type: DataTypes.DATE, allowNull: true },
    reminderSentAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "staff_queries" },
);

export class StaffQueryEvent extends Model<InferAttributes<StaffQueryEvent>, InferCreationAttributes<StaffQueryEvent>> {
  declare id: CreationOptional<string>;
  declare queryId: string;
  declare kind: string;
  declare actorId: CreationOptional<string | null>;
  declare note: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}
StaffQueryEvent.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    queryId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.STRING(14), allowNull: false },
    actorId: { type: DataTypes.UUID, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "staff_query_events", updatedAt: false },
);

export const TARGET_OWNER_TYPES = ["user", "team", "department", "product", "project"] as const;
export type TargetOwnerType = (typeof TARGET_OWNER_TYPES)[number];
export const TARGET_PERIODS = ["month", "quarter", "year", "custom"] as const;
export const TARGET_UNITS = ["count", "percent", "currency", "hours", "custom"] as const;
export const TARGET_SOURCES = ["manual", "tasks", "integration", "imported"] as const;
export type TargetSource = (typeof TARGET_SOURCES)[number];
export const TARGET_STATUSES = ["active", "achieved", "missed", "cancelled"] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

export class Target extends Model<InferAttributes<Target>, InferCreationAttributes<Target>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare description: CreationOptional<string>;
  declare ownerType: TargetOwnerType;
  declare ownerId: string;
  declare period: (typeof TARGET_PERIODS)[number];
  declare startDate: string;
  declare endDate: string;
  declare unit: CreationOptional<(typeof TARGET_UNITS)[number]>;
  declare unitLabel: CreationOptional<string | null>;
  declare startValue: CreationOptional<number>;
  declare targetValue: number;
  declare currentValue: CreationOptional<number>;
  declare source: CreationOptional<TargetSource>;
  declare sourceConfig: CreationOptional<{ projectId?: string | null; productId?: string | null }>;
  declare reviewerId: CreationOptional<string | null>;
  declare status: CreationOptional<TargetStatus>;
  declare evaluation: CreationOptional<{ rating: number; note: string | null; by: string; at: string } | null>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Target.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    ownerType: { type: DataTypes.STRING(12), allowNull: false },
    ownerId: { type: DataTypes.UUID, allowNull: false },
    period: { type: DataTypes.STRING(8), allowNull: false },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: false },
    unit: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "count" },
    unitLabel: { type: DataTypes.STRING(40), allowNull: true },
    startValue: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
    targetValue: { type: DataTypes.DOUBLE, allowNull: false },
    currentValue: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
    source: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "manual" },
    sourceConfig: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    reviewerId: { type: DataTypes.UUID, allowNull: true },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "active" },
    evaluation: { type: DataTypes.JSONB, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "targets" },
);

export class TargetAssignment extends Model<InferAttributes<TargetAssignment>, InferCreationAttributes<TargetAssignment>> {
  declare id: CreationOptional<string>;
  declare targetId: string;
  declare userId: string;
  declare targetValue: number;
  declare currentValue: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
TargetAssignment.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    targetId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    targetValue: { type: DataTypes.DOUBLE, allowNull: false },
    currentValue: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "target_assignments" },
);
Target.hasMany(TargetAssignment, { as: "assignments", foreignKey: "targetId" });

export class TargetProgress extends Model<InferAttributes<TargetProgress>, InferCreationAttributes<TargetProgress>> {
  declare id: CreationOptional<string>;
  declare targetId: string;
  declare assignmentId: CreationOptional<string | null>;
  declare value: number;
  declare delta: number;
  declare source: TargetSource;
  declare note: CreationOptional<string | null>;
  declare evidence: CreationOptional<{ title?: string; url: string }[]>;
  declare recordedBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
TargetProgress.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    targetId: { type: DataTypes.UUID, allowNull: false },
    assignmentId: { type: DataTypes.UUID, allowNull: true },
    value: { type: DataTypes.DOUBLE, allowNull: false },
    delta: { type: DataTypes.DOUBLE, allowNull: false },
    source: { type: DataTypes.STRING(12), allowNull: false },
    note: { type: DataTypes.TEXT, allowNull: true },
    evidence: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    recordedBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "target_progress" },
);

export class AppraisalCycle extends Model<InferAttributes<AppraisalCycle>, InferCreationAttributes<AppraisalCycle>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare startDate: string;
  declare endDate: string;
  declare selfDueAt: CreationOptional<Date | null>;
  declare managerDueAt: CreationOptional<Date | null>;
  declare status: CreationOptional<"draft" | "open" | "closed">;
  declare areas: CreationOptional<{ key: string; label: string }[]>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
AppraisalCycle.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: false },
    selfDueAt: { type: DataTypes.DATE, allowNull: true },
    managerDueAt: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "draft" },
    areas: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "appraisal_cycles" },
);

export class Appraisal extends Model<InferAttributes<Appraisal>, InferCreationAttributes<Appraisal>> {
  declare id: CreationOptional<string>;
  declare cycleId: string;
  declare userId: string;
  declare managerId: CreationOptional<string | null>;
  declare status: CreationOptional<"pending_self" | "pending_manager" | "completed">;
  declare selfRatings: CreationOptional<Record<string, number>>;
  declare selfComments: CreationOptional<string>;
  declare selfSubmittedAt: CreationOptional<Date | null>;
  declare evidence: CreationOptional<{ title?: string; url: string }[]>;
  declare managerRatings: CreationOptional<Record<string, number>>;
  declare managerFeedback: CreationOptional<string>;
  declare overallRating: CreationOptional<number | null>;
  declare managerSubmittedAt: CreationOptional<Date | null>;
  declare stats: CreationOptional<Record<string, number>>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Appraisal.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    cycleId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    managerId: { type: DataTypes.UUID, allowNull: true },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "pending_self" },
    selfRatings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    selfComments: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    selfSubmittedAt: { type: DataTypes.DATE, allowNull: true },
    evidence: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    managerRatings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    managerFeedback: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    overallRating: { type: DataTypes.DOUBLE, allowNull: true },
    managerSubmittedAt: { type: DataTypes.DATE, allowNull: true },
    stats: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "appraisals" },
);

export const REPORT_TYPES = ["executive", "department", "product", "project", "staff", "staff_product", "task"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const EXPORT_FORMATS = ["pdf", "xlsx", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// Files live in the row: the API and the worker may be separate processes with
// no disk in common, and exports are small and short-lived.
export class ReportExport extends Model<InferAttributes<ReportExport>, InferCreationAttributes<ReportExport>> {
  declare id: CreationOptional<string>;
  declare requestedBy: string;
  declare reportType: ReportType;
  declare params: CreationOptional<Record<string, unknown>>;
  declare format: ExportFormat;
  declare status: CreationOptional<"queued" | "running" | "done" | "failed">;
  declare fileName: CreationOptional<string | null>;
  declare sizeBytes: CreationOptional<number | null>;
  declare rows: CreationOptional<number | null>;
  declare error: CreationOptional<string | null>;
  declare fileData: CreationOptional<Buffer | null>;
  declare finishedAt: CreationOptional<Date | null>;
  declare expiresAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
ReportExport.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    requestedBy: { type: DataTypes.UUID, allowNull: false },
    reportType: { type: DataTypes.STRING(14), allowNull: false },
    params: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    format: { type: DataTypes.STRING(4), allowNull: false },
    status: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "queued" },
    fileName: { type: DataTypes.STRING(200), allowNull: true },
    sizeBytes: { type: DataTypes.INTEGER, allowNull: true },
    rows: { type: DataTypes.INTEGER, allowNull: true },
    error: { type: DataTypes.STRING(500), allowNull: true },
    fileData: { type: DataTypes.BLOB, allowNull: true },
    finishedAt: { type: DataTypes.DATE, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "report_exports", defaultScope: { attributes: { exclude: ["fileData"] } } },
);
