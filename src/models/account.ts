import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db/sequelize";

// Organization settings (API-CHANGES A903). Re-exported by models/index.ts.
// Recovery codes live with the User model in models/index.ts (main's MFA, P11).

export class OrganizationSetting extends Model<InferAttributes<OrganizationSetting>, InferCreationAttributes<OrganizationSetting>> {
  declare id: CreationOptional<number>;
  declare name: CreationOptional<string>;
  declare logoUrl: CreationOptional<string | null>;
  declare timezone: CreationOptional<string>;
  declare workingDays: CreationOptional<number[]>;
  declare senderName: CreationOptional<string | null>;
  declare senderEmail: CreationOptional<string | null>;
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
    senderName: { type: DataTypes.STRING(120), allowNull: true },
    senderEmail: { type: DataTypes.STRING(254), allowNull: true },
    updatedBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "organization_settings" },
);
