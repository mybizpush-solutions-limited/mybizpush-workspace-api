import { Op, QueryTypes, type Transaction, type WhereOptions } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { audit } from "../../lib/audit";
import { enqueue } from "../../jobs/queues";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors";
import {
  CLOSED_TASK_STATUSES,
  Project,
  REVIEW_TASK_STATUSES,
  Task,
  TaskGroupAssignment,
  TaskReview,
  TaskStatusHistory,
  TaskSubmission,
  TaskTemplate,
  User,
  type Priority,
  type TaskStatus,
} from "../../models";
import { can } from "../access/engine";
import { projectsWith } from "../access/reach";
import { groupsService } from "../groups/groups.service";
import type { GroupRef } from "../groups/groups.merge";
import { refreshBadges, syncHint } from "../shared/live";
import { logActivity, notify } from "../shared/events";
import { serializeTaskReview, serializeTaskStatusHistory, serializeTaskSubmission, serializeWorkItem, taskInclude } from "../shared/serializers";
import type { ReviewInput, SubmitInput, TaskListQuery } from "./tasks.schemas";
import { allowedMoves, decideTransition, wouldCreateCycle, type TaskActor, type TransitionVia } from "./task.workflow";

// The task workflow (API-CHANGES A201 to A204). The shared work item service
// calls the before and after hooks here, so tasks created or moved from anywhere
// (REST, offline sync, the assistant) follow the same rules.

const TASK_COLLECTIONS = ["tasks", "taskSubmissions", "taskReviews", "taskStatusHistory"];

export async function assigneeIdsOf(taskId: string): Promise<string[]> {
  const rows = await sequelize.query<{ user_id: string }>(`SELECT user_id FROM task_assignees WHERE task_id = :taskId`, {
    replacements: { taskId },
    type: QueryTypes.SELECT,
  });
  return rows.map((r) => r.user_id);
}

const projectScope = (projectId: string) => ({ type: "project" as const, id: projectId });

async function loadTask(id: string): Promise<Task> {
  const task = await Task.findByPk(id);
  if (!task) throw notFound("task not found");
  return task;
}

export async function reloadTask(id: string) {
  const task = await Task.findByPk(id, { include: taskInclude });
  if (!task) throw notFound("task not found");
  return serializeWorkItem(task, "task");
}

export async function actorRoles(task: Task, userId: string): Promise<Set<TaskActor>> {
  const roles = new Set<TaskActor>();
  const [assignees, manager, approver] = await Promise.all([
    assigneeIdsOf(task.id),
    can({ sub: userId }, "task.assign", projectScope(task.projectId)),
    task.reviewerId ? Promise.resolve(false) : can({ sub: userId }, "task.approve", projectScope(task.projectId)),
  ]);
  if (assignees.includes(userId)) roles.add("assignee");
  if (task.reporterId === userId) roles.add("reporter");
  if (manager) roles.add("manager");
  if (task.reviewerId === userId || approver) roles.add("reviewer");
  return roles;
}

// Everyone with a stake in the task, for sync hints and badge refreshes.
async function stakeholders(task: Task): Promise<string[]> {
  return [...(await assigneeIdsOf(task.id)), task.reviewerId, task.reporterId].filter((x): x is string => !!x);
}

function announce(task: Task, people: string[]): void {
  syncHint(people, TASK_COLLECTIONS);
  refreshBadges(people);
}

async function assertUsers(ids: (string | null | undefined)[]): Promise<void> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return;
  const found = await User.count({ where: { id: wanted } });
  if (found !== wanted.length) throw badRequest("One of the people picked no longer exists");
}

// Records one move of the status, with the timestamps that depend on it.
async function moveStatus(task: Task, to: TaskStatus, actorId: string, opts: { note?: string; blockedReason?: string; tx?: Transaction } = {}): Promise<void> {
  const from = task.status;
  const now = new Date();
  const completes = to === "approved" || to === "done";
  await task.update(
    {
      status: to,
      blockedReason: to === "blocked" ? (opts.blockedReason ?? opts.note ?? null) : null,
      ...(to === "submitted" ? { submittedAt: now } : {}),
      ...(to === "approved" || to === "rejected" || to === "revision_required" ? { reviewedAt: now } : {}),
      // Keep the first completion time when an approved task is closed as done.
      ...(completes ? { completedAt: task.completedAt ?? now } : { completedAt: null }),
    },
    { transaction: opts.tx },
  );
  // Targets counting completed tasks catch up. Reopening a task counts too.
  if (completes || from === "approved" || from === "done") {
    const userIds = await assigneeIdsOf(task.id);
    void enqueue("maintenance", "targets-refresh", { userIds }, { delay: 5_000 }).catch((err) => console.error("targets refresh not queued", err));
  }
  await TaskStatusHistory.create({ taskId: task.id, fromStatus: from, toStatus: to, actorId, note: opts.note ?? null }, { transaction: opts.tx });
  await logActivity({ itemId: task.id, itemType: "task", actorId, kind: "status_changed", data: { from, to } });
}

function throwDecision(code: "invalid_transition" | "not_allowed_transition" | "use_endpoint", message: string): never {
  throw new AppError(code === "not_allowed_transition" ? 403 : 409, message, code);
}

async function checkMove(task: Task, to: TaskStatus, actorId: string, via: TransitionVia): Promise<void> {
  const decision = decideTransition({ from: task.status, to, roles: await actorRoles(task, actorId), hasReviewer: !!task.reviewerId, via });
  if (!decision.allowed) throwDecision(decision.code, decision.message);
}

// ---- Hooks called by the shared work item service --------------------------

export interface TaskCreateExtras {
  reviewerId?: string | null;
  productId?: string | null;
  teamId?: string | null;
  startDate?: string | null;
  expectedDeliverable?: string;
  templateId?: string | null;
  dependsOnIds?: string[];
  assignGroups?: GroupRef[];
  sourceType?: string | null;
  sourceId?: string | null;
}

// Strict callers (the mobile app and offline sync) enforce task.assign when
// assigning other people. The web app predates that permission and is unchanged.
async function assertMayAssign(actorId: string, projectId: string, assigneeIds: string[], reviewerId: string | null | undefined, groups: GroupRef[] | undefined, strict: boolean): Promise<void> {
  const others = strict && (assigneeIds.some((id) => id !== actorId) || (!!reviewerId && reviewerId !== actorId));
  if (!others && !groups?.length) return;
  if (!(await can({ sub: actorId }, "task.assign", projectScope(projectId)))) {
    throw forbidden("You don't have permission to assign tasks in this project");
  }
}

async function addGroupAssignments(taskId: string, refs: GroupRef[], actorId: string): Promise<void> {
  for (const ref of refs) {
    const userIds = await groupsService.expandIds([ref]);
    await TaskGroupAssignment.create({ taskId, groupType: ref.type, groupId: ref.id, userIds, createdBy: actorId });
  }
}

export const taskHooks = {
  // Fills in defaults and checks permissions. Returns the task's extra columns
  // and the final assignee list.
  async prepareCreate(input: {
    projectId: string;
    title: string;
    description?: string;
    priority?: Priority;
    dueDate?: string;
    assigneeIds?: string[];
    labelIds?: string[];
    departmentId?: string | null;
  } & TaskCreateExtras, actorId: string, strict: boolean) {
    const project = await Project.findByPk(input.projectId, { attributes: ["id", "productId"] });
    if (!project) throw notFound("That project no longer exists");
    if (!(await can({ sub: actorId }, "task.create", projectScope(project.id)))) {
      throw forbidden("You don't have permission to create tasks in this project");
    }

    const template = input.templateId ? await TaskTemplate.findByPk(input.templateId) : null;
    if (input.templateId && !template) throw badRequest("That template no longer exists");

    await assertMayAssign(actorId, project.id, input.assigneeIds ?? [], input.reviewerId ?? template?.reviewerId, input.assignGroups, strict);
    const expanded = input.assignGroups?.length ? await groupsService.expandIds(input.assignGroups) : [];
    const assigneeIds = [...new Set([...(input.assigneeIds ?? []), ...expanded])];
    const reviewerId = input.reviewerId ?? template?.reviewerId ?? null;
    await assertUsers([...assigneeIds, reviewerId]);

    const dueFromTemplate = template?.defaultDueDays != null ? new Date(Date.now() + template.defaultDueDays * 86_400_000) : null;
    return {
      assigneeIds,
      labelIds: input.labelIds?.length ? input.labelIds : (template?.labelIds ?? []),
      description: input.description ?? template?.description ?? "",
      priority: input.priority ?? template?.priority ?? "medium",
      dueDate: input.dueDate ? new Date(input.dueDate) : dueFromTemplate,
      departmentId: input.departmentId ?? template?.departmentId ?? null,
      columns: {
        reviewerId,
        productId: input.productId ?? project.productId ?? null,
        teamId: input.teamId ?? null,
        startDate: input.startDate ? new Date(input.startDate) : null,
        expectedDeliverable: input.expectedDeliverable ?? template?.expectedDeliverable ?? "",
        templateId: template?.id ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
      },
    };
  },

  async afterCreate(task: Task, input: TaskCreateExtras, assigneeIds: string[], actorId: string): Promise<void> {
    await TaskStatusHistory.create({ taskId: task.id, fromStatus: null, toStatus: task.status, actorId });
    if (input.assignGroups?.length) await addGroupAssignments(task.id, input.assignGroups, actorId);
    for (const dependsOnId of input.dependsOnIds ?? []) await addDependencyRow(task.id, dependsOnId);
    if (task.reviewerId) {
      await notify({ userId: task.reviewerId, fromUserId: actorId, kind: "reviewer_assigned", itemId: task.id, itemType: "task", message: `You'll review: ${task.title}` });
    }
    announce(task, [...assigneeIds, task.reviewerId, task.reporterId].filter((x): x is string => !!x));
  },

  async prepareUpdate(task: Task, patch: { assigneeIds?: string[] } & TaskCreateExtras, actorId: string, strict: boolean) {
    const reviewerChanged = patch.reviewerId !== undefined && patch.reviewerId !== task.reviewerId;
    await assertMayAssign(actorId, task.projectId, patch.assigneeIds ?? [], reviewerChanged ? patch.reviewerId : undefined, patch.assignGroups, strict);
    const expanded = patch.assignGroups?.length ? await groupsService.expandIds(patch.assignGroups) : [];
    // A group adds people to whoever is already on the task unless the caller
    // also sent the full list.
    const base = patch.assigneeIds ?? (expanded.length ? await assigneeIdsOf(task.id) : undefined);
    const assigneeIds = base ? [...new Set([...base, ...expanded])] : undefined;
    await assertUsers([...(assigneeIds ?? []), patch.reviewerId]);
    return {
      assigneeIds,
      columns: {
        ...(patch.reviewerId !== undefined ? { reviewerId: patch.reviewerId } : {}),
        ...(patch.productId !== undefined ? { productId: patch.productId } : {}),
        ...(patch.teamId !== undefined ? { teamId: patch.teamId } : {}),
        ...(patch.startDate !== undefined ? { startDate: patch.startDate ? new Date(patch.startDate) : null } : {}),
        ...(patch.expectedDeliverable !== undefined ? { expectedDeliverable: patch.expectedDeliverable } : {}),
      },
      reviewerChanged,
    };
  },

  async afterUpdate(task: Task, patch: TaskCreateExtras, reviewerChanged: boolean, actorId: string): Promise<void> {
    if (patch.assignGroups?.length) await addGroupAssignments(task.id, patch.assignGroups, actorId);
    if (patch.dependsOnIds) await setDependencies(task.id, patch.dependsOnIds, actorId);
    if (reviewerChanged && task.reviewerId) {
      await notify({ userId: task.reviewerId, fromUserId: actorId, kind: "reviewer_assigned", itemId: task.id, itemType: "task", message: `You'll review: ${task.title}` });
    }
    announce(task, await stakeholders(task));
  },

  // The Change status action. Replaces the plain update for tasks.
  async setStatus(task: Task, to: TaskStatus, actorId: string, opts: { note?: string; blockedReason?: string } = {}): Promise<void> {
    if (task.status === to) return;
    await checkMove(task, to, actorId, "status");
    const withdrawing = task.status === "submitted" && to === "in_progress";
    await moveStatus(task, to, actorId, opts);
    if (withdrawing) await TaskSubmission.update({ status: "withdrawn" }, { where: { taskId: task.id, status: "pending" } });

    const people = await stakeholders(task);
    if (to === "blocked") {
      for (const userId of [task.reporterId, task.reviewerId]) {
        if (userId) await notify({ userId, fromUserId: actorId, kind: "blocked", itemId: task.id, itemType: "task", message: `${task.title} is blocked${task.blockedReason ? `: ${task.blockedReason}` : ""}` });
      }
    } else if (task.reporterId) {
      await notify({ userId: task.reporterId, fromUserId: actorId, kind: "status_changed", itemId: task.id, itemType: "task", message: `${task.title} moved to ${to}` });
    }
    if (to === "done" || to === "cancelled") await notifyDependents(task, actorId);
    announce(task, people);
  },
};

// ---- Dependencies -----------------------------------------------------------

async function dependencyEdges(): Promise<Map<string, string[]>> {
  const rows = await sequelize.query<{ task_id: string; depends_on_id: string }>(`SELECT task_id, depends_on_id FROM task_dependencies`, { type: QueryTypes.SELECT });
  const edges = new Map<string, string[]>();
  for (const r of rows) edges.set(r.task_id, [...(edges.get(r.task_id) ?? []), r.depends_on_id]);
  return edges;
}

async function addDependencyRow(taskId: string, dependsOnId: string): Promise<void> {
  if (!(await Task.findByPk(dependsOnId, { attributes: ["id"] }))) throw badRequest("That task no longer exists");
  if (wouldCreateCycle(await dependencyEdges(), taskId, dependsOnId)) {
    throw new AppError(409, "That would make these tasks wait for each other", "dependency_cycle");
  }
  await sequelize.query(`INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (:taskId, :dependsOnId) ON CONFLICT DO NOTHING`, { replacements: { taskId, dependsOnId } });
}

async function setDependencies(taskId: string, dependsOnIds: string[], actorId: string): Promise<void> {
  await sequelize.query(`DELETE FROM task_dependencies WHERE task_id = :taskId`, { replacements: { taskId } });
  for (const id of dependsOnIds) await addDependencyRow(taskId, id);
  await logActivity({ itemId: taskId, itemType: "task", actorId, kind: "dependency_changed", data: { dependsOnIds } });
}

// Bump updatedAt: join tables don't touch it, and offline clients need to notice.
async function touch(task: Task): Promise<void> {
  task.changed("updatedAt", true);
  await task.save();
}

// When work finishes, tell the people who were waiting on it.
async function notifyDependents(task: Task, actorId: string): Promise<void> {
  const rows = await sequelize.query<{ task_id: string }>(`SELECT task_id FROM task_dependencies WHERE depends_on_id = :id`, { replacements: { id: task.id }, type: QueryTypes.SELECT });
  for (const { task_id } of rows) {
    const dependent = await Task.findByPk(task_id, { attributes: ["id", "title"] });
    if (!dependent) continue;
    for (const userId of await assigneeIdsOf(task_id)) {
      await notify({ userId, fromUserId: actorId, kind: "status_changed", itemId: task_id, itemType: "task", message: `${task.title} is finished, so ${dependent.title} can move` });
    }
  }
}

const brief = (t: Task, assigneeIds: string[]) => ({ id: t.id, title: t.title, status: t.status, projectId: t.projectId, dueDate: t.dueDate?.toISOString() ?? null, assigneeIds });

// ---- Public operations ------------------------------------------------------

export const tasksWorkflow = {
  async transitions(id: string, userId: string) {
    const task = await loadTask(id);
    const roles = await actorRoles(task, userId);
    return { current: task.status, roles: [...roles], allowed: allowedMoves(task.status, roles, !!task.reviewerId) };
  },

  async submit(id: string, input: SubmitInput, userId: string) {
    const task = await loadTask(id);
    if (!(await can({ sub: userId }, "task.submit", projectScope(task.projectId)))) throw forbidden("You don't have permission to submit work");
    await checkMove(task, "submitted", userId, "submit");

    if (input.id) {
      const existing = await TaskSubmission.findByPk(input.id);
      if (existing) return { submission: serializeTaskSubmission(existing), item: await reloadTask(id) };
    }
    const round = (await TaskSubmission.count({ where: { taskId: id } })) + 1;
    const submission = await sequelize.transaction(async (tx) => {
      const created = await TaskSubmission.create(
        {
          ...(input.id ? { id: input.id } : {}),
          taskId: id,
          round,
          submittedBy: userId,
          reviewerId: task.reviewerId ?? null,
          notes: input.notes ?? "",
          links: input.links ?? [],
          evidence: input.evidence ?? [],
          attachmentIds: input.attachmentIds ?? [],
        },
        { transaction: tx },
      );
      await moveStatus(task, "submitted", userId, { tx });
      return created;
    });
    await logActivity({ itemId: id, itemType: "task", actorId: userId, kind: "submitted", data: { submissionId: submission.id, round } });
    const target = task.reviewerId ?? task.reporterId;
    if (target) await notify({ userId: target, fromUserId: userId, kind: "submitted", itemId: id, itemType: "task", message: `Ready for review: ${task.title}` });
    announce(task, await stakeholders(task));
    return { submission: serializeTaskSubmission(submission), item: await reloadTask(id) };
  },

  async review(id: string, input: ReviewInput, userId: string, req?: Parameters<typeof audit>[0]["req"]) {
    const task = await loadTask(id);
    if (input.id) {
      const existing = await TaskReview.findByPk(input.id);
      if (existing) return { review: serializeTaskReview(existing), item: await reloadTask(id) };
    }
    if (!REVIEW_TASK_STATUSES.includes(task.status)) throw new AppError(409, "This task is not waiting for a review", "not_reviewable");

    const scope = projectScope(task.projectId);
    const isNamed = task.reviewerId === userId;
    if (input.decision === "reassign") {
      const allowed = isNamed || task.reporterId === userId || (await can({ sub: userId }, "task.assign", scope)) || (await can({ sub: userId }, "task.approve", scope));
      if (!allowed) throw forbidden("You can't reassign the reviewer of this task");
      await assertUsers([input.newReviewerId]);
    } else {
      const permission = input.decision === "reject" ? "task.reject" : "task.approve";
      if (!isNamed && !(await can({ sub: userId }, permission, scope))) throw forbidden("You can't review this task");
    }

    const submission = input.submissionId
      ? await TaskSubmission.findOne({ where: { id: input.submissionId, taskId: id } })
      : await TaskSubmission.findOne({ where: { taskId: id }, order: [["createdAt", "DESC"]] });
    if (input.submissionId && !submission) throw notFound("Submission not found");
    if (input.decision !== "reassign" && submission?.submittedBy === userId) {
      throw new AppError(403, "You can't review your own submission", "self_review");
    }

    const decided = input.decision !== "reassign";
    const next: TaskStatus | null = { approve: "approved", reject: "rejected", request_revision: "revision_required", reassign: null }[input.decision] as TaskStatus | null;
    const review = await sequelize.transaction(async (tx) => {
      const created = await TaskReview.create(
        {
          ...(input.id ? { id: input.id } : {}),
          taskId: id,
          submissionId: submission?.id ?? null,
          reviewerId: userId,
          decision: input.decision,
          feedback: input.feedback ?? "",
          newReviewerId: input.newReviewerId ?? null,
        },
        { transaction: tx },
      );
      if (decided && next) {
        if (submission && submission.status === "pending") {
          await submission.update({ status: next === "revision_required" ? "revision_required" : (next as "approved" | "rejected") }, { transaction: tx });
        }
        if (next === "revision_required") await task.update({ revisionCount: task.revisionCount + 1 }, { transaction: tx });
        await moveStatus(task, next, userId, { note: input.feedback, tx });
      } else {
        await task.update({ reviewerId: input.newReviewerId! }, { transaction: tx });
        if (submission?.status === "pending") await submission.update({ reviewerId: input.newReviewerId! }, { transaction: tx });
      }
      await audit({
        req,
        actorId: userId,
        action: `task.review.${input.decision}`,
        target: { type: "task", id },
        scope,
        after: { status: task.status, reviewerId: task.reviewerId, submissionId: submission?.id ?? null },
        tx,
      });
      return created;
    });
    await logActivity({ itemId: id, itemType: "task", actorId: userId, kind: "reviewed", data: { decision: input.decision, reviewId: review.id } });

    const assignees = await assigneeIdsOf(id);
    const message = {
      approve: `Approved: ${task.title}`,
      reject: `Rejected: ${task.title}`,
      request_revision: `Revision requested: ${task.title}`,
      reassign: `You'll review: ${task.title}`,
    }[input.decision];
    if (input.decision === "reassign") {
      await notify({ userId: input.newReviewerId!, fromUserId: userId, kind: "reviewer_assigned", itemId: id, itemType: "task", message });
    } else {
      const kind = ({ approve: "approved", reject: "rejected", request_revision: "revision_requested" } as const)[input.decision];
      for (const uid of assignees) await notify({ userId: uid, fromUserId: userId, kind, itemId: id, itemType: "task", message });
      if (task.reporterId && !assignees.includes(task.reporterId)) await notify({ userId: task.reporterId, fromUserId: userId, kind, itemId: id, itemType: "task", message });
      if (input.decision === "approve") await notifyDependents(task, userId);
    }
    announce(task, await stakeholders(task));
    return { review: serializeTaskReview(review), item: await reloadTask(id) };
  },

  async submissions(id: string) {
    await loadTask(id);
    return (await TaskSubmission.findAll({ where: { taskId: id }, order: [["createdAt", "DESC"]] })).map(serializeTaskSubmission);
  },

  async reviews(id: string) {
    await loadTask(id);
    return (await TaskReview.findAll({ where: { taskId: id }, order: [["createdAt", "DESC"]] })).map(serializeTaskReview);
  },

  // Status moves, submissions and decisions as one timeline (TASK-15).
  async history(id: string) {
    await loadTask(id);
    const [statuses, submissions, reviews] = await Promise.all([
      TaskStatusHistory.findAll({ where: { taskId: id } }),
      TaskSubmission.findAll({ where: { taskId: id } }),
      TaskReview.findAll({ where: { taskId: id } }),
    ]);
    const entries = [
      ...statuses.map((s) => {
        const h = serializeTaskStatusHistory(s);
        return { id: h.id, type: "status" as const, actorId: h.actorId, createdAt: h.createdAt, fromStatus: h.fromStatus, toStatus: h.toStatus, note: h.note };
      }),
      ...submissions.map((s) => ({ id: s.id, type: "submission" as const, actorId: s.submittedBy ?? null, createdAt: s.createdAt.toISOString(), submissionId: s.id, round: s.round, note: s.notes })),
      ...reviews.map((r) => ({ id: r.id, type: "review" as const, actorId: r.reviewerId ?? null, createdAt: r.createdAt.toISOString(), submissionId: r.submissionId ?? null, decision: r.decision, feedback: r.feedback, newReviewerId: r.newReviewerId ?? null })),
    ];
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async dependencies(id: string) {
    await loadTask(id);
    const [outgoing, incoming] = await Promise.all([
      sequelize.query<{ id: string }>(`SELECT depends_on_id AS id FROM task_dependencies WHERE task_id = :id`, { replacements: { id }, type: QueryTypes.SELECT }),
      sequelize.query<{ id: string }>(`SELECT task_id AS id FROM task_dependencies WHERE depends_on_id = :id`, { replacements: { id }, type: QueryTypes.SELECT }),
    ]);
    const load = async (ids: string[]) => {
      if (!ids.length) return [];
      const rows = await Task.findAll({ where: { id: ids }, attributes: ["id", "title", "status", "projectId", "dueDate"] });
      return Promise.all(rows.map(async (t) => brief(t, await assigneeIdsOf(t.id))));
    };
    return { dependsOn: await load(outgoing.map((r) => r.id)), blocking: await load(incoming.map((r) => r.id)) };
  },

  async addDependency(id: string, dependsOnId: string, actorId: string) {
    const task = await loadTask(id);
    await addDependencyRow(id, dependsOnId);
    await touch(task);
    await logActivity({ itemId: id, itemType: "task", actorId, kind: "dependency_changed", data: { added: dependsOnId } });
    syncHint(await stakeholders(task), ["tasks"]);
    return reloadTask(id);
  },

  async removeDependency(id: string, dependsOnId: string, actorId: string) {
    const task = await loadTask(id);
    await sequelize.query(`DELETE FROM task_dependencies WHERE task_id = :id AND depends_on_id = :dependsOnId`, { replacements: { id, dependsOnId } });
    await touch(task);
    await logActivity({ itemId: id, itemType: "task", actorId, kind: "dependency_changed", data: { removed: dependsOnId } });
    syncHint(await stakeholders(task), ["tasks"]);
    return reloadTask(id);
  },

  // The filtered list behind the Tasks tab (TASK-01, TASK-02).
  async list(q: TaskListQuery, userId: string) {
    const where: Record<string | symbol, unknown> = {};
    const ands: WhereOptions[] = [];
    const assignedTo = (id: string) => ({ id: { [Op.in]: sequelize.literal(`(SELECT task_id FROM task_assignees WHERE user_id = ${sequelize.escape(id)})`) } });

    if (q.segment === "mine") ands.push(assignedTo(userId));
    if (q.segment === "created") where.reporterId = userId;
    if (q.segment === "review") {
      where.status = REVIEW_TASK_STATUSES;
      const approvable = await projectsWith(userId, "task.approve");
      ands.push({
        [Op.or]: [
          { reviewerId: userId },
          { reviewerId: null, ...(approvable === "all" ? {} : { projectId: approvable }) },
        ],
      } as WhereOptions);
    }
    if (q.status?.length) where.status = q.status;
    if (q.priority?.length) where.priority = q.priority;
    if (q.projectId) where.projectId = q.projectId;
    if (q.departmentId) where.departmentId = q.departmentId;
    if (q.productId) where.productId = q.productId;
    if (q.teamId) where.teamId = q.teamId;
    if (q.reviewerId) where.reviewerId = q.reviewerId;
    if (q.assigneeId) ands.push(assignedTo(q.assigneeId));
    if (q.q) where.title = { [Op.iLike]: `%${q.q.replace(/[%_]/g, (c) => `\\${c}`)}%` };
    if (q.dueFrom || q.dueTo) {
      where.dueDate = { ...(q.dueFrom ? { [Op.gte]: new Date(q.dueFrom) } : {}), ...(q.dueTo ? { [Op.lte]: new Date(q.dueTo) } : {}) };
    }
    if (q.overdue === "true") {
      where.dueDate = { [Op.lt]: new Date() };
      if (!q.status?.length) where.status = { [Op.notIn]: CLOSED_TASK_STATUSES };
    }
    if (ands.length) where[Op.and] = ands;

    const rows = await Task.findAll({
      where: where as WhereOptions,
      include: taskInclude,
      order: [["updatedAt", "DESC"]],
      limit: q.limit ?? 100,
      offset: q.offset ?? 0,
    });
    return rows.map((t) => serializeWorkItem(t, "task"));
  },
};
