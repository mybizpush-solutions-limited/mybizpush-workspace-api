import { Op, QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { redis } from "../../redis/client";
import { Activity, CLOSED_TASK_STATUSES, Meeting, Notification, Product, Project, REVIEW_TASK_STATUSES, Task, User } from "../../models";
import { productsService } from "../products/products.service";
import { grantsFor } from "../access/engine";
import { projectsWith } from "../access/reach";
import { announcementsService } from "../announcements/announcements.service";
import { chatUnreadTotal } from "../chat/chat.service";

// Home, workspace switcher and badges (API-CHANGES A108, HOME-01, SYS-02).
// Everything is scoped to the caller and, when given, to one product.

const RECENT_KEY = (userId: string) => `contexts:recent:${userId}`;

export interface WorkspaceContext {
  type: "organization" | "product";
  id: string | null;
  name: string;
  logoUrl: string | null;
  tint: string | null;
  roles: string[]; // role names the user holds here
}

async function projectIdsIn(productId: string | undefined): Promise<string[] | null> {
  if (!productId) return null; // no filter
  return (await Project.findAll({ where: { productId }, attributes: ["id"] })).map((p) => p.id);
}

async function assignedTaskIds(userId: string): Promise<string[]> {
  const rows = await sequelize.query<{ task_id: string }>(`SELECT task_id FROM task_assignees WHERE user_id = :userId`, {
    replacements: { userId },
    type: QueryTypes.SELECT,
  });
  return rows.map((r) => r.task_id);
}

// My own open work: not closed, not a draft, and not sitting with a reviewer.
const myOpenStatus = { [Op.notIn]: [...CLOSED_TASK_STATUSES, ...REVIEW_TASK_STATUSES, "draft"] };

// Waiting on me: I'm the named reviewer, or nobody is named and I can approve in
// that project. A task with a named reviewer belongs to them alone.
function awaitingReview(userId: string, approvable: "all" | string[]) {
  return {
    status: REVIEW_TASK_STATUSES,
    [Op.or]: [{ reviewerId: userId }, { reviewerId: null, ...(approvable === "all" ? {} : { projectId: approvable }) }],
  };
}

function intersect(ids: string[] | "all", within: string[] | null): string[] | "all" {
  if (!within) return ids;
  if (ids === "all") return within;
  const set = new Set(within);
  return ids.filter((i) => set.has(i));
}

const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

export const homeService = {
  async contexts(userId: string): Promise<{ current: WorkspaceContext[]; recent: { type: string; id: string | null }[] }> {
    const { grants } = await grantsFor(userId);
    const products = await productsService.forUser(userId);
    const rolesAt = (type: string, id: string | null) => [...new Set(grants.filter((g) => g.scope.type === type && (g.scope.id ?? null) === id).map((g) => g.roleName))];
    const org: WorkspaceContext = { type: "organization", id: null, name: "MyBizPush", logoUrl: null, tint: null, roles: rolesAt("organization", null) };
    const productContexts: WorkspaceContext[] = products.map((p) => {
      const title = p.members.find((m) => m.userId === userId)?.title;
      const roles = rolesAt("product", p.id);
      return { type: "product", id: p.id, name: p.name, logoUrl: p.logoUrl, tint: p.tint, roles: roles.length ? roles : title ? [title] : ["Member"] };
    });
    const recentRaw = await redis.lrange(RECENT_KEY(userId), 0, 4);
    const recent = recentRaw.map((r) => JSON.parse(r) as { type: string; id: string | null });
    return { current: [...productContexts, org], recent };
  },

  async rememberContext(userId: string, ctx: { type: string; id: string | null }): Promise<void> {
    const value = JSON.stringify(ctx);
    await redis.lrem(RECENT_KEY(userId), 0, value);
    await redis.lpush(RECENT_KEY(userId), value);
    await redis.ltrim(RECENT_KEY(userId), 0, 9);
  },

  async badges(userId: string) {
    const [mine, approvable, notifications, meetings, chat] = await Promise.all([
      assignedTaskIds(userId),
      projectsWith(userId, "task.approve"),
      Notification.count({ where: { userId, read: false } }),
      this.meetingsToday(userId),
      chatUnreadTotal(userId),
    ]);
    const myOpen = mine.length ? await Task.count({ where: { id: mine, status: myOpenStatus } }) : 0;
    const toApprove = await Task.count({ where: awaitingReview(userId, approvable) });
    return { tasks: myOpen + toApprove, notifications, calendar: meetings.length, chat };
  },

  async meetingsToday(userId: string) {
    return Meeting.findAll({
      where: { startsAt: { [Op.gte]: startOfDay(), [Op.lt]: endOfDay() }, status: { [Op.ne]: "cancelled" } },
      include: [{ model: User, as: "attendees", attributes: ["id"], where: { id: userId }, through: { attributes: [], where: { rsvp: { [Op.ne]: "declined" } } } }],
      order: [["startsAt", "ASC"]],
    });
  },

  // HOME-01: stats, needs-your-attention and recent activity, optionally
  // narrowed to one product.
  async dashboard(userId: string, productId?: string) {
    const scopeProjects = await projectIdsIn(productId);
    const inScope = scopeProjects ? { projectId: scopeProjects } : {};
    const mine = await assignedTaskIds(userId);
    const approvable = intersect(await projectsWith(userId, "task.approve"), scopeProjects);
    const now = new Date();

    const pendingAcks = await announcementsService.pendingAcknowledgements(userId);
    const invites = await Meeting.findAll({
      where: { status: "scheduled", startsAt: { [Op.gte]: new Date() } },
      attributes: ["id", "title", "startsAt"],
      include: [{ model: User, as: "attendees", attributes: ["id"], where: { id: userId }, through: { attributes: [], where: { rsvp: "pending" } } }],
      order: [["startsAt", "ASC"]],
      limit: 5,
    });
    const [myOpen, toApprove, overdue, dueToday, meetings, unread, activity] = await Promise.all([
      mine.length ? Task.count({ where: { id: mine, status: myOpenStatus, ...inScope } }) : 0,
      Task.findAll({
        where: { ...awaitingReview(userId, approvable), ...inScope },
        attributes: ["id", "title", "projectId", "dueDate", "updatedAt"],
        order: [["updatedAt", "DESC"]],
        limit: 10,
      }),
      mine.length
        ? Task.findAll({ where: { id: mine, status: myOpenStatus, dueDate: { [Op.lt]: startOfDay(now) }, ...inScope }, attributes: ["id", "title", "projectId", "dueDate"], limit: 10 })
        : [],
      mine.length
        ? Task.findAll({ where: { id: mine, status: myOpenStatus, dueDate: { [Op.gte]: startOfDay(now), [Op.lt]: endOfDay(now) }, ...inScope }, attributes: ["id", "title", "projectId", "dueDate"], limit: 10 })
        : [],
      this.meetingsToday(userId),
      Notification.count({ where: { userId, read: false } }),
      Activity.findAll({ order: [["createdAt", "DESC"]], limit: 15 }),
    ]);

    const projectNames = new Map(
      (await Project.findAll({ attributes: ["id", "name"], where: { id: [...new Set([...toApprove, ...overdue, ...dueToday].map((t) => t.projectId))] } })).map((p) => [p.id, p.name]),
    );

    const attention = [
      ...invites.map((m) => ({ kind: "rsvp" as const, itemType: "meeting", itemId: m.id, title: m.title, meta: m.startsAt.toISOString(), dueAt: m.startsAt.toISOString() })),
      ...pendingAcks.map((a) => ({ kind: "announcement" as const, itemType: "announcement", itemId: a.id, title: a.title, meta: "", dueAt: null })),
      ...toApprove.map((t) => ({ kind: "approval" as const, itemType: "task", itemId: t.id, title: t.title, meta: projectNames.get(t.projectId) ?? "", dueAt: t.dueDate?.toISOString() ?? null })),
      ...meetings
        .filter((m) => m.startsAt > now)
        .map((m) => ({ kind: "meeting" as const, itemType: "meeting", itemId: m.id, title: m.title, meta: m.startsAt.toISOString(), dueAt: m.startsAt.toISOString() })),
      ...overdue.map((t) => ({ kind: "overdue" as const, itemType: "task", itemId: t.id, title: t.title, meta: projectNames.get(t.projectId) ?? "", dueAt: t.dueDate?.toISOString() ?? null })),
      ...dueToday.map((t) => ({ kind: "due_today" as const, itemType: "task", itemId: t.id, title: t.title, meta: projectNames.get(t.projectId) ?? "", dueAt: t.dueDate?.toISOString() ?? null })),
    ];

    // Activity on items in scope only.
    const scopedTaskIds = scopeProjects ? new Set((await Task.findAll({ where: { projectId: scopeProjects }, attributes: ["id"] })).map((t) => t.id)) : null;
    const recent = activity
      .filter((a) => !scopedTaskIds || scopedTaskIds.has(a.itemId))
      .slice(0, 8)
      .map((a) => ({ id: a.id, kind: a.kind, itemId: a.itemId, itemType: a.itemType, actorId: a.actorId, createdAt: a.createdAt.toISOString() }));

    const product = productId ? await Product.findByPk(productId, { attributes: ["id", "name"] }) : null;
    return {
      context: product ? { type: "product", id: product.id, name: product.name } : { type: "organization", id: null, name: "MyBizPush" },
      stats: { myTasks: myOpen, toApprove: toApprove.length, meetings: meetings.length, unread },
      attention,
      activity: recent,
    };
  },
};
