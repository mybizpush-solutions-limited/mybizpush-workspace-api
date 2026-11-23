import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db/sequelize";

// Staff can't edit their own details directly once onboarded: each edit waits for an approver.
// Re-exported by models/index.ts.

export const PROFILE_CHANGE_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type ProfileChangeStatus = (typeof PROFILE_CHANGE_STATUSES)[number];

export type ProfileChanges = {
  name?: string;
  phone?: string | null;
  secondaryEmail?: string | null;
  avatarUrl?: string;
};

export class ProfileChangeRequest extends Model<InferAttributes<ProfileChangeRequest>, InferCreationAttributes<ProfileChangeRequest>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare changes: ProfileChanges;
  declare status: CreationOptional<ProfileChangeStatus>;
  declare reviewerId: CreationOptional<string | null>;
  declare reviewedAt: CreationOptional<Date | null>;
  declare reviewNote: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
ProfileChangeRequest.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    changes: { type: DataTypes.JSONB, allowNull: false },
    status: { type: DataTypes.ENUM(...PROFILE_CHANGE_STATUSES), allowNull: false, defaultValue: "pending" },
    reviewerId: { type: DataTypes.UUID, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    reviewNote: { type: DataTypes.STRING(500), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "profile_change_requests" },
);
