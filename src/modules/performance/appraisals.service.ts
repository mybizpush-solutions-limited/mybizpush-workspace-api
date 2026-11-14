import { Op, QueryTypes, type WhereOptions } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { audit } from "../../lib/audit";
import { AppError, forbidden, notFound } from "../../lib/errors";
import { Appraisal, AppraisalCycle, User } from "../../models";
import { can } from "../access/engine";
import type { GroupRef } from "../groups/groups.merge";
import { groupsService } from "../groups/groups.service";
import { notify } from "../shared/events";
import { syncHint } from "../shared/live";

// Appraisals (API-CHANGES A503, PRD 13.4). The manager's assessment stays hidden
// from the person until it's complete.

const SYNC = ["appraisals", "appraisalCycles"];
type Req = Parameters<typeof audit>[0]["req"];

export function serializeCycle(c: AppraisalCycle) {
  return {
    id: c.id,
    name: c.name,
    startDate: c.startDate,
    endDate: c.endDate,
    selfDueAt: c.selfDueAt?.toISOString() ?? null,
    managerDueAt: c.managerDueAt?.toISOString() ?? null,
    status: c.status,
    areas: c.areas,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// `viewerId` decides whether the manager's part is included.
export function serializeAppraisal(a: Appraisal, viewerId: string) {
  const hideManager = a.userId === viewerId && a.status !== "completed";
  return {
    id: a.id,
    cycleId: a.cycleId,
    userId: a.userId,
    managerId: a.managerId ?? null,
    status: a.status,
    selfRatings: a.selfRatings,
    selfComments: a.selfComments,
    selfSubmittedAt: a.selfSubmittedAt?.toISOString() ?? null,
    evidence: a.evidence,
    managerRatings: hideManager ? {} : a.managerRatings,
    managerFeedback: hideManager ? "" : a.managerFeedback,
    overallRating: hideManager ? null : (a.overallRating ?? null),
    managerSubmittedAt: hideManager ? null : (a.managerSubmittedAt?.toISOString() ?? null),
    stats: a.stats,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

async function requireHrEdit(userId: string): Promise<void> {
  if (!(await can({ sub: userId }, "hr.edit"))) throw forbidden("You can't manage appraisal cycles");
}

export async function statsFor(userId: string, startDate: string, endDate: string): Promise<Record<string, number>> {
  const [tasks] = await sequelize.query<{ completed: string; overdue: string; revisions: string }>(
    `SELECT COUNT(*) FILTER (WHERE t.status IN ('approved','done') AND t.completed_at >= :start AND t.completed_at < (:end::date + INTERVAL '1 day')) AS completed,
            COUNT(*) FILTER (WHERE t.status NOT IN ('approved','done','rejected','cancelled','draft') AND t.due_date < (:end::date + INTERVAL '1 day')) AS overdue,
            COALESCE(SUM(t.revision_count) FILTER (WHERE t.created_at < (:end::date + INTERVAL '1 day')), 0) AS revisions
       FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id WHERE ta.user_id = :userId`,
    { replacements: { userId, start: startDate, end: endDate }, type: QueryTypes.SELECT },
  );
  const [targets] = await sequelize.query<{ total: string; achieved: string }>(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE t.status = 'achieved') AS achieved
       FROM targets t JOIN target_assignments a ON a.target_id = t.id
      WHERE a.user_id = :userId AND t.status <> 'cancelled' AND t.end_date >= :start AND t.start_date <= :end`,
    { replacements: { userId, start: startDate, end: endDate }, type: QueryTypes.SELECT },
  );
  return {
    tasksCompleted: Number(tasks?.completed ?? 0),
    tasksOverdue: Number(tasks?.overdue ?? 0),
    revisions: Number(tasks?.revisions ?? 0),
    targetsAchieved: Number(targets?.achieved ?? 0),
    targetsTotal: Number(targets?.total ?? 0),
  };
}

async function loadVisible(id: string, userId: string): Promise<Appraisal> {
  const a = await Appraisal.findByPk(id);
  if (!a || !(a.userId === userId || a.managerId === userId || (await can({ sub: userId }, "hr.view")))) throw notFound("Appraisal not found");
  return a;
}

const hint = (a: Appraisal) => syncHint([a.userId, a.managerId], SYNC);

export const appraisalsService = {
  async cycles(userId: string) {
    const canSeeDrafts = await can({ sub: userId }, "hr.edit");
    const rows = await AppraisalCycle.findAll({ where: canSeeDrafts ? {} : { status: { [Op.ne]: "draft" } }, order: [["startDate", "DESC"]] });
    return rows.map(serializeCycle);
  },

  async createCycle(input: { id?: string; name: string; startDate: string; endDate: string; selfDueAt?: string; managerDueAt?: string; areas: { key: string; label: string }[] }, userId: string) {
    await requireHrEdit(userId);
    const c = await AppraisalCycle.create({
      ...(input.id ? { id: input.id } : {}),
      name: input.name,
      startDate: input.startDate,
      endDate: input.endDate,
      selfDueAt: input.selfDueAt ? new Date(input.selfDueAt) : null,
      managerDueAt: input.managerDueAt ? new Date(input.managerDueAt) : null,
      areas: input.areas,
      createdBy: userId,
    });
    return serializeCycle(c);
  },

  async updateCycle(id: string, patch: Partial<{ name: string; startDate: string; endDate: string; selfDueAt: string | null; managerDueAt: string | null; areas: { key: string; label: string }[] }>, userId: string) {
    await requireHrEdit(userId);
    const c = await AppraisalCycle.findByPk(id);
    if (!c) throw notFound("Cycle not found");
    await c.update({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
      ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
      ...(patch.selfDueAt !== undefined ? { selfDueAt: patch.selfDueAt ? new Date(patch.selfDueAt) : null } : {}),
      ...(patch.managerDueAt !== undefined ? { managerDueAt: patch.managerDueAt ? new Date(patch.managerDueAt) : null } : {}),
      ...(patch.areas !== undefined ? { areas: patch.areas } : {}),
    });
    return serializeCycle(c);
  },

  async openCycle(id: string, input: { userIds?: string[]; groups?: GroupRef[] }, userId: string, req?: Req) {
    await requireHrEdit(userId);
    const c = await AppraisalCycle.findByPk(id);
    if (!c) throw notFound("Cycle not found");
    if (c.status === "closed") throw new AppError(409, "This cycle is closed", "closed");
    const fromGroups = input.groups?.length ? await groupsService.expandIds(input.groups) : [];
    const named = [...(input.userIds ?? []), ...fromGroups];
    const people = await User.findAll({
      where: named.length ? { id: named, status: "active" } : { status: "active" },
      attributes: ["id", "reportsToId"],
    });
    let created = 0;
    for (const p of people) {
      const [row, isNew] = await Appraisal.findOrCreate({ where: { cycleId: id, userId: p.id }, defaults: { cycleId: id, userId: p.id, managerId: p.reportsToId ?? null } });
      if (isNew) {
        created++;
        await notify({ userId: p.id, fromUserId: userId, kind: "appraisal", itemId: row.id, itemType: "appraisal", message: `Your self assessment for ${c.name} is open` });
        hint(row);
      }
    }
    await c.update({ status: "open" });
    await audit({ req, actorId: userId, action: "appraisal.cycle.open", target: { type: "appraisal_cycle", id }, after: { created } });
    return { cycle: serializeCycle(c), created };
  },

  async closeCycle(id: string, userId: string, req?: Req) {
    await requireHrEdit(userId);
    const c = await AppraisalCycle.findByPk(id);
    if (!c) throw notFound("Cycle not found");
    await c.update({ status: "closed" });
    await audit({ req, actorId: userId, action: "appraisal.cycle.close", target: { type: "appraisal_cycle", id } });
    return serializeCycle(c);
  },

  async list(userId: string, q: { segment?: "mine" | "team" | "all"; cycleId?: string; status?: string }) {
    const segment = q.segment ?? "mine";
    const where: Record<string, unknown> = {};
    if (segment === "mine") where.userId = userId;
    else if (segment === "team") where.managerId = userId;
    else if (!(await can({ sub: userId }, "hr.view"))) throw forbidden("You can't see every appraisal");
    if (q.cycleId) where.cycleId = q.cycleId;
    if (q.status) where.status = q.status;
    const rows = await Appraisal.findAll({ where: where as WhereOptions, order: [["updatedAt", "DESC"]], limit: 500 });
    return rows.map((a) => serializeAppraisal(a, userId));
  },

  async get(id: string, userId: string) {
    return serializeAppraisal(await loadVisible(id, userId), userId);
  },

  async saveSelf(id: string, input: { ratings: Record<string, number>; comments?: string; evidence?: { title?: string; url: string }[]; submit?: boolean }, userId: string) {
    const a = await loadVisible(id, userId);
    if (a.userId !== userId) throw forbidden("Only the person being appraised can do this");
    if (a.status !== "pending_self") throw new AppError(409, "Your self assessment is already in", "already_submitted");
    const cycle = await AppraisalCycle.findByPk(a.cycleId);
    if (cycle?.status !== "open") throw new AppError(409, "This cycle isn't open", "closed");
    await a.update({
      selfRatings: input.ratings,
      ...(input.comments !== undefined ? { selfComments: input.comments } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      ...(input.submit
        ? { status: "pending_manager" as const, selfSubmittedAt: new Date(), stats: await statsFor(a.userId, cycle.startDate, cycle.endDate) }
        : {}),
    });
    if (input.submit && a.managerId) {
      await notify({ userId: a.managerId, fromUserId: userId, kind: "appraisal", itemId: a.id, itemType: "appraisal", message: "A self assessment is ready for your review" });
    }
    hint(a);
    return serializeAppraisal(a, userId);
  },

  async saveManager(id: string, input: { ratings: Record<string, number>; feedback?: string; overallRating?: number; submit?: boolean }, userId: string, req?: Req) {
    const a = await Appraisal.findByPk(id);
    if (!a) throw notFound("Appraisal not found");
    if (a.managerId !== userId && !(await can({ sub: userId }, "hr.edit"))) throw notFound("Appraisal not found");
    if (a.userId === userId) throw forbidden("You can't review your own appraisal");
    if (a.status !== "pending_manager") throw new AppError(409, "This appraisal isn't waiting for a manager review", "not_ready");
    const cycle = await AppraisalCycle.findByPk(a.cycleId);
    await a.update({
      managerRatings: input.ratings,
      ...(input.feedback !== undefined ? { managerFeedback: input.feedback } : {}),
      ...(input.overallRating !== undefined ? { overallRating: input.overallRating } : {}),
      ...(input.submit
        ? { status: "completed" as const, managerSubmittedAt: new Date(), stats: cycle ? await statsFor(a.userId, cycle.startDate, cycle.endDate) : a.stats }
        : {}),
    });
    if (input.submit) {
      await audit({ req, actorId: userId, action: "appraisal.complete", target: { type: "appraisal", id }, after: { userId: a.userId } });
      await notify({ userId: a.userId, fromUserId: userId, kind: "appraisal", itemId: a.id, itemType: "appraisal", message: "Your appraisal is complete" });
    }
    hint(a);
    return serializeAppraisal(a, userId);
  },
};
