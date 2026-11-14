import { CLOSED_TASK_STATUSES, REVIEW_TASK_STATUSES, type TaskStatus } from "../../models/task-status";

// Task report arithmetic (API-CHANGES A205). Pure, so the numbers can be tested
// without a database.

export interface ReportTask {
  id: string;
  status: TaskStatus;
  priority: string;
  projectId: string;
  projectName: string;
  assignees: { id: string; name: string }[];
  dueDate: Date | null;
  createdAt: Date;
  completedAt: Date | null;
  revisionCount: number;
}

const isClosed = (s: TaskStatus) => CLOSED_TASK_STATUSES.includes(s);
const isCompleted = (s: TaskStatus) => s === "approved" || s === "done";

export function isOverdue(t: Pick<ReportTask, "status" | "dueDate">, now: Date): boolean {
  return !isClosed(t.status) && !!t.dueDate && t.dueDate < now;
}

export function summarizeTasks(tasks: ReportTask[], range: { from: Date; to: Date }, now: Date) {
  const inRange = (d: Date | null) => !!d && d >= range.from && d <= range.to;
  const totals = { created: 0, completed: 0, open: 0, overdue: 0, submitted: 0, approved: 0, rejected: 0, cancelled: 0, revisions: 0 };
  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const assignees = new Map<string, { userId: string; name: string; open: number; completed: number; overdue: number; revisions: number }>();
  const projects = new Map<string, { projectId: string; name: string; open: number; completed: number; overdue: number }>();
  let measured = 0;
  let onTime = 0;

  for (const t of tasks) {
    const completedInRange = isCompleted(t.status) && inRange(t.completedAt);
    const overdue = isOverdue(t, now);
    const open = !isClosed(t.status) && t.status !== "draft";

    if (inRange(t.createdAt)) totals.created++;
    if (completedInRange) totals.completed++;
    if (open) totals.open++;
    if (overdue) totals.overdue++;
    if (REVIEW_TASK_STATUSES.includes(t.status)) totals.submitted++;
    if (t.status === "approved") totals.approved++;
    if (t.status === "rejected") totals.rejected++;
    if (t.status === "cancelled") totals.cancelled++;
    totals.revisions += t.revisionCount;
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;

    if (completedInRange && t.dueDate && t.completedAt) {
      measured++;
      if (t.completedAt <= t.dueDate) onTime++;
    }

    const project = projects.get(t.projectId) ?? { projectId: t.projectId, name: t.projectName, open: 0, completed: 0, overdue: 0 };
    if (open) project.open++;
    if (completedInRange) project.completed++;
    if (overdue) project.overdue++;
    projects.set(t.projectId, project);

    for (const a of t.assignees) {
      const row = assignees.get(a.id) ?? { userId: a.id, name: a.name, open: 0, completed: 0, overdue: 0, revisions: 0 };
      if (open) row.open++;
      if (completedInRange) row.completed++;
      if (overdue) row.overdue++;
      row.revisions += t.revisionCount;
      assignees.set(a.id, row);
    }
  }

  return {
    totals: { ...totals, onTimeRate: measured ? onTime / measured : null },
    byStatus,
    byPriority,
    byAssignee: [...assignees.values()].sort((a, b) => a.name.localeCompare(b.name)),
    byProject: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
