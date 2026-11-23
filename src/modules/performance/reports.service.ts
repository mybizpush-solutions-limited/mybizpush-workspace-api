import { Op, QueryTypes, type WhereOptions } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { forbidden, notFound } from "../../lib/errors";
import { Department, Issue, Product, Project, User } from "../../models";
import { can } from "../access/engine";
import type { Scope } from "../access/catalog";
import { canOverUser, projectsInReach, reachFor, reachIsEmpty } from "../access/reach";
import { taskReports } from "../tasks/task.reports";
import { creativeOutput, meetingsAttended, staffHighlights, teamHighlights, workDetail } from "./report.detail";

// Reports (API-CHANGES A504, SCREENS 7.5). Data outside what the viewer may see is
// removed here, not hidden in the app. Exports build on these same functions, so
// a file can never hold more than its requester could open.

export interface Range {
  from: Date;
  to: Date;
}

export function rangeOf(q: { from?: string; to?: string }): Range {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
}
const rangeJson = (r: Range) => ({ from: r.from.toISOString(), to: r.to.toISOString() });
const query = <T extends object>(sql: string, replacements: Record<string, unknown>) => sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
const denied = () => forbidden("You can't see this report");
const ORG: Scope = { type: "organization", id: null };

const taskTotals = (where: WhereOptions, range: Range) => taskReports.totals(where, range);

function staffRows(byAssignee: { userId: string; name: string; open: number; completed: number; overdue: number; revisions: number }[], users: Map<string, string | null>) {
  return byAssignee.map((a) => ({ ...a, avatarUrl: users.get(a.userId) ?? null }));
}
async function avatars(ids: string[]): Promise<Map<string, string | null>> {
  if (!ids.length) return new Map();
  return new Map((await User.findAll({ where: { id: ids }, attributes: ["id", "avatarUrl"] })).map((u) => [u.id, u.avatarUrl ?? null]));
}

// Targets for a group (and, with `people`, for those individuals too).
async function targetTotals(where: string, replacements: Record<string, unknown>) {
  const [row] = await query<{ total: string; active: string; achieved: string; missed: string }>(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE t.status = 'active') AS active,
            COUNT(*) FILTER (WHERE t.status = 'achieved') AS achieved, COUNT(*) FILTER (WHERE t.status = 'missed') AS missed
       FROM targets t WHERE t.status <> 'cancelled' AND t.end_date >= :from::date AND t.start_date <= :to::date AND (${where})`,
    replacements,
  );
  return { total: Number(row?.total ?? 0), active: Number(row?.active ?? 0), achieved: Number(row?.achieved ?? 0), missed: Number(row?.missed ?? 0) };
}

async function meetingsHeld(where: string, replacements: Record<string, unknown>): Promise<number> {
  const [row] = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM meetings m WHERE m.status <> 'cancelled' AND m.starts_at BETWEEN :from AND :to AND (${where})`,
    replacements,
  );
  return Number(row?.n ?? 0);
}

async function projectRows(projects: Project[], range: Range) {
  return Promise.all(
    projects.map(async (p) => {
      const t = await taskTotals({ projectId: p.id }, range);
      return { projectId: p.id, name: p.name, progress: p.progress, open: t.open, completed: t.completed, overdue: t.overdue };
    }),
  );
}

// Filled in by the marketing module, which doesn't exist in every deployment step.
async function marketingFor(productId: string | null, range: Range) {
  const { marketingTotals } = await import("./report.marketing");
  return marketingTotals(productId, range);
}

// Departments that work on a product, among those the viewer holds a permission on.
async function departmentSlice(userId: string, permission: string, productId: string): Promise<string[]> {
  const reach = await reachFor(userId, permission);
  if (!reach.departments.length) return [];
  const rows = await query<{ id: string }>(
    `SELECT DISTINCT pd.department_id AS id FROM project_departments pd JOIN projects p ON p.id = pd.project_id
      WHERE p.product_id = :productId AND pd.department_id IN (:ids)`,
    { productId, ids: reach.departments },
  );
  return rows.map((r) => r.id);
}

export const reportsService = {
  async catalog(userId: string) {
    const [view, exp] = await Promise.all([reachFor(userId, "report.view"), reachFor(userId, "report.export")]);
    const reports: { type: string; scopes: string[]; ids: string[]; self: boolean; canExport: boolean }[] = [];
    const org = view.organization;
    if (org) reports.push({ type: "executive", scopes: ["organization"], ids: [], self: false, canExport: exp.organization });
    if (org || view.departments.length) {
      reports.push({ type: "department", scopes: org ? ["organization"] : ["department"], ids: org ? [] : view.departments, self: false, canExport: exp.organization || exp.departments.length > 0 });
    }
    if (org || view.products.length || view.departments.length) {
      reports.push({ type: "product", scopes: org ? ["organization"] : ["product"], ids: org ? [] : view.products, self: false, canExport: exp.organization || exp.products.length > 0 });
    }
    if (!reachIsEmpty(view)) {
      const projects = await projectsInReach(userId, "report.view", view);
      reports.push({ type: "project", scopes: projects === "all" ? ["organization"] : ["project"], ids: projects === "all" ? [] : projects, self: false, canExport: !reachIsEmpty(exp) });
    }
    reports.push({ type: "staff", scopes: org ? ["organization"] : reachIsEmpty(view) ? [] : ["scoped"], ids: [], self: true, canExport: !reachIsEmpty(exp) });
    reports.push({ type: "staff_product", scopes: org ? ["organization"] : view.products.length ? ["product"] : [], ids: org ? [] : view.products, self: true, canExport: !reachIsEmpty(exp) });
    reports.push({ type: "task", scopes: org ? ["organization"] : reachIsEmpty(view) ? [] : ["scoped"], ids: [], self: true, canExport: !reachIsEmpty(exp) });
    return { reports };
  },

  async executive(userId: string, q: { from?: string; to?: string }, permission = "report.view") {
    if (!(await can({ sub: userId }, permission, ORG))) throw denied();
    const range = rangeOf(q);
    const args = { from: range.from, to: range.to };
    const [staffRow] = await query<{ total: string; active: string; suspended: string }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'active') AS active, COUNT(*) FILTER (WHERE status = 'suspended') AS suspended FROM users`,
      {},
    );
    const [pending] = await query<{ pending: string }>(`SELECT COUNT(*) AS pending FROM tasks WHERE status IN ('submitted','in_review')`, {});
    const [meetingRow] = await query<{ held: string; cancelled: string }>(
      `SELECT COUNT(*) FILTER (WHERE status <> 'cancelled') AS held, COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled FROM meetings WHERE starts_at BETWEEN :from AND :to`,
      args,
    );
    const tasks = await taskTotals({}, range);
    const [departments, products] = await Promise.all([Department.findAll({ attributes: ["id", "name"], order: [["name", "ASC"]] }), Product.findAll({ attributes: ["id", "name", "stage"], order: [["name", "ASC"]] })]);
    const byDepartment = await Promise.all(departments.map(async (d) => ({ departmentId: d.id, name: d.name, ...(await this.departmentNumbers(d.id, range)) })));
    const byProduct = await Promise.all(products.map(async (p) => {
      const t = await taskTotals({ productId: p.id }, range);
      return { productId: p.id, name: p.name, open: t.open, completed: t.completed, overdue: t.overdue };
    }));
    return {
      range: rangeJson(range),
      staff: { total: Number(staffRow?.total ?? 0), active: Number(staffRow?.active ?? 0), suspended: Number(staffRow?.suspended ?? 0) },
      products: { total: products.length, live: products.filter((p) => p.stage === "live").length },
      projects: { total: await Project.count() },
      tasks,
      approvals: { pending: Number(pending?.pending ?? 0), avgHours: tasks.avgApprovalHours },
      targets: await targetTotals("TRUE", args),
      meetings: { held: Number(meetingRow?.held ?? 0), cancelled: Number(meetingRow?.cancelled ?? 0) },
      campaigns: (await marketingFor(null, range)).campaignStats,
      byDepartment,
      byProduct,
    };
  },

  async departmentNumbers(id: string, range: Range) {
    const t = await taskTotals(this.departmentTasks(id), range);
    return { open: t.open, completed: t.completed, overdue: t.overdue };
  },

  // A department's work: tasks in its lane, or done by its people.
  departmentTasks(id: string): WhereOptions {
    const members = sequelize.literal(`(SELECT ta.task_id FROM task_assignees ta JOIN department_members dm ON dm.user_id = ta.user_id WHERE dm.department_id = ${sequelize.escape(id)})`);
    return { [Op.or]: [{ departmentId: id }, { id: { [Op.in]: members } }] } as WhereOptions;
  },

  async department(id: string, userId: string, q: { from?: string; to?: string }, permission = "report.view") {
    const department = await Department.findByPk(id, { attributes: ["id", "name", "headId"] });
    if (!department) throw notFound("Department not found");
    if (!(await can({ sub: userId }, permission, { type: "department", id }))) throw denied();
    const range = rangeOf(q);
    const where = this.departmentTasks(id);
    const [tasks, summary] = await Promise.all([taskTotals(where, range), taskReports.breakdown(where, range)]);
    const memberRows = await query<{ user_id: string }>(`SELECT user_id FROM department_members WHERE department_id = :id`, { id });
    const memberIds = new Set(memberRows.map((m) => m.user_id));
    const args = { from: range.from, to: range.to, id };
    const work = await workDetail(where, range);
    return {
      range: rangeJson(range),
      department: { id: department.id, name: department.name, headId: department.headId ?? null },
      highlights: teamHighlights(department.name, tasks, work),
      completedWork: work.completedWork,
      inProgressWork: work.inProgressWork,
      overdueWork: work.overdueWork,
      members: staffRows(summary.byAssignee.filter((a) => memberIds.has(a.userId)), await avatars([...memberIds])),
      tasks,
      targets: await targetTotals(`(t.owner_type = 'department' AND t.owner_id = :id) OR t.id IN (SELECT a.target_id FROM target_assignments a JOIN department_members dm ON dm.user_id = a.user_id WHERE dm.department_id = :id)`, args),
      meetings: { held: await meetingsHeld(`m.scope_type = 'department' AND m.scope_id = :id`, args) },
    };
  },

  async product(id: string, userId: string, q: { from?: string; to?: string }, permission = "report.view") {
    const product = await Product.findByPk(id, { attributes: ["id", "name", "stage", "ownerId"] });
    if (!product) throw notFound("Product not found");
    const whole = await can({ sub: userId }, permission, { type: "product", id });
    const slice = whole ? [] : await departmentSlice(userId, permission, id);
    if (!whole && !slice.length) throw denied();

    const range = rangeOf(q);
    const allProjects = await Project.findAll({ where: { productId: id }, attributes: ["id", "name", "progress"] });
    const args = { from: range.from, to: range.to, id };

    if (!whole) {
      // A department head sees their department's part of this product and nothing else.
      const where = { productId: id, departmentId: slice };
      const [tasks, summary] = await Promise.all([taskTotals(where, range), taskReports.breakdown(where, range)]);
      const linked = await query<{ project_id: string }>(`SELECT project_id FROM project_departments WHERE department_id IN (:slice)`, { slice });
      const mine = new Set(linked.map((l) => l.project_id));
      return {
        range: rangeJson(range),
        slice: "department" as const,
        product: { id: product.id, name: product.name, stage: product.stage },
        team: staffRows(summary.byAssignee, await avatars(summary.byAssignee.map((a) => a.userId))),
        projects: await projectRows(allProjects.filter((p) => mine.has(p.id)), range),
        tasks,
        targets: await targetTotals(`t.owner_type = 'department' AND t.owner_id IN (:slice)`, { ...args, slice }),
        marketing: { campaigns: 0, leads: 0 },
        content: { planned: 0, published: 0 },
      };
    }

    const where = { productId: id };
    const [tasks, summary, marketing, work] = await Promise.all([taskTotals(where, range), taskReports.breakdown(where, range), marketingFor(id, range), workDetail(where, range)]);
    return {
      range: rangeJson(range),
      slice: "full" as const,
      product: { id: product.id, name: product.name, stage: product.stage },
      highlights: teamHighlights(product.name, tasks, work),
      completedWork: work.completedWork,
      inProgressWork: work.inProgressWork,
      overdueWork: work.overdueWork,
      team: staffRows(summary.byAssignee, await avatars(summary.byAssignee.map((a) => a.userId))),
      projects: await projectRows(allProjects, range),
      tasks,
      targets: await targetTotals(`(t.owner_type = 'product' AND t.owner_id = :id) OR t.source_config->>'productId' = :id`, args),
      marketing: marketing.marketing,
      content: marketing.content,
    };
  },

  async project(id: string, userId: string, q: { from?: string; to?: string }, permission = "report.view") {
    const project = await Project.findByPk(id, { attributes: ["id", "name", "progress", "productId"] });
    if (!project) throw notFound("Project not found");
    if (!(await can({ sub: userId }, permission, { type: "project", id }))) throw denied();
    const range = rangeOf(q);
    const where = { projectId: id };
    const [tasks, summary, openIssues, closedIssues] = await Promise.all([
      taskTotals(where, range),
      taskReports.breakdown(where, range),
      Issue.count({ where: { projectId: id, status: { [Op.ne]: "done" } } }),
      Issue.count({ where: { projectId: id, status: "done" } }),
    ]);
    const [prs] = await query<{ open: string; merged: string }>(
      `SELECT COUNT(*) FILTER (WHERE pr.status = 'open') AS open, COUNT(*) FILTER (WHERE pr.status = 'merged') AS merged
         FROM pull_requests pr JOIN tasks t ON t.id = pr.item_id AND pr.item_type = 'task' WHERE t.project_id = :id`,
      { id },
    );
    const work = await workDetail(where, range);
    return {
      range: rangeJson(range),
      project: { id: project.id, name: project.name, productId: project.productId ?? null },
      highlights: teamHighlights(project.name, tasks, work),
      completedWork: work.completedWork,
      inProgressWork: work.inProgressWork,
      overdueWork: work.overdueWork,
      tasks,
      issues: { open: openIssues, closed: closedIssues },
      pullRequests: { open: Number(prs?.open ?? 0), merged: Number(prs?.merged ?? 0) },
      team: staffRows(summary.byAssignee, await avatars(summary.byAssignee.map((a) => a.userId))),
      progress: project.progress,
    };
  },

  async staff(staffId: string, userId: string, q: { from?: string; to?: string }, permission = "report.view") {
    const staff = await User.findByPk(staffId, { attributes: ["id", "name", "avatarUrl", "email"] });
    if (!staff) throw notFound("Staff member not found");
    const self = staffId === userId;
    // Your own report is always yours to view and to export.
    const org = await can({ sub: userId }, permission, ORG);
    const covers = org || (await canOverUser(userId, permission, staffId));
    if (!self && !covers) throw denied();

    const full = org || self;
    const range = rangeOf(q);
    const assigned = sequelize.literal(`(SELECT task_id FROM task_assignees WHERE user_id = ${sequelize.escape(staffId)})`);
    // With a partial view, only the projects where the viewer holds the permission count.
    let projectLimit: string[] | null = null;
    if (!full) {
      const projects = await projectsInReach(userId, permission, await reachFor(userId, permission));
      projectLimit = projects === "all" ? null : projects;
    }
    const where: WhereOptions = { [Op.and]: [{ id: { [Op.in]: assigned } }, ...(projectLimit ? [{ projectId: projectLimit }] : [])] };
    const [tasks, work] = await Promise.all([taskTotals(where, range), workDetail(where, range)]);
    const args = { from: range.from, to: range.to, staffId, projects: projectLimit ?? [] };

    const [approvals] = await query<{ reviewed: string; hours: string | null }>(
      `SELECT COUNT(*) AS reviewed, AVG(EXTRACT(EPOCH FROM (r.created_at - s.created_at)) / 3600) AS hours
         FROM task_reviews r LEFT JOIN task_submissions s ON s.id = r.submission_id JOIN tasks t ON t.id = r.task_id
        WHERE r.reviewer_id = :staffId AND r.decision <> 'reassign' AND r.created_at BETWEEN :from AND :to
          ${projectLimit ? "AND t.project_id IN (:projects)" : ""}`,
      args,
    );
    const [meetingRow] = await query<{ invited: string; attended: string }>(
      `SELECT COUNT(*) AS invited, COUNT(*) FILTER (WHERE a.attendance IN ('present','late')) AS attended
         FROM meeting_attendees a JOIN meetings m ON m.id = a.meeting_id
        WHERE a.user_id = :staffId AND m.status <> 'cancelled' AND m.starts_at BETWEEN :from AND :to`,
      args,
    );
    const assignments = await query<{ departments: string[]; products: string[]; teams: string[] }>(
      `SELECT
         ARRAY(SELECT d.name FROM departments d JOIN department_members dm ON dm.department_id = d.id WHERE dm.user_id = :staffId) AS departments,
         ARRAY(SELECT p.name FROM products p JOIN product_members pm ON pm.product_id = p.id WHERE pm.user_id = :staffId) AS products,
         ARRAY(SELECT t.name FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = :staffId) AS teams`,
      { staffId },
    );
    const approvalTotals = { reviewed: Number(approvals?.reviewed ?? 0), avgHours: approvals?.hours != null ? Math.round(Number(approvals.hours) * 10) / 10 : null };
    const meetingTotals = { invited: Number(meetingRow?.invited ?? 0), attended: Number(meetingRow?.attended ?? 0) };
    const targets = await targetTotals(`t.id IN (SELECT target_id FROM target_assignments WHERE user_id = :staffId)`, args);
    const [creative, attended] = full ? await Promise.all([creativeOutput(staffId, range), meetingsAttended(staffId, range)]) : [null, []];
    return {
      range: rangeJson(range),
      staff: { id: staff.id, name: staff.name, avatarUrl: staff.avatarUrl ?? null },
      scope: full ? ("full" as const) : ("limited" as const),
      highlights: staffHighlights({ name: staff.name, tasks, work, creative, meetings: meetingTotals, approvals: approvalTotals, targets }),
      assignments: full ? assignments[0] : null,
      tasks,
      completedWork: work.completedWork,
      inProgressWork: work.inProgressWork,
      overdueWork: work.overdueWork,
      creativeOutput: creative?.totals ?? null,
      postsByPlatform: creative?.byPlatform ?? [],
      creativeWork: creative?.items ?? [],
      meetingsAttended: attended,
      approvals: approvalTotals,
      targets,
      meetings: meetingTotals,
      hr: await this.hrSection(staffId, userId, range),
    };
  },

  // Only HR sees queries in a report. People see their own appraisals.
  async hrSection(staffId: string, userId: string, range: Range) {
    const hr = await can({ sub: userId }, "hr.view");
    const self = staffId === userId;
    if (!hr && !self) return null;
    const args = { staffId, from: range.from, to: range.to };
    const [appraisals] = await query<{ total: string; completed: string; avg: string | null }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'completed') AS completed, AVG(overall_rating) FILTER (WHERE status = 'completed') AS avg
         FROM appraisals WHERE user_id = :staffId AND created_at BETWEEN :from AND :to`,
      args,
    );
    const appraisalPart = { total: Number(appraisals?.total ?? 0), completed: Number(appraisals?.completed ?? 0), avgRating: appraisals?.avg != null ? Number(appraisals.avg) : null };
    if (!hr) return { queries: null, appraisals: appraisalPart };
    const [queries] = await query<{ total: string; open: string }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status NOT IN ('resolved','withdrawn')) AS open FROM staff_queries WHERE staff_id = :staffId AND created_at BETWEEN :from AND :to`,
      args,
    );
    return { queries: { total: Number(queries?.total ?? 0), open: Number(queries?.open ?? 0) }, appraisals: appraisalPart };
  },

  async staffProduct(staffId: string, productId: string, userId: string, q: { from?: string; to?: string }, permission = "report.view") {
    const [staff, product] = await Promise.all([User.findByPk(staffId, { attributes: ["id", "name", "avatarUrl"] }), Product.findByPk(productId, { attributes: ["id", "name"] })]);
    if (!staff || !product) throw notFound("Not found");
    const self = staffId === userId && permission === "report.view";
    let allowed = self || (await can({ sub: userId }, permission, { type: "product", id: productId }));
    if (!allowed) {
      // A department head, for their own people, in products the department works on.
      const slice = await departmentSlice(userId, permission, productId);
      if (slice.length) {
        const inDept = await query(`SELECT 1 FROM department_members WHERE user_id = :staffId AND department_id IN (:slice) LIMIT 1`, { staffId, slice });
        allowed = inDept.length > 0;
      }
    }
    if (!allowed) throw denied();
    const range = rangeOf(q);
    const assigned = sequelize.literal(`(SELECT task_id FROM task_assignees WHERE user_id = ${sequelize.escape(staffId)})`);
    const where: WhereOptions = { productId, id: { [Op.in]: assigned } } as WhereOptions;
    const args = { from: range.from, to: range.to, staffId, productId };
    const [approvals] = await query<{ reviewed: string }>(
      `SELECT COUNT(*) AS reviewed FROM task_reviews r JOIN tasks t ON t.id = r.task_id WHERE r.reviewer_id = :staffId AND t.product_id = :productId AND r.decision <> 'reassign' AND r.created_at BETWEEN :from AND :to`,
      args,
    );
    const [meetingRow] = await query<{ attended: string }>(
      `SELECT COUNT(*) AS attended FROM meeting_attendees a JOIN meetings m ON m.id = a.meeting_id
        WHERE a.user_id = :staffId AND a.attendance IN ('present','late') AND m.scope_type = 'product' AND m.scope_id = :productId AND m.starts_at BETWEEN :from AND :to`,
      args,
    );
    const marketing = await marketingFor(productId, range);
    return {
      range: rangeJson(range),
      staff: { id: staff.id, name: staff.name, avatarUrl: staff.avatarUrl ?? null },
      product: { id: product.id, name: product.name },
      tasks: await taskTotals(where, range),
      approvals: { reviewed: Number(approvals?.reviewed ?? 0) },
      targets: await targetTotals(`t.id IN (SELECT target_id FROM target_assignments WHERE user_id = :staffId) AND (t.source_config->>'productId' = :productId OR (t.owner_type = 'product' AND t.owner_id = :productId))`, args),
      meetings: { attended: Number(meetingRow?.attended ?? 0) },
      content: await marketing.contentFor(staffId),
      campaigns: await marketing.campaignsBy(staffId),
    };
  },
};
