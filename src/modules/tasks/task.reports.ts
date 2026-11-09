import { Op, QueryTypes, type WhereOptions } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { forbidden } from "../../lib/errors";
import { Project, Task, User } from "../../models";
import { projectsWith } from "../access/reach";
import { isOverdue, summarizeTasks, type ReportTask } from "./task.report.calc";
import type { TaskReportQuery } from "./tasks.schemas";

// Task reports (API-CHANGES A205, REP-07). What a person gets depends on where
// they hold report.view: everywhere, some projects, or only their own tasks.

interface Resolved {
  scope: "organization" | "scoped" | "self";
  where: WhereOptions;
  range: { from: Date; to: Date };
}

function rangeOf(q: TaskReportQuery) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
}

const assignedTo = (id: string) => ({ id: { [Op.in]: sequelize.literal(`(SELECT task_id FROM task_assignees WHERE user_id = ${sequelize.escape(id)})`) } });

async function resolve(q: TaskReportQuery, userId: string, permission: "report.view" | "report.export"): Promise<Resolved> {
  const visible = await projectsWith(userId, permission);
  const self = visible !== "all" && !visible.length;
  if (q.projectId && visible !== "all" && !visible.includes(q.projectId) && !self) throw forbidden("You can't see reports for that project");
  if (self && q.assigneeId && q.assigneeId !== userId) throw forbidden("You can only see your own task report");
  // report.export is not implied for one's own tasks.
  if (permission === "report.export" && self) throw forbidden("You don't have permission to export reports");

  const ands: WhereOptions[] = [];
  if (visible !== "all" && !self) ands.push({ projectId: visible });
  if (self) ands.push(assignedTo(userId));
  if (q.projectId) ands.push({ projectId: q.projectId });
  if (q.productId) ands.push({ productId: q.productId });
  if (q.departmentId) ands.push({ departmentId: q.departmentId });
  if (q.teamId) ands.push({ teamId: q.teamId });
  if (q.assigneeId && !self) ands.push(assignedTo(q.assigneeId));
  return { scope: visible === "all" ? "organization" : self ? "self" : "scoped", where: { [Op.and]: ands }, range: rangeOf(q) };
}

const reportInclude = [
  { model: Project, attributes: ["id", "name"] },
  { model: User, as: "assignees", attributes: ["id", "name"], through: { attributes: [] } },
  { model: User, as: "reviewer", attributes: ["id", "name"] },
];

function toReportTask(t: Task): ReportTask {
  return {
    id: t.id,
    status: t.status,
    priority: t.priority,
    projectId: t.projectId,
    projectName: (t.get("Project") as Project | null)?.name ?? "",
    assignees: ((t.get("assignees") as User[] | undefined) ?? []).map((u) => ({ id: u.id, name: u.name })),
    dueDate: t.dueDate ?? null,
    createdAt: t.createdAt,
    completedAt: t.completedAt ?? null,
    revisionCount: t.revisionCount ?? 0,
  };
}

// Limits the summary to work that was live during the period: anything created
// by the end of it, and not closed before it began.
const liveDuring = (r: { from: Date; to: Date }): WhereOptions => ({
  createdAt: { [Op.lte]: r.to },
  [Op.or]: [{ completedAt: null }, { completedAt: { [Op.gte]: r.from } }],
});

async function avgApprovalHours(ids: string[], range: { from: Date; to: Date }): Promise<number | null> {
  if (!ids.length) return null;
  const [row] = await sequelize.query<{ hours: string | null }>(
    `SELECT AVG(EXTRACT(EPOCH FROM (r.created_at - s.created_at)) / 3600) AS hours
       FROM task_reviews r JOIN task_submissions s ON s.id = r.submission_id
      WHERE r.task_id IN (:ids) AND r.decision <> 'reassign' AND r.created_at BETWEEN :from AND :to`,
    { replacements: { ids, from: range.from, to: range.to }, type: QueryTypes.SELECT },
  );
  return row?.hours != null ? Math.round(Number(row.hours) * 10) / 10 : null;
}

export const taskReports = {
  async summary(q: TaskReportQuery, userId: string) {
    const r = await resolve(q, userId, "report.view");
    const rows = await Task.findAll({ where: { [Op.and]: [r.where, liveDuring(r.range)] }, include: reportInclude });
    const summary = summarizeTasks(rows.map(toReportTask), r.range, new Date());
    return {
      range: { from: r.range.from.toISOString(), to: r.range.to.toISOString() },
      scope: r.scope,
      ...summary,
      totals: { ...summary.totals, avgApprovalHours: await avgApprovalHours(rows.map((t) => t.id), r.range) },
    };
  },

  async rows(q: TaskReportQuery, userId: string, permission: "report.view" | "report.export" = "report.view", unlimited = false) {
    const r = await resolve(q, userId, permission);
    const where = { [Op.and]: [r.where, liveDuring(r.range)] };
    const [rows, total] = await Promise.all([
      Task.findAll({ where, include: reportInclude, order: [["dueDate", "ASC"], ["createdAt", "DESC"]], ...(unlimited ? {} : { limit: q.limit ?? 100, offset: q.offset ?? 0 }) }),
      Task.count({ where }),
    ]);
    const now = new Date();
    return {
      total,
      rows: rows.map((t) => {
        const report = toReportTask(t);
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          projectId: t.projectId,
          projectName: report.projectName,
          assigneeNames: report.assignees.map((a) => a.name),
          reviewerName: (t.get("reviewer") as User | null)?.name ?? null,
          dueDate: t.dueDate?.toISOString() ?? null,
          submittedAt: t.submittedAt?.toISOString() ?? null,
          completedAt: t.completedAt?.toISOString() ?? null,
          revisionCount: t.revisionCount,
          overdue: isOverdue(report, now),
        };
      }),
    };
  },

  // Flat rows for the CSV and XLSX download.
  async exportRows(q: TaskReportQuery, userId: string) {
    const { rows } = await this.rows(q, userId, "report.export", true);
    const columns = ["Title", "Status", "Priority", "Project", "Assignees", "Reviewer", "Due", "Submitted", "Completed", "Revisions", "Overdue"];
    return {
      columns,
      rows: rows.map((r) => ({
        Title: r.title,
        Status: r.status,
        Priority: r.priority,
        Project: r.projectName,
        Assignees: r.assigneeNames.join("; "),
        Reviewer: r.reviewerName ?? "",
        Due: r.dueDate ?? "",
        Submitted: r.submittedAt ?? "",
        Completed: r.completedAt ?? "",
        Revisions: String(r.revisionCount),
        Overdue: r.overdue ? "Yes" : "No",
      })),
    };
  },
};
