import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db/sequelize";

// Communication (API-CHANGES A301 to A304). Separate from models/index.ts, which
// re-exports everything here.

export const CONVERSATION_TYPES = ["direct", "channel"] as const;
export const CHANNEL_SCOPES = ["organization", "department", "team", "product", "project", "private"] as const;
export type ChannelScope = (typeof CHANNEL_SCOPES)[number];
export const MEMBER_ROLES = ["owner", "moderator", "member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const MEMBER_NOTIFY = ["all", "mentions", "none"] as const;
export type MemberNotify = (typeof MEMBER_NOTIFY)[number];
export const MESSAGE_TYPES = ["text", "image", "video", "audio", "voice", "file", "link", "location", "system"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export const ANNOUNCEMENT_STATUSES = ["draft", "scheduled", "published", "archived"] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];
export const AUDIENCE_TYPES = ["organization", "department", "team", "product", "project", "users"] as const;
export type AudienceType = (typeof AUDIENCE_TYPES)[number];

export class Conversation extends Model<InferAttributes<Conversation>, InferCreationAttributes<Conversation>> {
  declare id: CreationOptional<string>;
  declare type: (typeof CONVERSATION_TYPES)[number];
  declare scope: CreationOptional<ChannelScope | null>;
  declare scopeId: CreationOptional<string | null>;
  declare name: CreationOptional<string>;
  declare description: CreationOptional<string>;
  declare avatarUrl: CreationOptional<string | null>;
  declare posting: CreationOptional<"everyone" | "moderators">;
  declare directKey: CreationOptional<string | null>;
  declare createdBy: CreationOptional<string | null>;
  declare memberCount: CreationOptional<number>;
  declare lastSeq: CreationOptional<string | number>;
  declare lastMessageId: CreationOptional<string | null>;
  declare lastMessageAt: CreationOptional<Date | null>;
  declare lastSenderId: CreationOptional<string | null>;
  declare lastMessageType: CreationOptional<string | null>;
  declare lastPreview: CreationOptional<string | null>;
  declare archivedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Conversation.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    type: { type: DataTypes.STRING(10), allowNull: false },
    scope: { type: DataTypes.STRING(14), allowNull: true },
    scopeId: { type: DataTypes.UUID, allowNull: true },
    name: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "" },
    description: { type: DataTypes.STRING(1000), allowNull: false, defaultValue: "" },
    avatarUrl: { type: DataTypes.STRING, allowNull: true },
    posting: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "everyone" },
    directKey: { type: DataTypes.STRING(80), allowNull: true, unique: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    memberCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastSeq: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    lastMessageId: { type: DataTypes.UUID, allowNull: true },
    lastMessageAt: { type: DataTypes.DATE, allowNull: true },
    lastSenderId: { type: DataTypes.UUID, allowNull: true },
    lastMessageType: { type: DataTypes.STRING(10), allowNull: true },
    lastPreview: { type: DataTypes.STRING(200), allowNull: true },
    archivedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "conversations" },
);

export class ConversationMember extends Model<InferAttributes<ConversationMember>, InferCreationAttributes<ConversationMember>> {
  declare id: CreationOptional<string>;
  declare conversationId: string;
  declare userId: string;
  declare role: CreationOptional<MemberRole>;
  // "scope": came with the channel's scope and goes when they leave it.
  // "manual": added by hand, stays until removed by hand.
  declare source: CreationOptional<"scope" | "manual">;
  declare lastReadSeq: CreationOptional<string | number>;
  declare lastReadAt: CreationOptional<Date | null>;
  declare notify: CreationOptional<MemberNotify>;
  declare mutedUntil: CreationOptional<Date | null>;
  declare pinned: CreationOptional<boolean>;
  // Set when they leave or are removed. The row stays so that the hourly scope
  // sync doesn't add back someone a moderator removed.
  declare leftAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
ConversationMember.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    conversationId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    role: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "member" },
    source: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "manual" },
    lastReadSeq: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    lastReadAt: { type: DataTypes.DATE, allowNull: true },
    notify: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "mentions" },
    mutedUntil: { type: DataTypes.DATE, allowNull: true },
    pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    leftAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "conversation_members" },
);

export class Message extends Model<InferAttributes<Message>, InferCreationAttributes<Message>> {
  declare id: CreationOptional<string>;
  declare conversationId: string;
  declare seq: CreationOptional<string | number>;
  declare senderId: CreationOptional<string | null>;
  declare type: CreationOptional<MessageType>;
  declare body: CreationOptional<string>;
  declare meta: CreationOptional<Record<string, unknown>>;
  declare parentId: CreationOptional<string | null>;
  declare replyToId: CreationOptional<string | null>;
  declare threadReplyCount: CreationOptional<number>;
  declare threadLastReplyAt: CreationOptional<Date | null>;
  declare threadParticipantIds: CreationOptional<string[]>;
  declare mentions: CreationOptional<string[]>;
  declare pinnedAt: CreationOptional<Date | null>;
  declare editedAt: CreationOptional<Date | null>;
  declare deletedAt: CreationOptional<Date | null>;
  declare deletedBy: CreationOptional<string | null>;
  declare clientSentAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Message.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    conversationId: { type: DataTypes.UUID, allowNull: false },
    seq: { type: DataTypes.BIGINT, autoIncrement: true, allowNull: false },
    senderId: { type: DataTypes.UUID, allowNull: true },
    type: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "text" },
    body: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    meta: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    parentId: { type: DataTypes.UUID, allowNull: true },
    replyToId: { type: DataTypes.UUID, allowNull: true },
    threadReplyCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    threadLastReplyAt: { type: DataTypes.DATE, allowNull: true },
    threadParticipantIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
    mentions: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
    pinnedAt: { type: DataTypes.DATE, allowNull: true },
    editedAt: { type: DataTypes.DATE, allowNull: true },
    deletedAt: { type: DataTypes.DATE, allowNull: true },
    deletedBy: { type: DataTypes.UUID, allowNull: true },
    clientSentAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "messages" },
);

export class MessageReaction extends Model<InferAttributes<MessageReaction>, InferCreationAttributes<MessageReaction>> {
  declare messageId: string;
  declare userId: string;
  declare emoji: string;
  declare createdAt: CreationOptional<Date>;
}
MessageReaction.init(
  {
    messageId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    emoji: { type: DataTypes.STRING(16), allowNull: false, primaryKey: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: "message_reactions", updatedAt: false },
);
Message.hasMany(MessageReaction, { as: "reactions", foreignKey: "messageId" });

export class Announcement extends Model<InferAttributes<Announcement>, InferCreationAttributes<Announcement>> {
  declare id: CreationOptional<string>;
  declare title: string;
  declare body: CreationOptional<string>;
  declare audienceType: AudienceType;
  declare audienceIds: CreationOptional<string[]>;
  declare status: CreationOptional<AnnouncementStatus>;
  declare requireAck: CreationOptional<boolean>;
  declare pinned: CreationOptional<boolean>;
  declare publishAt: CreationOptional<Date | null>;
  declare publishedAt: CreationOptional<Date | null>;
  declare expiresAt: CreationOptional<Date | null>;
  declare createdBy: CreationOptional<string | null>;
  declare publishedBy: CreationOptional<string | null>;
  declare recipientCount: CreationOptional<number>;
  declare acknowledgedCount: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Announcement.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    title: { type: DataTypes.STRING(200), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    audienceType: { type: DataTypes.STRING(14), allowNull: false },
    audienceIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "draft" },
    requireAck: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    publishAt: { type: DataTypes.DATE, allowNull: true },
    publishedAt: { type: DataTypes.DATE, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    publishedBy: { type: DataTypes.UUID, allowNull: true },
    recipientCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    acknowledgedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "announcements" },
);

export class AnnouncementReceipt extends Model<InferAttributes<AnnouncementReceipt>, InferCreationAttributes<AnnouncementReceipt>> {
  declare id: CreationOptional<string>;
  declare announcementId: string;
  declare userId: string;
  declare readAt: CreationOptional<Date | null>;
  declare acknowledgedAt: CreationOptional<Date | null>;
  declare lastRemindedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
AnnouncementReceipt.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    announcementId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    readAt: { type: DataTypes.DATE, allowNull: true },
    acknowledgedAt: { type: DataTypes.DATE, allowNull: true },
    lastRemindedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "announcement_receipts" },
);

export class NotificationCategoryPreference extends Model<InferAttributes<NotificationCategoryPreference>, InferCreationAttributes<NotificationCategoryPreference>> {
  declare userId: string;
  declare category: string;
  declare inApp: boolean;
  declare push: boolean;
  declare email: boolean;
  declare updatedAt: CreationOptional<Date>;
}
NotificationCategoryPreference.init(
  {
    userId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    category: { type: DataTypes.STRING(20), allowNull: false, primaryKey: true },
    inApp: { type: DataTypes.BOOLEAN, allowNull: false },
    push: { type: DataTypes.BOOLEAN, allowNull: false },
    email: { type: DataTypes.BOOLEAN, allowNull: false },
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "notification_category_preferences", createdAt: false },
);
