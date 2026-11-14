// Who can see what (API-CHANGES A1001). Pure: this file only builds SQL from facts
// already known about the viewer, so the rules can be read and tested on their own.
// Every read and write path goes through visibility.ts, which uses these.
//
// The default is no access. A record is visible only because one of these conditions
// names the viewer's connection to it.

export interface Viewer {
  userId: string;
  // executive_admin or chief, from the stored access level.
  seesEverything: boolean;
  // Projects where they hold task.assign or task.approve.
  workProjects: "all" | string[];
  // Products where they hold task.view by a scoped grant. Org-wide doesn't count.
  taskViewProducts: string[];
  seesAllQueries: boolean;
  hrView: boolean;
  announcementPublish: Reachish;
  targetReports: Reachish;
  contentCreate: Reachish;
  campaignView: Reachish;
  productEdit: Reachish;
}

// Where someone holds a permission.
export interface Reachish {
  organization: boolean;
  products: string[];
  departments: string[];
  teams: string[];
  projects: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Everything put into these statements is a uuid, checked here, so nothing from a
// request can change the SQL.
export const isUuid = (id: string) => UUID.test(id);

export function q(id: string): string {
  if (!UUID.test(id)) throw new Error("Not a uuid");
  return `'${id.toLowerCase()}'`;
}
const list = (ids: string[]) => ids.map(q).join(",");

// Rows (scope_type, scope_id) for everywhere this person belongs.
export function myScopesSql(userId: string): string {
  const u = q(userId);
  return `(
    SELECT 'department' AS scope_type, department_id AS scope_id FROM department_members WHERE user_id = ${u}
    UNION SELECT 'team', team_id FROM team_members WHERE user_id = ${u}
    UNION SELECT 'product', product_id FROM product_members WHERE user_id = ${u}
    UNION SELECT 'product', id FROM products WHERE owner_id = ${u}
    UNION SELECT 'project', project_id FROM project_members WHERE user_id = ${u}
    UNION SELECT 'project', id FROM projects WHERE manager_id = ${u}
    UNION SELECT 'project', pd.project_id FROM project_departments pd JOIN department_members dm ON dm.department_id = pd.department_id WHERE dm.user_id = ${u}
    UNION SELECT 'project', p.id FROM projects p JOIN department_members dm ON dm.department_id = p.department_id WHERE dm.user_id = ${u}
  )`;
}

const scopeIds = (userId: string, type: string) => `(SELECT scope_id FROM ${myScopesSql(userId)} s WHERE s.scope_type = '${type}')`;

// A condition on a table with scope_type and scope_id columns.
export function inMyScopesSql(userId: string, table: string): string {
  return `(${table}.scope_type = 'organization' OR (${table}.scope_type::text, ${table}.scope_id) IN (SELECT scope_type, scope_id FROM ${myScopesSql(userId)} s))`;
}

// The conditions for a task or issue. Null means no condition: they see them all.
export function workItemConditions(v: Viewer, kind: "task" | "issue"): string[] | null {
  if (v.seesEverything || v.workProjects === "all") return null;
  const u = q(v.userId);
  const a = kind === "task" ? "t" : "i";
  const assignees = kind === "task" ? `SELECT task_id FROM task_assignees WHERE user_id = ${u}` : `SELECT issue_id FROM issue_assignees WHERE user_id = ${u}`;
  const out = [
    `${a}.reporter_id = ${u}`,
    `${a}.feedback_awaiting_from = ${u}`,
    `${a}.id IN (${assignees})`,
    `${a}.project_id IN ${scopeIds(v.userId, "project")}`,
    `${a}.department_id IN ${scopeIds(v.userId, "department")}`,
  ];
  if (kind === "task") {
    out.push(`t.reviewer_id = ${u}`, `t.team_id IN ${scopeIds(v.userId, "team")}`);
  }
  if (v.taskViewProducts.length) {
    // A member or the owner, and holding task.view there: both, not either.
    const product = kind === "task" ? "COALESCE(t.product_id, p.product_id)" : "p.product_id";
    out.push(`(${product} IN (${list(v.taskViewProducts)}) AND ${product} IN ${scopeIds(v.userId, "product")})`);
  }
  if (v.workProjects.length) out.push(`${a}.project_id IN (${list(v.workProjects)})`);
  return out;
}

const orJoin = (conds: string[]) => (conds.length ? `(${conds.join(" OR ")})` : "FALSE");

function reachConditions(r: Reachish, col: { type: string; id: string }): string[] {
  const out: string[] = [];
  for (const [type, ids] of [["department", r.departments], ["team", r.teams], ["product", r.products], ["project", r.projects]] as const) {
    if (ids.length) out.push(`(${col.type} = '${type}' AND ${col.id} IN (${list(ids)}))`);
  }
  return out;
}

export const RECORD_KINDS = ["task", "issue", "meeting", "announcement", "query", "appraisal", "target", "content", "campaign", "conversation", "message", "project", "product"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

// A statement returning the ids of this kind of record the viewer can see.
export function visibleIdsSql(v: Viewer, kind: RecordKind): string {
  const u = q(v.userId);
  switch (kind) {
    case "task": {
      const c = workItemConditions(v, "task");
      return `SELECT t.id FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE ${c ? orJoin(c) : "TRUE"}`;
    }
    case "issue": {
      const c = workItemConditions(v, "issue");
      return `SELECT i.id FROM issues i LEFT JOIN projects p ON p.id = i.project_id WHERE ${c ? orJoin(c) : "TRUE"}`;
    }
    case "meeting":
      if (v.seesEverything) return "SELECT m.id FROM meetings m";
      return `SELECT m.id FROM meetings m WHERE m.organizer_id = ${u} OR m.id IN (SELECT meeting_id FROM meeting_attendees WHERE user_id = ${u}) OR ${inMyScopesSql(v.userId, "m")}`;
    case "announcement": {
      const r = v.announcementPublish;
      if (r.organization) return "SELECT a.id FROM announcements a";
      const held: string[] = [];
      for (const [type, ids] of [["department", r.departments], ["team", r.teams], ["product", r.products], ["project", r.projects]] as const) {
        if (ids.length) held.push(`(a.audience_type = '${type}' AND a.audience_ids && ARRAY[${list(ids)}]::uuid[])`);
      }
      return `SELECT a.id FROM announcements a WHERE ${orJoin([`a.created_by = ${u}`, `a.id IN (SELECT announcement_id FROM announcement_receipts WHERE user_id = ${u})`, ...held])}`;
    }
    case "query":
      if (v.seesAllQueries) return "SELECT q.id FROM staff_queries q";
      return `SELECT q.id FROM staff_queries q WHERE q.staff_id = ${u} OR q.issued_by = ${u}`;
    case "appraisal":
      if (v.hrView) return "SELECT a.id FROM appraisals a";
      return `SELECT a.id FROM appraisals a WHERE a.user_id = ${u} OR a.manager_id = ${u}`;
    case "target": {
      const r = v.targetReports;
      if (r.organization) return "SELECT t.id FROM targets t";
      const conds = [
        `t.reviewer_id = ${u}`,
        `t.created_by = ${u}`,
        `t.id IN (SELECT target_id FROM target_assignments WHERE user_id = ${u})`,
        ...reachConditions(r, { type: "t.owner_type", id: "t.owner_id" }),
      ];
      // A person's target, for someone reporting on a group that person is in.
      if (r.departments.length) conds.push(`(t.owner_type = 'user' AND t.owner_id IN (SELECT user_id FROM department_members WHERE department_id IN (${list(r.departments)})))`);
      if (r.teams.length) conds.push(`(t.owner_type = 'user' AND t.owner_id IN (SELECT user_id FROM team_members WHERE team_id IN (${list(r.teams)})))`);
      if (r.products.length) conds.push(`(t.owner_type = 'user' AND t.owner_id IN (SELECT user_id FROM product_members WHERE product_id IN (${list(r.products)})))`);
      return `SELECT t.id FROM targets t WHERE ${orJoin(conds)}`;
    }
    case "content": {
      const r = v.contentCreate;
      if (r.organization) return "SELECT c.id FROM content_items c";
      const conds = [
        `c.writer_id = ${u}`,
        `c.designer_id = ${u}`,
        `c.reviewer_id = ${u}`,
        `c.created_by = ${u}`,
        `c.product_id IN ${scopeIds(v.userId, "product")}`,
      ];
      if (r.products.length) conds.push(`c.product_id IN (${list(r.products)})`);
      return `SELECT c.id FROM content_items c WHERE ${orJoin(conds)}`;
    }
    case "campaign": {
      const r = v.campaignView;
      if (r.organization) return "SELECT c.id FROM campaigns c";
      return `SELECT c.id FROM campaigns c WHERE ${r.products.length ? `c.product_id IN (${list(r.products)})` : "FALSE"}`;
    }
    case "conversation":
      return `SELECT conversation_id AS id FROM conversation_members WHERE user_id = ${u} AND left_at IS NULL`;
    case "message":
      return `SELECT m.id FROM messages m WHERE m.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ${u} AND left_at IS NULL)`;
    case "project": {
      if (v.seesEverything || v.workProjects === "all") return "SELECT p.id FROM projects p";
      const conds = [`p.id IN ${scopeIds(v.userId, "project")}`];
      if (v.workProjects.length) conds.push(`p.id IN (${list(v.workProjects)})`);
      return `SELECT p.id FROM projects p WHERE ${orJoin(conds)}`;
    }
    case "product": {
      const r = v.productEdit;
      if (v.seesEverything || r.organization) return "SELECT p.id FROM products p";
      const conds = [`p.id IN ${scopeIds(v.userId, "product")}`];
      if (r.products.length) conds.push(`p.id IN (${list(r.products)})`);
      return `SELECT p.id FROM products p WHERE ${orJoin(conds)}`;
    }
  }
}

// A calendar event: its scope, and whoever made it. Executives and chiefs see them all.
export function visibleCalendarEventsSql(v: Viewer): string {
  if (v.seesEverything) return "SELECT e.id FROM calendar_events e";
  return `SELECT e.id FROM calendar_events e WHERE e.created_by = ${q(v.userId)} OR ${inMyScopesSql(v.userId, "e")}`;
}

// For tables holding (item_type, item_id): comments, activity, attachments.
export function visibleItemsCondition(v: Viewer, typeCol: string, idCol: string): string {
  return orJoin(RECORD_KINDS.map((kind) => `(${typeCol}::text = '${kind}' AND ${idCol} IN (${visibleIdsSql(v, kind)}))`));
}

export const visibleCommentsSql = (v: Viewer) => `SELECT c.id FROM comments c WHERE ${visibleItemsCondition(v, "c.item_type", "c.item_id")}`;

// A linked email: the person who linked it, and those who can see the record.
export function visibleEmailLinksSql(v: Viewer): string {
  const onRecord = (["task", "issue", "project", "product"] as const).map((kind) => `(l.record_type::text = '${kind}' AND l.record_id IN (${visibleIdsSql(v, kind)}))`);
  return `SELECT l.id FROM email_thread_links l WHERE ${orJoin([`l.linked_by = ${q(v.userId)}`, ...onRecord])}`;
}

// ---- Access changes for sync ---------------------------------------------------

// Compares what someone can see now with what was last recorded. Pure.
export function diffAccess(current: ReadonlySet<string>, recorded: ReadonlyMap<string, boolean>): { granted: string[]; revoked: string[] } {
  const granted: string[] = [];
  const revoked: string[] = [];
  for (const id of current) if (recorded.get(id) !== true) granted.push(id);
  for (const [id, had] of recorded) if (had && !current.has(id)) revoked.push(id);
  return { granted, revoked };
}

// Links are refreshed at half their life, so one always outlasts a gap between syncs.
export function needsUrlRefresh(lastRefreshIso: string | undefined, now: number, ttlSeconds: number): boolean {
  if (!lastRefreshIso) return true;
  const last = new Date(lastRefreshIso).getTime();
  return Number.isNaN(last) || now - last >= (ttlSeconds * 1000) / 2;
}
