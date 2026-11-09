import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db/sequelize";

// Two-step recovery codes and organization settings (API-CHANGES A902, A903).
// Re-exported by models/index.ts.

export class MfaRecoveryCode extends Model<InferAttributes<MfaRecoveryCode>, InferCreationAttributes<MfaRecoveryCode>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare codeHash: string;
  declare usedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
MfaRecoveryCode.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    codeHash: { type: DataTypes.STRING, allowNull: false },
    usedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "mfa_recovery_codes" },
);

export class OrganizationSetting extends Model<InferAttributes<OrganizationSetting>, InferCreationAttributes<OrganizationSetting>> {
  declare id: CreationOptional<number>;
  declare name: CreationOptional<string>;
  declare logoUrl: CreationOptional<string | null>;
  declare timezone: CreationOptional<string>;
  declare workingDays: CreationOptional<number[]>;
  declare updatedBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
OrganizationSetting.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
    name: { type: DataTypes.STRING(120), allowNull: false, defaultValue: "MyBizPush" },
    logoUrl: { type: DataTypes.STRING, allowNull: true },
    timezone: { type: DataTypes.STRING(60), allowNull: false, defaultValue: "Africa/Lagos" },
    workingDays: { type: DataTypes.ARRAY(DataTypes.INTEGER), allowNull: false, defaultValue: [1, 2, 3, 4, 5] },
    updatedBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "organization_settings" },
);
