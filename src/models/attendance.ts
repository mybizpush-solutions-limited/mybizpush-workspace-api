import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db/sequelize";

// Office attendance by QR code. Re-exported by models/index.ts.

export const WORK_MODES = ["onsite", "remote", "hybrid"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const ATTENDANCE_STATUSES_DAILY = ["present", "late"] as const;
export type DailyAttendanceStatus = (typeof ATTENDANCE_STATUSES_DAILY)[number];

export class Office extends Model<InferAttributes<Office>, InferCreationAttributes<Office>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare address: CreationOptional<string | null>;
  // Local time (organization time zone) after which a check-in counts as late.
  declare lateAfter: CreationOptional<string>;
  // HMAC key for the rotating check-in code. Never leaves the server.
  declare codeSecret: string;
  declare active: CreationOptional<boolean>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
Office.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    address: { type: DataTypes.STRING(300), allowNull: true },
    lateAfter: { type: DataTypes.STRING(5), allowNull: false, defaultValue: "09:15" },
    codeSecret: { type: DataTypes.STRING(64), allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "offices" },
);

export class AttendanceRecord extends Model<InferAttributes<AttendanceRecord>, InferCreationAttributes<AttendanceRecord>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare officeId: string;
  // The working day in the organization's time zone (YYYY-MM-DD).
  declare day: string;
  declare checkInAt: Date;
  declare checkOutAt: CreationOptional<Date | null>;
  declare status: DailyAttendanceStatus;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
AttendanceRecord.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    officeId: { type: DataTypes.UUID, allowNull: false },
    day: { type: DataTypes.DATEONLY, allowNull: false },
    checkInAt: { type: DataTypes.DATE, allowNull: false },
    checkOutAt: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.ENUM(...ATTENDANCE_STATUSES_DAILY), allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "attendance_records", indexes: [{ unique: true, fields: ["user_id", "day"] }] },
);
