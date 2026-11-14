import { Op, QueryTypes, type WhereOptions } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { audit } from "../../lib/audit";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors";
import { Target, TargetAssignment, TargetProgress, Team, type TargetOwnerType, type TargetSource, type TargetStatus } from "../../models";
import { can } from "../access/engine";
import type { Scope } from "../access/catalog";
import { canOverUser, reachFor } from "../access/reach";
import type { GroupType } from "../groups/groups.merge";
import { groupsService } from "../groups/groups.service";
import { notify } from "../shared/events";
import { syncHint } from "../shared/live";
import { isReached, nextTargetStatus, progressPercent, rollup } from "./target.calc";

// Targets with individual assignments and a recorded source for every change
// (API-CHANGES A502, PRD 13.1 to 13.3).

const SYNC = ["targets", "targetProgress"];
const today = () => new Date().toISOString().slice(0, 10);
type Req = Parameters<typeof audit>[0]["req"];

export function serializeTarget(t: Target) {
  const assignments = (t.get("assignments") as TargetAssignment[] | undefined) ?? [];
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    ownerType: t.ownerType,
    ownerId: t.ownerId,
    period: t.period,
    startDate: t.startDate,
    endDate: t.endDate,
    unit: t.unit,
    unitLabel: t.unitLabel ?? null,
    startValue: t.startValue,
    targetValue: t.targetValue,
    currentValue: t.currentValue,
    progressPercent: progressPercent(t.startValue, t.targetValue, t.currentValue),
    source: t.source,
    sourceConfig: t.sourceConfig,
    reviewerId: t.reviewerId ?? null,
    status: t.status,
    evaluation: t.evaluation ?? null,
    assignments: assignments.map((a) => ({ id: a.id, userId: a.userId, targetValue: a.targetValue, currentValue: a.currentValue })),
    createdBy: t.createdBy ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function serializeProgress(p: TargetProgress) {
  return {
    id: p.id,
    targetId: p.targetId,
    assignmentId: p.assignmentId ?? null,
    value: p.value,
    delta: p.delta,
    source: p.source,
    note: p.note ?? null,
    evidence: p.evidence,
    recordedBy: p.recordedBy ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const withAssignments = { include: [{ model: TargetAssignment, as: "assignments" }] };

async function load(id: string): Promise<Target> {
  const t = await Target.findByPk(id, withAssignments);
  if (!t) throw notFound("Target not found");
  return t;
}
async function reload(id: string) {
  return serializeTarget(await load(id));
}

const peopleOf = (t: Target) => ((t.get("assignments") as TargetAssignment[] | undefined) ?? []).map((a) => a.userId);
const hint = (t: Target) => syncHint([...peopleOf(t), t.reviewerId, t.createdBy], SYNC);

function ownerScope(t: { ownerType: TargetOwnerType; ownerId: string }): Scope | null {
  return t.ownerType === "user" ? null : { type: t.ownerType, id: t.ownerId };
}

// A permission over a target: on its group, or over the person who owns it.
async function canOnOwner(userId: string, permission: string, t: { ownerType: TargetOwnerType; ownerId: string }): Promise<boolean> {
  const scope = ownerScope(t);
  return scope ? can({ sub: userId }, permission, scope) : canOverUser(userId, permission, t.ownerId);
}

async function assertMaySee(t: Target, userId: string): Promise<void> {
  if (peopleOf(t).includes(userId) || t.reviewerId === userId || t.createdBy === userId) return;
  if (await canOnOwner(userId, "report.view", t)) return;
  throw forbidden("You can't see this target");
}

// Sets current values from the assignments and works out the resulting status.
async function settle(targetId: string, actorId: string | null): Promise<void> {
  const t = await load(targetId);
  const rows = (t.get("assignments") as TargetAssignment[] | undefined) ?? [];
  const currentValue = rollup(rows.map((a) => a.currentValue));
  const status = nextTargetStatus({
    status: t.status,
    evaluated: !!t.evaluation,
    start: t.startValue,
    target: t.targetValue,
    current: currentValue,
    endDate: t.endDate,
    today: today(),
  });
  const before = t.status;
  await t.update({ currentValue, status });
  if (status !== before && (status === "achieved" || status === "missed")) {
    for (const uid of new Set([...peopleOf(t), t.reviewerId, t.createdBy])) {
      if (uid) await notify({ userId: uid, fromUserId: actorId, kind: "target", itemId: t.id, itemType: "target", message: `Target ${status}: ${t.name}` });
    }
  }
  hint(t);
}

async function setAssignments(t: Target, actorId: string): Promise<void> {
  const people =
    t.ownerType === "user"
      ? [t.ownerId]
      : await groupsService.expandIds([{ type: t.ownerType as GroupType, id: t.ownerId }]);
  if (!people.length) throw badRequest("That group has nobody in it yet");
  for (const userId of people) {
    await TargetAssignment.findOrCreate({ where: { targetId: t.id, userId }, defaults: { targetId: t.id, userId, targetValue: t.targetValue, currentValue: t.startValue } });
    await notify({ userId, fromUserId: actorId, kind: "target", itemId: t.id, itemType: "target", message: `New target: ${t.name}` });
  }
}

export interface TargetInput {
  id?: string;
  name: string;
  description?: string;
  ownerType: TargetOwnerType;
  ownerId: string;
  period: Target["period"];
  startDate: string;
  endDate: string;
  unit: Target["unit"];
  unitLabel?: string | null;
  startValue?: number;
  targetValue: number;
  source?: TargetSource;
  sourceConfig?: { projectId?: string | null; productId?: string | null };
  reviewerId?: string | null;
}

async function recordProgress(a: TargetAssignment, value: number, source: TargetSource, recordedBy: string | null, extra: { id?: string; note?: string | null; evidence?: { title?: string; url: string }[] } = {}) {
  const delta = value - a.currentValue;
  await a.update({ currentValue: value });
  return TargetProgress.create({ ...(extra.id ? { id: extra.id } : {}), targetId: a.targetId, assignmentId: a.id, value, delta, source, note: extra.note ?? null, evidence: extra.evidence ?? [], recordedBy });
}

export const targetsService = {
  async list(userId: string, q: { segment?: "mine" | "team" | "all"; status?: string; from?: string; to?: string; ownerType?: string; ownerId?: string; productId?: string }) {
    const segment = q.segment ?? "mine";
    const ands: WhereOptions[] = [];
    const assigned = (ids: string) => sequelize.literal(`(SELECT target_id FROM target_assignments WHERE user_id IN ${ids})`);
    if (segment === "mine") {
      ands.push({ [Op.or]: [{ id: { [Op.in]: assigned(`(${sequelize.escape(userId)})`) } }, { reviewerId: userId }] } as WhereOptions);
    } else if (segment === "team") {
      // People who report to me, and groups I lead.
      const reports = `(SELECT id FROM users WHERE reports_to_id = ${sequelize.escape(userId)})`;
      const led = (await Team.findAll({ where: { leadId: userId }, attributes: ["id"] })).map((x) => x.id);
      ands.push({ [Op.or]: [{ id: { [Op.in]: assigned(reports) } }, ...(led.length ? [{ ownerType: "team", ownerId: led }] : [])] } as WhereOptions);
    } else {
      const [evaluate, view] = await Promise.all([reachFor(userId, "target.evaluate"), reachFor(userId, "report.view")]);
      if (!evaluate.organization && !view.organization) {
        const scoped = (type: TargetOwnerType, ids: string[]) => (ids.length ? [{ ownerType: type, ownerId: ids }] : []);
        const ors = [
          ...scoped("department", [...evaluate.departments, ...view.departments]),
          ...scoped("team", [...evaluate.teams, ...view.teams]),
          ...scoped("product", [...evaluate.products, ...view.products]),
          ...scoped("project", [...evaluate.projects, ...view.projects]),
        ];
        if (!ors.length) throw forbidden("You can't see every target");
        ands.push({ [Op.or]: ors } as WhereOptions);
      }
    }
    if (q.status) ands.push({ status: q.status });
    if (q.ownerType) ands.push({ ownerType: q.ownerType });
    if (q.ownerId) ands.push({ ownerId: q.ownerId });
    if (q.productId) ands.push({ [Op.or]: [{ ownerType: "product", ownerId: q.productId }, { sourceConfig: { productId: q.productId } }] } as WhereOptions);
    if (q.from) ands.push({ endDate: { [Op.gte]: q.from.slice(0, 10) } });
    if (q.to) ands.push({ startDate: { [Op.lte]: q.to.slice(0, 10) } });
    const rows = await Target.findAll({ where: { [Op.and]: ands }, ...withAssignments, order: [["endDate", "ASC"]], limit: 200 });
    return rows.map(serializeTarget);
  },

  async get(id: string, userId: string) {
    const t = await load(id);
    await assertMaySee(t, userId);
    const progress = await TargetProgress.findAll({ where: { targetId: id }, order: [["createdAt", "DESC"]], limit: 200 });
    return { target: serializeTarget(t), progress: progress.map(serializeProgress) };
  },

  async create(input: TargetInput, userId: string) {
    if (input.endDate < input.startDate) throw badRequest("A target can't end before it starts");
    if ((input.startValue ?? 0) === input.targetValue) throw badRequest("The target value must differ from the starting value");
    if (!(await canOnOwner(userId, "target.create", input))) throw forbidden("You can't create targets here");
    const isSelf = input.ownerType === "user" && input.ownerId === userId;
    if (!isSelf && !(await canOnOwner(userId, "target.assign", input))) throw forbidden("You can't assign targets here");
    if (input.source === "integration") throw badRequest("Integration targets aren't available yet");
    if (input.id) {
      const existing = await Target.findByPk(input.id, withAssignments);
      if (existing) return serializeTarget(existing);
    }
    const t = await Target.create({
      ...(input.id ? { id: input.id } : {}),
      name: input.name,
      description: input.description ?? "",
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      period: input.period,
      startDate: input.startDate,
      endDate: input.endDate,
      unit: input.unit,
      unitLabel: input.unitLabel ?? null,
      startValue: input.startValue ?? 0,
      targetValue: input.targetValue,
      currentValue: input.startValue ?? 0,
      source: input.source ?? "manual",
      sourceConfig: input.sourceConfig ?? {},
      reviewerId: input.reviewerId ?? null,
      createdBy: userId,
    });
    await setAssignments(t, userId);
    await refreshFromTasks(t.id);
    hint(await load(t.id));
    return reload(t.id);
  },

  async update(id: string, patch: Partial<TargetInput>, userId: string) {
    const t = await load(id);
    if (t.createdBy !== userId && !(await canOnOwner(userId, "target.update", t))) throw forbidden("You can't change this target");
    if (t.status === "cancelled") throw new AppError(409, "This target was cancelled", "cancelled");
    const changesPerPerson = patch.targetValue !== undefined && patch.targetValue !== t.targetValue;
    await t.update({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
      ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
      ...(patch.period !== undefined ? { period: patch.period } : {}),
      ...(patch.unit !== undefined ? { unit: patch.unit } : {}),
      ...(patch.unitLabel !== undefined ? { unitLabel: patch.unitLabel } : {}),
      ...(patch.startValue !== undefined ? { startValue: patch.startValue } : {}),
      ...(patch.targetValue !== undefined ? { targetValue: patch.targetValue } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      ...(patch.sourceConfig !== undefined ? { sourceConfig: patch.sourceConfig } : {}),
      ...(patch.reviewerId !== undefined ? { reviewerId: patch.reviewerId } : {}),
    });
    if (t.endDate < t.startDate) throw badRequest("A target can't end before it starts");
    if (changesPerPerson) await TargetAssignment.update({ targetValue: t.targetValue }, { where: { targetId: id } });
    await refreshFromTasks(id);
    await settle(id, userId);
    return reload(id);
  },

  async cancel(id: string, userId: string) {
    const t = await load(id);
    if (t.createdBy !== userId && !(await canOnOwner(userId, "target.update", t))) throw forbidden("You can't change this target");
    await t.update({ status: "cancelled" });
    hint(t);
    return reload(id);
  },

  async addProgress(id: string, input: { id?: string; value: number; note?: string; evidence?: { title?: string; url: string }[]; assignmentId?: string; source?: "manual" | "imported" }, userId: string) {
    const t = await load(id);
    if (t.source === "tasks") throw new AppError(409, "This target updates itself from completed tasks", "not_manual");
    if (t.status === "cancelled") throw new AppError(409, "This target was cancelled", "cancelled");
    if (input.id) {
      const existing = await TargetProgress.findByPk(input.id);
      if (existing) return { target: serializeTarget(t), progress: serializeProgress(existing) };
    }
    const rows = (t.get("assignments") as TargetAssignment[] | undefined) ?? [];
    const a = input.assignmentId ? rows.find((x) => x.id === input.assignmentId) : (rows.find((x) => x.userId === userId) ?? (rows.length === 1 ? rows[0] : undefined));
    if (!a) throw badRequest("Say whose progress this is");
    const allowed = a.userId === userId || t.reviewerId === userId || (await canOnOwner(userId, "target.update", t));
    if (!allowed) throw forbidden("You can't update this progress");
    const progress = await recordProgress(a, input.value, input.source ?? "manual", userId, { id: input.id, note: input.note, evidence: input.evidence });
    await settle(id, userId);
    return { target: await reload(id), progress: serializeProgress(progress) };
  },

  async importProgress(id: string, rows: { userId?: string; value: number; note?: string }[], userId: string) {
    const t = await load(id);
    if (!(await canOnOwner(userId, "target.update", t))) throw forbidden("You can't update this target");
    if (t.source === "tasks") throw new AppError(409, "This target updates itself from completed tasks", "not_manual");
    const assignments = (t.get("assignments") as TargetAssignment[] | undefined) ?? [];
    let applied = 0;
    const errors: { row: number; error: string }[] = [];
    for (const [i, r] of rows.entries()) {
      const a = r.userId ? assignments.find((x) => x.userId === r.userId) : assignments.length === 1 ? assignments[0] : undefined;
      if (!a) {
        errors.push({ row: i + 1, error: r.userId ? "That person isn't on this target" : "Say whose progress this is" });
        continue;
      }
      await recordProgress(a, r.value, "imported", userId, { note: r.note });
      applied++;
    }
    await settle(id, userId);
    return { applied, errors };
  },

  async evaluate(id: string, input: { rating: number; note?: string; status?: "achieved" | "missed" }, userId: string, req?: Req) {
    const t = await load(id);
    if (t.reviewerId !== userId && !(await canOnOwner(userId, "target.evaluate", t))) throw forbidden("You can't evaluate this target");
    if (t.status === "cancelled") throw new AppError(409, "This target was cancelled", "cancelled");
    const status: TargetStatus = input.status ?? (isReached(t.startValue, t.targetValue, t.currentValue) ? "achieved" : t.status);
    await t.update({ status, evaluation: { rating: input.rating, note: input.note ?? null, by: userId, at: new Date().toISOString() } });
    await audit({ req, actorId: userId, action: "target.evaluate", target: { type: "target", id }, after: { rating: input.rating, status } });
    hint(t);
    return reload(id);
  },

  // Hourly: bring task-based targets up to date and close the ones past their end.
  async sweep(): Promise<void> {
    const rows = await Target.findAll({ where: { status: "active" }, attributes: ["id", "source"] });
    for (const { id, source } of rows) {
      if (source === "tasks") await refreshFromTasks(id);
      await settle(id, null);
    }
  },

  // When someone completes a task.
  async refreshForUsers(userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    const assignments = await TargetAssignment.findAll({ where: { userId: userIds }, attributes: ["targetId"] });
    const ids = [...new Set(assignments.map((a) => a.targetId))];
    const targets = await Target.findAll({ where: { id: ids, source: "tasks", status: "active" }, attributes: ["id"] });
    for (const t of targets) {
      await refreshFromTasks(t.id);
      await settle(t.id, null);
    }
  },
};

// Counts tasks each person completed in the target's period.
async function refreshFromTasks(targetId: string): Promise<void> {
  const t = await Target.findByPk(targetId, withAssignments);
  if (!t || t.source !== "tasks") return;
  const cfg = t.sourceConfig ?? {};
  for (const a of (t.get("assignments") as TargetAssignment[] | undefined) ?? []) {
    const [row] = await sequelize.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id
        WHERE ta.user_id = :userId AND t.status IN ('approved', 'done')
          AND t.completed_at >= :start AND t.completed_at < (:end::date + INTERVAL '1 day')
          ${cfg.projectId ? "AND t.project_id = :projectId" : ""}
          ${cfg.productId ? "AND t.product_id = :productId" : ""}`,
      { replacements: { userId: a.userId, start: t.startDate, end: t.endDate, projectId: cfg.projectId ?? null, productId: cfg.productId ?? null }, type: QueryTypes.SELECT },
    );
    const value = t.startValue + Number(row?.n ?? 0);
    if (value !== a.currentValue) await recordProgress(a, value, "tasks", null);
  }
  await settle(targetId, null);
}

export function targetsVisibleWhere(userId: string): WhereOptions {
  const mine = sequelize.literal(`(SELECT target_id FROM target_assignments WHERE user_id = ${sequelize.escape(userId)})`);
  return { [Op.or]: [{ id: { [Op.in]: mine } }, { reviewerId: userId }, { createdBy: userId }] } as WhereOptions;
}
