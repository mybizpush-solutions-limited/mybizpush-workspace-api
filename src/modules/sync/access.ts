import { DataTypes, Model, QueryTypes, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { inMyScopesSql, type Viewer } from "../access/visibility";
import { diffAccess, visibleCommentsSql, visibleEmailLinksSql, visibleIdsSql } from "../access/visibility.rules";

// Telling devices when someone loses or gains sight of a record (API-CHANGES A1002).
//
// Nothing about the record itself changes when, say, someone is taken off a project,
// so its updated_at can't carry the news. Each pull compares what the person can see
// now with what was last recorded, and notes any change with the time. A device then
// asks only "what changed since my cursor", so every device hears, whenever it next
// connects, and a change seen by one device isn't used up.

export class SyncRecordAccess extends Model<InferAttributes<SyncRecordAccess>, InferCreationAttributes<SyncRecordAccess>> {
  declare userId: string;
  declare collection: string;
  declare recordId: string;
  declare granted: boolean;
  declare changedAt: CreationOptional<Date>;
}
SyncRecordAccess.init(
  {
    userId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    collection: { type: DataTypes.STRING(40), allowNull: false, primaryKey: true },
    recordId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
    granted: { type: DataTypes.BOOLEAN, allowNull: false },
    changedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: "sync_record_access", timestamps: false },
);

export interface TrackedCollection {
  collection: string;
  table: string;
  // The ids this person's devices should hold. For targets and appraisals that's their
  // own, as it always was: someone reporting on them reads them online and they aren't
  // copied to that person's phone.
  visible: (v: Viewer) => string;
  children: { collection: string; table: string; fk: string }[];
}

const NOT_REPORTING = { organization: false, products: [], departments: [], teams: [], projects: [] };

export const TRACKED: TrackedCollection[] = [
  {
    collection: "tasks",
    table: "tasks",
    visible: (v) => visibleIdsSql(v, "task"),
    children: [
      { collection: "taskSubmissions", table: "task_submissions", fk: "task_id" },
      { collection: "taskReviews", table: "task_reviews", fk: "task_id" },
      { collection: "taskStatusHistory", table: "task_status_history", fk: "task_id" },
    ],
  },
  { collection: "issues", table: "issues", visible: (v) => visibleIdsSql(v, "issue"), children: [] },
  {
    collection: "meetings",
    table: "meetings",
    visible: (v) => visibleIdsSql(v, "meeting"),
    children: [
      { collection: "meetingAttendees", table: "meeting_attendees", fk: "meeting_id" },
      { collection: "meetingNotes", table: "meeting_notes", fk: "meeting_id" },
      { collection: "meetingActionItems", table: "meeting_action_items", fk: "meeting_id" },
    ],
  },
  { collection: "contentItems", table: "content_items", visible: (v) => visibleIdsSql(v, "content"), children: [{ collection: "contentEvents", table: "content_events", fk: "content_id" }] },
  {
    collection: "targets",
    table: "targets",
    visible: (v) => visibleIdsSql({ ...v, targetReports: NOT_REPORTING }, "target"),
    children: [{ collection: "targetProgress", table: "target_progress", fk: "target_id" }],
  },
  { collection: "staffQueries", table: "staff_queries", visible: (v) => visibleIdsSql(v, "query"), children: [] },
  { collection: "appraisals", table: "appraisals", visible: (v) => visibleIdsSql({ ...v, hrView: false }, "appraisal"), children: [] },
  { collection: "calendarEvents", table: "calendar_events", visible: (v) => `SELECT e.id FROM calendar_events e WHERE ${inMyScopesSql(v.userId, "e")}`, children: [] },
  // Comments and linked emails can hang off several kinds of record, so each is compared
  // directly rather than through its parent.
  { collection: "comments", table: "comments", visible: visibleCommentsSql, children: [] },
  { collection: "emailThreadLinks", table: "email_thread_links", visible: visibleEmailLinksSql, children: [] },
];

const EPOCH = new Date(0);
const ids = async (sql: string, replacements: Record<string, unknown> = {}) => (await sequelize.query<{ id: string }>(sql, { replacements, type: QueryTypes.SELECT })).map((r) => r.id);

// Brings the record of who could see what up to date, then returns it.
export async function reconcile(t: TrackedCollection, v: Viewer): Promise<SyncRecordAccess[]> {
  const [current, rows] = await Promise.all([ids(t.visible(v)), SyncRecordAccess.findAll({ where: { userId: v.userId, collection: t.collection } })]);
  const now = new Date();

  if (!rows.length) {
    // The first time for this person. Their devices may hold copies from before these
    // rules, so everything they can't see is marked as lost. What they can see is
    // back-dated: they already have it, or a first sync will bring it.
    const visible = new Set(current);
    const all = await ids(`SELECT id FROM ${t.table}`);
    const created = all.map((recordId) => ({ userId: v.userId, collection: t.collection, recordId, granted: visible.has(recordId), changedAt: visible.has(recordId) ? EPOCH : now }));
    if (created.length) await SyncRecordAccess.bulkCreate(created, { ignoreDuplicates: true });
    return SyncRecordAccess.findAll({ where: { userId: v.userId, collection: t.collection } });
  }

  const { granted, revoked } = diffAccess(new Set(current), new Map(rows.map((r) => [r.recordId, r.granted])));
  const changes = [...granted.map((recordId) => ({ recordId, granted: true })), ...revoked.map((recordId) => ({ recordId, granted: false }))];
  if (changes.length) {
    await SyncRecordAccess.bulkCreate(
      changes.map((c) => ({ userId: v.userId, collection: t.collection, recordId: c.recordId, granted: c.granted, changedAt: now })),
      { updateOnDuplicate: ["granted", "changedAt"] },
    );
    const byId = new Map(changes.map((c) => [c.recordId, c.granted]));
    for (const r of rows) {
      if (byId.has(r.recordId)) {
        r.granted = byId.get(r.recordId)!;
        r.changedAt = now;
      }
    }
    const known = new Set(rows.map((r) => r.recordId));
    for (const recordId of granted) {
      if (!known.has(recordId)) rows.push(SyncRecordAccess.build({ userId: v.userId, collection: t.collection, recordId, granted: true, changedAt: now }));
    }
  }
  return rows;
}

export const changesSince = (rows: SyncRecordAccess[], since: Date) => {
  const recent = rows.filter((r) => r.changedAt > since);
  return { granted: recent.filter((r) => r.granted).map((r) => r.recordId), revoked: recent.filter((r) => !r.granted).map((r) => r.recordId) };
};

// Ids of the rows hanging off these records, for telling a device to drop them.
export async function childIds(table: string, fk: string, parents: string[]): Promise<string[]> {
  if (!parents.length) return [];
  return ids(`SELECT id FROM ${table} WHERE ${fk} IN (:parents)`, { parents });
}
