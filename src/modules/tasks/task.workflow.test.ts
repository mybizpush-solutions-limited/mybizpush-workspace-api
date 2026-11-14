import { strict as assert } from "node:assert";
import { test } from "node:test";
import { allowedMoves, decideTransition, legacyStatusOf, statusGroup, wouldCreateCycle, type TaskActor } from "./task.workflow";
import { TASK_STATUSES } from "../../models/task-status";

const roles = (...r: TaskActor[]) => new Set<TaskActor>(r);

test("tasks without a reviewer keep free movement between the original statuses", () => {
  const d = decideTransition({ from: "in_review", to: "done", roles: roles(), hasReviewer: false });
  assert.equal(d.allowed, true);
});

test("a task with a reviewer cannot skip approval", () => {
  const d = decideTransition({ from: "in_review", to: "done", roles: roles("manager", "reviewer"), hasReviewer: true });
  assert.deepEqual([d.allowed, !d.allowed && d.code], [false, "invalid_transition"]);
});

test("decisions and submissions must use their own endpoints", () => {
  for (const to of ["approved", "rejected", "revision_required", "submitted"] as const) {
    const d = decideTransition({ from: "in_progress", to, roles: roles("reviewer", "assignee"), hasReviewer: false });
    assert.equal(!d.allowed && d.code, "use_endpoint", to);
  }
});

test("only the reviewer can approve through the review action", () => {
  const ok = decideTransition({ from: "submitted", to: "approved", roles: roles("reviewer"), hasReviewer: true, via: "review" });
  const no = decideTransition({ from: "submitted", to: "approved", roles: roles("assignee"), hasReviewer: true, via: "review" });
  assert.equal(ok.allowed, true);
  assert.equal(!no.allowed && no.code, "not_allowed_transition");
});

test("the assignee can submit from each working status", () => {
  for (const from of ["todo", "assigned", "accepted", "in_progress", "revision_required"] as const) {
    assert.equal(decideTransition({ from, to: "submitted", roles: roles("assignee"), hasReviewer: true, via: "submit" }).allowed, true, from);
  }
});

test("a closed task cannot be submitted without reopening", () => {
  for (const from of ["approved", "rejected", "cancelled", "done"] as const) {
    assert.equal(decideTransition({ from, to: "submitted", roles: roles("assignee", "manager"), hasReviewer: true, via: "submit" }).allowed, false, from);
  }
});

test("moving to the same status is a no-op that is always allowed", () => {
  assert.equal(decideTransition({ from: "cancelled", to: "cancelled", roles: roles(), hasReviewer: true }).allowed, true);
});

test("allowed moves follow the actor", () => {
  const assignee = allowedMoves("in_progress", roles("assignee"), true).map((m) => m.status).sort();
  assert.deepEqual(assignee, ["blocked", "submitted"]);
  const none = allowedMoves("in_progress", roles(), true);
  assert.deepEqual(none, []);
});

test("every status maps to an original value and a group", () => {
  for (const s of TASK_STATUSES) {
    assert.ok(["todo", "in_progress", "in_review", "blocked", "done"].includes(legacyStatusOf(s)), s);
    assert.ok(["draft", "open", "review", "closed"].includes(statusGroup(s)), s);
  }
});

test("dependency loops are detected", () => {
  const edges = new Map([["b", ["c"]], ["c", ["d"]]]);
  assert.equal(wouldCreateCycle(edges, "a", "a"), true);
  assert.equal(wouldCreateCycle(edges, "d", "b"), true);
  assert.equal(wouldCreateCycle(edges, "a", "b"), false);
});
