import { strict as assert } from "node:assert";
import { test } from "node:test";
import { diffAccess, isUuid, needsUrlRefresh, q, visibleCalendarEventsSql, visibleCommentsSql, visibleEmailLinksSql, visibleIdsSql, visibleItemsCondition, workItemConditions, type Reachish, type Viewer } from "./visibility.rules";

const A = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const none: Reachish = { organization: false, products: [], departments: [], teams: [], projects: [] };
const member = (over: Partial<Viewer> = {}): Viewer => ({
  userId: A,
  seesEverything: false,
  workProjects: [],
  taskViewProducts: [],
  seesAllQueries: false,
  hrView: false,
  announcementPublish: none,
  targetReports: none,
  contentCreate: none,
  campaignView: none,
  productEdit: none,
  ...over,
});

test("only a uuid can reach the SQL", () => {
  assert.equal(q(A), `'${A}'`);
  for (const bad of ["x", "' OR 1=1 --", `${A}'`, ""]) assert.throws(() => q(bad));
  assert.throws(() => visibleIdsSql(member({ userId: "' OR 1=1 --" }), "task"));
});

test("executives and chiefs see all work, as does someone assigning organization wide", () => {
  assert.equal(workItemConditions(member({ seesEverything: true }), "task"), null);
  assert.equal(workItemConditions(member({ workProjects: "all" }), "issue"), null);
});

test("a plain member gets only conditions that name a connection", () => {
  const sql = workItemConditions(member(), "task")!.join(" ");
  for (const part of ["reporter_id", "reviewer_id", "feedback_awaiting_from", "task_assignees", "team_id"]) assert.ok(sql.includes(part), part);
  assert.ok(sql.includes(`= '${A}'`));
  assert.ok(!sql.includes("TRUE"));
  assert.ok(!sql.includes("COALESCE(t.product_id"), "no product access without task.view there");
});

test("product access needs both task.view there and being in the product", () => {
  const sql = workItemConditions(member({ taskViewProducts: [P] }), "task")!.join(" ");
  assert.match(sql, new RegExp(`IN \\('${P}'\\) AND COALESCE\\(t\\.product_id, p\\.product_id\\) IN`));
});

test("scoped assign or approve opens only those projects", () => {
  const sql = workItemConditions(member({ workProjects: [P] }), "task")!.join(" ");
  assert.ok(sql.includes(`t.project_id IN ('${P}')`));
});

test("issues have no reviewer or team", () => {
  const sql = workItemConditions(member(), "issue")!.join(" ");
  assert.ok(sql.includes("issue_assignees"));
  assert.ok(!sql.includes("reviewer_id"));
  assert.ok(!sql.includes("i.team_id"));
});

test("confidential records stay with their people", () => {
  assert.ok(visibleIdsSql(member(), "query").includes("q.staff_id ="));
  assert.equal(visibleIdsSql(member({ seesAllQueries: true }), "query"), "SELECT q.id FROM staff_queries q");
  // Being an executive isn't HR access.
  assert.ok(visibleIdsSql(member({ seesEverything: true }), "query").includes("WHERE"));
  assert.ok(visibleIdsSql(member({ seesEverything: true }), "appraisal").includes("WHERE"));
  assert.ok(visibleIdsSql(member({ seesEverything: true }), "conversation").includes("left_at IS NULL"));
});

test("holding nothing on campaigns sees none", () => {
  assert.ok(visibleIdsSql(member(), "campaign").endsWith("WHERE FALSE"));
  assert.ok(visibleIdsSql(member({ campaignView: { ...none, products: [P] } }), "campaign").includes(P));
});

test("attached rows are tested against their own kind of record", () => {
  const sql = visibleItemsCondition(member(), "c.item_type", "c.item_id");
  for (const kind of ["task", "issue", "meeting", "query", "content", "message"]) assert.ok(sql.includes(`c.item_type::text = '${kind}'`), kind);
});

test("access changes are found both ways", () => {
  const recorded = new Map([["keep", true], ["lost", true], ["back", false], ["gone-before", false]]);
  const { granted, revoked } = diffAccess(new Set(["keep", "back", "new"]), recorded);
  assert.deepEqual(granted.sort(), ["back", "new"]);
  assert.deepEqual(revoked, ["lost"]);
});

test("nothing changes when nothing changed", () => {
  assert.deepEqual(diffAccess(new Set(["a"]), new Map([["a", true], ["b", false]])), { granted: [], revoked: [] });
});

test("file links refresh at half their life", () => {
  const ttl = 7 * 86400;
  const now = Date.parse("2026-01-10T00:00:00Z");
  assert.equal(needsUrlRefresh(undefined, now, ttl), true);
  assert.equal(needsUrlRefresh("nonsense", now, ttl), true);
  assert.equal(needsUrlRefresh("2026-01-09T00:00:00Z", now, ttl), false);
  assert.equal(needsUrlRefresh("2026-01-01T00:00:00Z", now, ttl), true);
});

test("comments and linked emails follow the record, and a link stays with whoever linked it", () => {
  const comments = visibleCommentsSql(member());
  for (const kind of ["task", "issue", "meeting", "announcement", "content", "campaign", "target", "project", "product"]) assert.ok(comments.includes(`c.item_type::text = '${kind}'`), kind);
  const links = visibleEmailLinksSql(member());
  assert.ok(links.includes(`l.linked_by = '${A}'`));
  for (const kind of ["task", "issue", "project", "product"]) assert.ok(links.includes(`l.record_type::text = '${kind}'`), kind);
});

test("calendar events: scope and creator, or all for executives", () => {
  assert.ok(!visibleCalendarEventsSql(member({ seesEverything: true })).includes("WHERE"));
  const sql = visibleCalendarEventsSql(member());
  assert.ok(sql.includes(`e.created_by = '${A}'`));
  assert.ok(sql.includes("e.scope_type = 'organization'"));
});

test("a malformed id is recognized before it reaches SQL", () => {
  assert.equal(isUuid(A), true);
  assert.equal(isUuid("not-a-uuid"), false);
});
