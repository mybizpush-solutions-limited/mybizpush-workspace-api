import { QueryTypes, Op } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { notFound } from "../../lib/errors";
import { isOrgManager, User } from "../../models";
import { can } from "./engine";
import { projectsInReach, reachFor } from "./reach";
import { isUuid, RECORD_KINDS, visibleCalendarEventsSql, visibleIdsSql, visibleItemsCondition, type RecordKind, type Viewer } from "./visibility.rules";

// The one place that decides whether someone can see a record (API-CHANGES A1001).
// Anyone with no connection gets 404, so a record's existence isn't revealed. Reads,
// writes, search, reports, the assistant and offline sync all come through here.

export { myScopesSql, inMyScopesSql, type RecordKind, type Viewer } from "./visibility.rules";

export async function viewerFor(userId: string): Promise<Viewer> {
  const [user, assign, approve, taskView, publish, reports, content, campaigns, productEdit, queryView, hrView] = await Promise.all([
    User.findByPk(userId, { attributes: ["accessLevel"] }),
    reachFor(userId, "task.assign"),
    reachFor(userId, "task.approve"),
    reachFor(userId, "task.view"),
    reachFor(userId, "announcement.publish"),
    reachFor(userId, "report.view"),
    reachFor(userId, "content.create"),
    reachFor(userId, "campaign.view"),
    reachFor(userId, "product.edit"),
    can({ sub: userId }, "query.view"),
    can({ sub: userId }, "hr.view"),
  ]);
  const [assignProjects, approveProjects] = await Promise.all([projectsInReach(userId, "task.assign", assign), projectsInReach(userId, "task.approve", approve)]);
  // A denial on one product takes that product out.
  let taskViewProducts = taskView.products;
  if (taskView.hasScopedDeny) {
    const kept = await Promise.all(taskViewProducts.map(async (id) => ((await can({ sub: userId }, "task.view", { type: "product", id })) ? id : null)));
    taskViewProducts = kept.filter((x): x is string => !!x);
  }
  return {
    userId,
    seesEverything: !!user && isOrgManager(user.accessLevel),
    workProjects: assignProjects === "all" || approveProjects === "all" ? "all" : [...new Set([...assignProjects, ...approveProjects])],
    taskViewProducts,
    seesAllQueries: queryView || hrView,
    hrView,
    announcementPublish: publish,
    targetReports: reports,
    contentCreate: content,
    campaignView: campaigns,
    productEdit,
  };
}

export const isRecordKind = (kind: string): kind is RecordKind => (RECORD_KINDS as readonly string[]).includes(kind);

// For where: { id: visibleIds(viewer, "task") }.
export const visibleIds = (v: Viewer, kind: RecordKind) => ({ [Op.in]: sequelize.literal(`(${visibleIdsSql(v, kind)})`) });

export const visibleItemsWhere = (v: Viewer, table: string) => sequelize.literal(visibleItemsCondition(v, `${table}.item_type`, `${table}.item_id`));

export async function canSeeRecord(userId: string, kind: string, id: string, viewer?: Viewer): Promise<boolean> {
  if (!isRecordKind(kind) || !isUuid(id)) return false;
  const v = viewer ?? (await viewerFor(userId));
  const rows = await sequelize.query(`SELECT 1 FROM (${visibleIdsSql(v, kind)}) x WHERE x.id = :id LIMIT 1`, { replacements: { id }, type: QueryTypes.SELECT });
  return rows.length > 0;
}

export async function assertCanSeeRecord(userId: string, kind: string, id: string, viewer?: Viewer): Promise<void> {
  if (!(await canSeeRecord(userId, kind, id, viewer))) throw notFound(`${kind} not found`);
}

// Which of these people can see a record, for deciding who gets told about it.
export async function canSeeAll(userIds: string[], kind: string, id: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const uid of new Set(userIds)) if (await canSeeRecord(uid, kind, id)) out.add(uid);
  return out;
}

const TABLE: Record<RecordKind, string> = {
  task: "tasks",
  issue: "issues",
  meeting: "meetings",
  announcement: "announcements",
  query: "staff_queries",
  appraisal: "appraisals",
  target: "targets",
  content: "content_items",
  campaign: "campaigns",
  conversation: "conversations",
  message: "messages",
  project: "projects",
  product: "products",
};

export async function recordExists(kind: string, id: string): Promise<boolean> {
  if (!isRecordKind(kind) || !isUuid(id)) return false;
  const rows = await sequelize.query(`SELECT 1 FROM ${TABLE[kind]} WHERE id = :id LIMIT 1`, { replacements: { id }, type: QueryTypes.SELECT });
  return rows.length > 0;
}

// When a caller only has an id and not its kind (GET /comments?itemId=).
export async function canSeeAnyRecord(userId: string, id: string, viewer?: Viewer): Promise<boolean> {
  if (!isUuid(id)) return false;
  const v = viewer ?? (await viewerFor(userId));
  const union = RECORD_KINDS.map((k) => `SELECT 1 FROM (${visibleIdsSql(v, k)}) x${k} WHERE x${k}.id = :id`).join(" UNION ALL ");
  const rows = await sequelize.query(`${union} LIMIT 1`, { replacements: { id }, type: QueryTypes.SELECT });
  return rows.length > 0;
}

export async function assertCanSeeCalendarEvent(userId: string, id: string): Promise<void> {
  const rows = isUuid(id) ? await sequelize.query(`SELECT 1 FROM (${visibleCalendarEventsSql(await viewerFor(userId))}) x WHERE x.id = :id LIMIT 1`, { replacements: { id }, type: QueryTypes.SELECT }) : [];
  if (!rows.length) throw notFound("Event not found");
}

// Staff details only those with a reason should see.
export async function seesPrivateStaffFields(viewerId: string): Promise<boolean> {
  const me = await User.findByPk(viewerId, { attributes: ["accessLevel"] });
  if (me && isOrgManager(me.accessLevel)) return true;
  return (await can({ sub: viewerId }, "staff.edit")) || (await can({ sub: viewerId }, "hr.view"));
}

export function maskStaff<T extends { id: string; phone: string | null; secondaryEmail: string | null; employeeId: string | null; dateJoined: string | null }>(user: T, viewerId: string, privileged: boolean): T {
  if (privileged || user.id === viewerId) return user;
  return { ...user, phone: null, secondaryEmail: null, employeeId: null, dateJoined: null };
}
