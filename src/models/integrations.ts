import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db/sequelize";

// Linked email threads and GitHub repos on products (API-CHANGES A701, A702).
// Re-exported by models/index.ts.

export const THREAD_RECORD_TYPES = ["task", "project", "issue", "product"] as const;
export type ThreadRecordType = (typeof THREAD_RECORD_TYPES)[number];

export class EmailThreadLink extends Model<InferAttributes<EmailThreadLink>, InferCreationAttributes<EmailThreadLink>> {
  declare id: CreationOptional<string>;
  declare threadId: string;
  declare recordType: ThreadRecordType;
  declare recordId: string;
  declare subject: CreationOptional<string>;
  declare snippet: CreationOptional<string>;
  declare participants: CreationOptional<{ name: string; email: string }[]>;
  declare messageCount: CreationOptional<number>;
  declare lastMessageAt: CreationOptional<Date | null>;
  declare hasNewReply: CreationOptional<boolean>;
  declare linkedBy: string;
  declare lastCheckFailedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
EmailThreadLink.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    threadId: { type: DataTypes.STRING(64), allowNull: false },
    recordType: { type: DataTypes.STRING(8), allowNull: false },
    recordId: { type: DataTypes.UUID, allowNull: false },
    subject: { type: DataTypes.STRING(500), allowNull: false, defaultValue: "" },
    snippet: { type: DataTypes.STRING(500), allowNull: false, defaultValue: "" },
    participants: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    messageCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastMessageAt: { type: DataTypes.DATE, allowNull: true },
    hasNewReply: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    linkedBy: { type: DataTypes.UUID, allowNull: false },
    lastCheckFailedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "email_thread_links" },
);

export class ProductRepo extends Model<InferAttributes<ProductRepo>, InferCreationAttributes<ProductRepo>> {
  declare id: CreationOptional<string>;
  declare productId: string;
  declare owner: string;
  declare repo: string;
  declare fullName: string;
  declare htmlUrl: CreationOptional<string | null>;
  declare description: CreationOptional<string | null>;
  declare isPrivate: CreationOptional<boolean>;
  declare addedBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
ProductRepo.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    productId: { type: DataTypes.UUID, allowNull: false },
    owner: { type: DataTypes.STRING, allowNull: false },
    repo: { type: DataTypes.STRING, allowNull: false },
    fullName: { type: DataTypes.STRING, allowNull: false },
    htmlUrl: { type: DataTypes.STRING, allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    isPrivate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    addedBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "product_repos" },
);
