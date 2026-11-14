import { strict as assert } from "node:assert";
import { test } from "node:test";
import { operationByKey, OPERATIONS } from "./operations";
import { isReady, matchOne, parseModelJson, resolveFields, type Candidate, type Lookup } from "./resolve";

const c = (id: string, label: string): Candidate => ({ id, label });
const people: Record<string, Candidate[]> = {
  daniel: [c("d1", "Daniel Okafor"), c("d2", "Daniel Ade")],
  ada: [c("a1", "Ada Obi")],
  "daniel okafor": [c("d1", "Daniel Okafor")],
};
const lookup: Lookup = async (type, q) => {
  if (type === "staff") return people[q.toLowerCase()] ?? [];
  if (type === "project") return q === "Site" ? [c("p1", "Site")] : [];
  if (type === "department") return q === "Sales" ? [c("dep1", "Sales")] : [];
  if (type === "team") return q === "Growth" ? [c("t1", "Growth")] : [];
  return [];
};
const ctx = { now: new Date("2026-11-09T12:00:00Z"), timezone: "Africa/Lagos" };
const op = (key: string) => operationByKey(key)!;
const byName = (fields: Awaited<ReturnType<typeof resolveFields>>, name: string) => fields.find((f) => f.name === name)!;

test("several matches are never picked for the user", async () => {
  const f = await resolveFields(op("create_task"), { title: "X", assigneeIds: ["Daniel"], reviewerId: "Daniel" }, ctx, lookup);
  const a = byName(f, "assigneeIds");
  assert.equal(a.status, "ambiguous");
  assert.equal(a.value, null);
  assert.equal(a.candidates.length, 2);
  assert.equal(byName(f, "reviewerId").value, null);
});

test("one exact name among partial matches isn't ambiguous", () => {
  const m = matchOne("Daniel Ade", [c("1", "Daniel Ade"), c("2", "Daniel Adewale")]);
  assert.equal(m.match?.id, "1");
  assert.equal(matchOne("Dan", [c("1", "Dan A"), c("2", "Dan B")]).status, "ambiguous");
  // Two people with the same full name still need a choice.
  const twins = matchOne("Dan A", [c("1", "Dan A"), c("2", "Dan A")]);
  assert.equal(twins.status, "ambiguous");
  assert.equal(twins.candidates.length, 2);
});

test("a partial command gives a partly filled form", async () => {
  const f = await resolveFields(op("create_task"), { title: "Redesign", assigneeIds: ["Ada"], dueDate: "2026-11-13T17:00:00Z" }, ctx, lookup);
  assert.equal(byName(f, "title").status, "extracted");
  assert.deepEqual(byName(f, "assigneeIds").value, ["a1"]);
  assert.equal(byName(f, "dueDate").status, "resolved");
  assert.equal(byName(f, "projectId").status, "missing");
  assert.equal(isReady(op("create_task"), f), false);
});

test("context fills what wasn't said, and says so", async () => {
  const f = await resolveFields(op("create_task"), { title: "X" }, { ...ctx, projectId: "p9" }, lookup);
  const p = byName(f, "projectId");
  assert.deepEqual([p.status, p.value, p.message], ["resolved", "p9", "From your current context"]);
  assert.equal(isReady(op("create_task"), f), true);
});

test("what was said beats the context", async () => {
  const f = await resolveFields(op("create_task"), { title: "X", projectId: "Site" }, { ...ctx, projectId: "p9" }, lookup);
  assert.equal(byName(f, "projectId").value, "p1");
});

test("unknown names and bad values say what's wrong", async () => {
  const f = await resolveFields(op("create_task"), { title: "X", reviewerId: "Nobody", priority: "enormous", dueDate: "soonish" }, { ...ctx, projectId: "p" }, lookup);
  assert.equal(byName(f, "reviewerId").status, "unmatched");
  assert.equal(byName(f, "priority").status, "invalid");
  assert.equal(byName(f, "dueDate").status, "invalid");
  assert.equal(isReady(op("create_task"), f), false);
});

test("the past isn't accepted where a future time is needed", async () => {
  const f = await resolveFields(op("schedule_meeting"), { title: "X", startsAt: "2026-11-08T09:00:00Z" }, ctx, lookup);
  assert.equal(byName(f, "startsAt").status, "invalid");
});

test("lists keep what's settled when one name is open", async () => {
  const f = await resolveFields(op("create_task"), { title: "X", assigneeIds: ["Ada", "Daniel"] }, ctx, lookup);
  const a = byName(f, "assigneeIds");
  assert.deepEqual([a.status, a.value, a.partial], ["ambiguous", null, ["a1"]]);
  const none = byName(await resolveFields(op("create_task"), { assigneeIds: ["Ada", "Zed"] }, ctx, lookup), "assigneeIds");
  assert.deepEqual([none.status, none.value, none.partial], ["unmatched", null, ["a1"]]);
});

test("the same person named twice counts once", async () => {
  const f = await resolveFields(op("create_task"), { assigneeIds: ["Ada", "ada"] }, ctx, lookup);
  assert.deepEqual(byName(f, "assigneeIds").value, ["a1"]);
});

test("choices forgive spacing and case", async () => {
  const f = await resolveFields(op("update_task_status"), { taskId: "x", status: "In Progress" }, ctx, lookup);
  assert.equal(byName(f, "status").value, "in_progress");
});

test("groups and audiences resolve", async () => {
  const g = await resolveFields(op("schedule_meeting"), { title: "X", startsAt: "2026-11-10T09:00:00Z", groups: [{ type: "team", name: "Growth" }] }, ctx, lookup);
  assert.deepEqual(byName(g, "groups").value, [{ type: "team", id: "t1" }]);
  const a = await resolveFields(op("announce"), { title: "T", body: "B", audience: { type: "department", names: ["Sales"] } }, ctx, lookup);
  assert.deepEqual(byName(a, "audience").value, { type: "department", ids: ["dep1"] });
  const e = await resolveFields(op("announce"), { title: "T", body: "B", audience: { type: "organization" } }, ctx, lookup);
  assert.equal(isReady(op("announce"), e), true);
  const bad = await resolveFields(op("announce"), { audience: { type: "department", names: ["Nope"] } }, ctx, lookup);
  assert.equal(byName(bad, "audience").status, "unmatched");
  assert.equal(byName(await resolveFields(op("announce"), { audience: "people" }, ctx, lookup), "audience").status, "invalid");
});

test("a scope field looks in the kind its partner names", async () => {
  const f = await resolveFields(op("create_event"), { title: "T", scopeType: "department", scopeId: "Sales", startsAt: "2026-11-10T09:00:00Z" }, ctx, lookup);
  assert.equal(byName(f, "scopeId").value, "dep1");
  assert.equal(isReady(op("create_event"), f), true);
});

test("a scope is only needed when the kind calls for one", async () => {
  const org = await resolveFields(op("create_event"), { title: "T", scopeType: "organization", startsAt: "2026-11-10T09:00:00Z" }, ctx, lookup);
  assert.equal(isReady(op("create_event"), org), true);
  const dept = await resolveFields(op("create_event"), { title: "T", scopeType: "department", startsAt: "2026-11-10T09:00:00Z" }, ctx, lookup);
  assert.equal(isReady(op("create_event"), dept), false);
});

test("a message needs somebody to go to", async () => {
  const none = await resolveFields(op("send_message"), { body: "Hi" }, ctx, lookup);
  assert.equal(isReady(op("send_message"), none), false);
  const to = await resolveFields(op("send_message"), { body: "Hi", recipientIds: ["Ada"] }, ctx, lookup);
  assert.equal(isReady(op("send_message"), to), true);
});

test("model output is read carefully", () => {
  assert.deepEqual(parseModelJson('Sure!\n```json\n{"operation":"x"}\n```'), { operation: "x" });
  assert.equal(parseModelJson("no json here"), null);
  assert.equal(parseModelJson("{broken"), null);
  assert.equal(parseModelJson('{"a":'), null);
});

test("every operation has a schema and required fields it can satisfy", () => {
  for (const o of OPERATIONS) {
    assert.ok(o.schema, o.key);
    assert.ok(o.fields.length > 0, o.key);
    assert.equal(new Set(o.fields.map((f) => f.name)).size, o.fields.length, o.key);
  }
});

test("schemas refuse what the form can't produce", () => {
  assert.equal(op("create_task").schema.safeParse({ title: "x", projectId: "not-a-uuid" }).success, false);
  assert.equal(op("send_message").schema.safeParse({ body: "Hi" }).success, false);
  assert.equal(op("update_task_status").schema.safeParse({ taskId: "00000000-0000-4000-8000-000000000000", status: "approved" }).success, false);
});
