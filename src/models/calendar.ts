import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../db/sequelize";

// Calendar and meetings (API-CHANGES A401 to A404). Re-exported by models/index.ts.

export const MEETING_TYPES = ["standup", "one_on_one", "review", "planning", "client", "training", "all_hands", "other"] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];
export const MEETING_STATUSES = ["scheduled", "cancelled", "completed"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];
export const MEETING_SCOPES = ["organization", "department", "team", "product", "project"] as const;
export type MeetingScope = (typeof MEETING_SCOPES)[number];
export const LOCATION_TYPES = ["online", "in_person", "hybrid"] as const;
export const RSVP_RESPONSES = ["pending", "accepted", "tentative", "declined"] as const;
export type RsvpResponse = (typeof RSVP_RESPONSES)[number];
export const ATTENDANCE_STATUSES = ["unknown", "present", "late", "absent"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

// One person on a meeting. Also the through table for Meeting.attendees, so the
// original setAttendees calls keep working and new rows start as pending.
export class MeetingAttendee extends Model<InferAttributes<MeetingAttendee>, InferCreationAttributes<MeetingAttendee>> {
  declare id: CreationOptional<string>;
  declare meetingId: string;
  declare userId: string;
  declare rsvp: CreationOptional<RsvpResponse>;
  declare rsvpNote: CreationOptional<string | null>;
  declare respondedAt: CreationOptional<Date | null>;
  declare attendance: CreationOptional<AttendanceStatus>;
  declare attendanceMarkedBy: CreationOptional<string | null>;
  declare updatedAt: CreationOptional<Date>;
}
MeetingAttendee.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, unique: true },
    meetingId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    rsvp: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "pending" },
    rsvpNote: { type: DataTypes.STRING(500), allowNull: true },
    respondedAt: { type: DataTypes.DATE, allowNull: true },
    attendance: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "unknown" },
    attendanceMarkedBy: { type: DataTypes.UUID, allowNull: true },
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "meeting_attendees", createdAt: false },
);

export class MeetingNote extends Model<InferAttributes<MeetingNote>, InferCreationAttributes<MeetingNote>> {
  declare id: CreationOptional<string>;
  declare meetingId: string;
  declare kind: CreationOptional<"note" | "decision">;
  declare body: string;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
MeetingNote.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    meetingId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "note" },
    body: { type: DataTypes.TEXT, allowNull: false },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "meeting_notes" },
);

export class MeetingActionItem extends Model<InferAttributes<MeetingActionItem>, InferCreationAttributes<MeetingActionItem>> {
  declare id: CreationOptional<string>;
  declare meetingId: string;
  declare title: string;
  declare description: CreationOptional<string>;
  declare ownerId: CreationOptional<string | null>;
  declare dueDate: CreationOptional<Date | null>;
  declare status: CreationOptional<"open" | "done" | "converted">;
  declare taskId: CreationOptional<string | null>;
  declare createdBy: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
MeetingActionItem.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    meetingId: { type: DataTypes.UUID, allowNull: false },
    title: { type: DataTypes.STRING(300), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    ownerId: { type: DataTypes.UUID, allowNull: true },
    dueDate: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "open" },
    taskId: { type: DataTypes.UUID, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "meeting_action_items" },
);

export class CalendarEvent extends Model<InferAttributes<CalendarEvent>, InferCreationAttributes<CalendarEvent>> {
  declare id: CreationOptional<string>;
  declare title: string;
  declare description: CreationOptional<string>;
  declare scopeType: MeetingScope;
  declare scopeId: CreationOptional<string | null>;
  declare allDay: CreationOptional<boolean>;
  declare startsAt: Date;
  declare endsAt: Date;
  declare location: CreationOptional<string | null>;
  declare createdBy: CreationOptional<string | null>;
  declare cancelledAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
CalendarEvent.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    title: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    scopeType: { type: DataTypes.STRING(14), allowNull: false },
    scopeId: { type: DataTypes.UUID, allowNull: true },
    allDay: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    startsAt: { type: DataTypes.DATE, allowNull: false },
    endsAt: { type: DataTypes.DATE, allowNull: false },
    location: { type: DataTypes.STRING(300), allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
    cancelledAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: "calendar_events" },
);
