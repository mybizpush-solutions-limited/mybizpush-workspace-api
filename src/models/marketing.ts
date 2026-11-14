import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db/sequelize";

// Marketing and content (API-CHANGES A601 to A604). Re-exported by models/index.ts.

export const LEAD_SOURCES = ["manual", "import", "form", "referral", "event", "other"] as const;
export const LEAD_CONSENT = ["unknown", "granted", "withdrawn"] as const;
export type LeadConsent = (typeof LEAD_CONSENT)[number];
export const LEAD_STATUSES = ["active", "unsubscribed", "bounced"] as const;

export class Lead extends Model<InferAttributes<Lead>, InferCreationAttributes<Lead>> {
  declare id: CreationOptional<string>;
  declare productId: string;
  declare email: string;
  declare name: CreationOptional<string>;
  declare company: CreationOptional<string>;
  declare phone: CreationOptional<string | null>;
  declare source: CreationOptional<(typeof LEAD_SOURCES)[number]>;
  declare tags: CreationOptional<string[]>;
  declare consent: CreationOptional<LeadConsent>;
  declare consentAt: CreationOptional<Date | null>;
  declare consentSource: CreationOptional<string | null>;
  declare status: CreationOptional<(typeof LEAD_STATUSES)[number]>;
  declare ownerId: CreationOptional<string | null>;
  declare custom: CreationOptional<Record<string, unknown>>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Lead.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productId: { type: DataTypes.UUID, allowNull: false },
    email: { type: DataTypes.STRING(254), allowNull: false },
    name: { type: DataTypes.STRING(200), allowNull: false, defaultValue: "" },
    company: { type: DataTypes.STRING(200), allowNull: false, defaultValue: "" },
    phone: { type: DataTypes.STRING(40), allowNull: true },
    source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "manual" },
    tags: { type: DataTypes.ARRAY(DataTypes.STRING(60)), allowNull: false, defaultValue: [] },
    consent: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "unknown" },
    consentAt: { type: DataTypes.DATE, allowNull: true },
    consentSource: { type: DataTypes.STRING(200), allowNull: true },
    status: { type: DataTypes.STRING(14), allowNull: false, defaultValue: "active" },
    ownerId: { type: DataTypes.UUID, allowNull: true },
    custom: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "leads" },
);

export class LeadList extends Model<InferAttributes<LeadList>, InferCreationAttributes<LeadList>> {
  declare id: CreationOptional<string>;
  declare productId: string;
  declare name: string;
  declare description: CreationOptional<string>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
LeadList.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.STRING(500), allowNull: false, defaultValue: "" },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "lead_lists" },
);

export class LeadSegment extends Model<InferAttributes<LeadSegment>, InferCreationAttributes<LeadSegment>> {
  declare id: CreationOptional<string>;
  declare productId: string;
  declare name: string;
  declare rules: CreationOptional<SegmentRules>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
export interface SegmentRule {
  field: "tag" | "source" | "consent" | "status" | "company" | "email_domain" | "list" | "created_after" | "created_before";
  value: string;
}
export interface SegmentRules {
  all?: SegmentRule[];
  any?: SegmentRule[];
}
LeadSegment.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    rules: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "lead_segments" },
);

export const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "complained", "manual"] as const;
export class Suppression extends Model<InferAttributes<Suppression>, InferCreationAttributes<Suppression>> {
  declare id: CreationOptional<string>;
  declare productId: CreationOptional<string | null>;
  declare email: string;
  declare reason: (typeof SUPPRESSION_REASONS)[number];
  declare note: CreationOptional<string | null>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}
Suppression.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productId: { type: DataTypes.UUID, allowNull: true },
    email: { type: DataTypes.STRING(254), allowNull: false },
    reason: { type: DataTypes.STRING(14), allowNull: false },
    note: { type: DataTypes.STRING(500), allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "suppressions", updatedAt: false },
);

export const CAMPAIGN_STATUSES = ["draft", "pending_approval", "approved", "rejected", "scheduled", "sending", "paused", "sent", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export interface CampaignAudience {
  listIds?: string[];
  segmentIds?: string[];
  leadIds?: string[];
  includeUnknownConsent?: boolean;
}

export class Campaign extends Model<InferAttributes<Campaign>, InferCreationAttributes<Campaign>> {
  declare id: CreationOptional<string>;
  declare productId: string;
  declare name: string;
  declare subject: CreationOptional<string>;
  declare previewText: CreationOptional<string>;
  declare fromName: CreationOptional<string>;
  declare fromEmail: CreationOptional<string>;
  declare replyTo: CreationOptional<string | null>;
  declare bodyHtml: CreationOptional<string>;
  declare bodyText: CreationOptional<string>;
  declare audience: CreationOptional<CampaignAudience>;
  declare status: CreationOptional<CampaignStatus>;
  declare scheduledAt: CreationOptional<Date | null>;
  declare throttlePerMinute: CreationOptional<number>;
  declare submittedBy: CreationOptional<string | null>;
  declare submittedAt: CreationOptional<Date | null>;
  declare reviewedBy: CreationOptional<string | null>;
  declare reviewedAt: CreationOptional<Date | null>;
  declare reviewNote: CreationOptional<string | null>;
  declare startedAt: CreationOptional<Date | null>;
  declare finishedAt: CreationOptional<Date | null>;
  declare stats: CreationOptional<Record<string, number>>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Campaign.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(200), allowNull: false },
    subject: { type: DataTypes.STRING(300), allowNull: false, defaultValue: "" },
    previewText: { type: DataTypes.STRING(300), allowNull: false, defaultValue: "" },
    fromName: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
    fromEmail: { type: DataTypes.STRING(254), allowNull: false, defaultValue: "" },
    replyTo: { type: DataTypes.STRING(254), allowNull: true },
    bodyHtml: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    bodyText: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    audience: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    status: { type: DataTypes.STRING(18), allowNull: false, defaultValue: "draft" },
    scheduledAt: { type: DataTypes.DATE, allowNull: true },
    throttlePerMinute: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
    submittedBy: { type: DataTypes.UUID, allowNull: true },
    submittedAt: { type: DataTypes.DATE, allowNull: true },
    reviewedBy: { type: DataTypes.UUID, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    reviewNote: { type: DataTypes.STRING(1000), allowNull: true },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    finishedAt: { type: DataTypes.DATE, allowNull: true },
    stats: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "campaigns" },
);

export class CampaignRecipient extends Model<InferAttributes<CampaignRecipient>, InferCreationAttributes<CampaignRecipient>> {
  declare id: CreationOptional<string>;
  declare campaignId: string;
  declare leadId: CreationOptional<string | null>;
  declare email: string;
  declare token: string;
  declare status: CreationOptional<"queued" | "sending" | "sent" | "delivered" | "bounced" | "failed" | "skipped">;
  declare skipReason: CreationOptional<string | null>;
  declare providerId: CreationOptional<string | null>;
  declare sentAt: CreationOptional<Date | null>;
  declare deliveredAt: CreationOptional<Date | null>;
  declare openedAt: CreationOptional<Date | null>;
  declare openCount: CreationOptional<number>;
  declare clickedAt: CreationOptional<Date | null>;
  declare clickCount: CreationOptional<number>;
  declare unsubscribedAt: CreationOptional<Date | null>;
  declare complainedAt: CreationOptional<Date | null>;
  declare error: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
CampaignRecipient.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    campaignId: { type: DataTypes.UUID, allowNull: false },
    leadId: { type: DataTypes.UUID, allowNull: true },
    email: { type: DataTypes.STRING(254), allowNull: false },
    token: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "queued" },
    skipReason: { type: DataTypes.STRING(20), allowNull: true },
    providerId: { type: DataTypes.STRING(120), allowNull: true },
    sentAt: { type: DataTypes.DATE, allowNull: true },
    deliveredAt: { type: DataTypes.DATE, allowNull: true },
    openedAt: { type: DataTypes.DATE, allowNull: true },
    openCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    clickedAt: { type: DataTypes.DATE, allowNull: true },
    clickCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    unsubscribedAt: { type: DataTypes.DATE, allowNull: true },
    complainedAt: { type: DataTypes.DATE, allowNull: true },
    error: { type: DataTypes.STRING(500), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "campaign_recipients" },
);

export class CampaignLink extends Model<InferAttributes<CampaignLink>, InferCreationAttributes<CampaignLink>> {
  declare id: CreationOptional<string>;
  declare campaignId: string;
  declare url: string;
  declare clicks: CreationOptional<number>;
  declare uniqueClicks: CreationOptional<number>;
}
CampaignLink.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    campaignId: { type: DataTypes.UUID, allowNull: false },
    url: { type: DataTypes.TEXT, allowNull: false },
    clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    uniqueClicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { sequelize, tableName: "campaign_links", timestamps: false },
);

export const CONTENT_TYPES = ["blog", "social_post", "video", "graphic", "email", "newsletter", "other"] as const;
export const CONTENT_PLATFORMS = ["instagram", "facebook", "x", "linkedin", "tiktok", "youtube", "website", "email", "other"] as const;

export class ContentItem extends Model<InferAttributes<ContentItem>, InferCreationAttributes<ContentItem>> {
  declare id: CreationOptional<string>;
  declare productId: string;
  declare title: string;
  declare type: (typeof CONTENT_TYPES)[number];
  declare platform: CreationOptional<(typeof CONTENT_PLATFORMS)[number] | null>;
  declare status: CreationOptional<string>;
  declare brief: CreationOptional<string>;
  declare caption: CreationOptional<string>;
  declare writerId: CreationOptional<string | null>;
  declare designerId: CreationOptional<string | null>;
  declare reviewerId: CreationOptional<string | null>;
  declare publishAt: CreationOptional<Date | null>;
  declare publishedAt: CreationOptional<Date | null>;
  declare blogPostId: CreationOptional<string | null>;
  declare url: CreationOptional<string | null>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
ContentItem.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productId: { type: DataTypes.UUID, allowNull: false },
    title: { type: DataTypes.STRING(300), allowNull: false },
    type: { type: DataTypes.STRING(12), allowNull: false },
    platform: { type: DataTypes.STRING(12), allowNull: true },
    status: { type: DataTypes.STRING(18), allowNull: false, defaultValue: "idea" },
    brief: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    caption: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    writerId: { type: DataTypes.UUID, allowNull: true },
    designerId: { type: DataTypes.UUID, allowNull: true },
    reviewerId: { type: DataTypes.UUID, allowNull: true },
    publishAt: { type: DataTypes.DATE, allowNull: true },
    publishedAt: { type: DataTypes.DATE, allowNull: true },
    blogPostId: { type: DataTypes.UUID, allowNull: true },
    url: { type: DataTypes.STRING(2000), allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "content_items" },
);

export class ContentEvent extends Model<InferAttributes<ContentEvent>, InferCreationAttributes<ContentEvent>> {
  declare id: CreationOptional<string>;
  declare contentId: string;
  declare kind: "created" | "status" | "review";
  declare fromStatus: CreationOptional<string | null>;
  declare toStatus: CreationOptional<string | null>;
  declare decision: CreationOptional<string | null>;
  declare note: CreationOptional<string | null>;
  declare actorId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
ContentEvent.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    contentId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.STRING(8), allowNull: false },
    fromStatus: { type: DataTypes.STRING(18), allowNull: true },
    toStatus: { type: DataTypes.STRING(18), allowNull: true },
    decision: { type: DataTypes.STRING(18), allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    actorId: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "content_events" },
);

export class SocialAccount extends Model<InferAttributes<SocialAccount>, InferCreationAttributes<SocialAccount>> {
  declare id: CreationOptional<string>;
  declare productId: string;
  declare platform: string;
  declare handle: string;
  declare url: CreationOptional<string | null>;
  declare ownerId: CreationOptional<string | null>;
  declare notes: CreationOptional<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
SocialAccount.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productId: { type: DataTypes.UUID, allowNull: false },
    platform: { type: DataTypes.STRING(12), allowNull: false },
    handle: { type: DataTypes.STRING(120), allowNull: false },
    url: { type: DataTypes.STRING(2000), allowNull: true },
    ownerId: { type: DataTypes.UUID, allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: false, defaultValue: "" },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "social_accounts" },
);
