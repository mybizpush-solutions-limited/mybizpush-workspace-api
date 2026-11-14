import { strict as assert } from "node:assert";
import { test } from "node:test";
import { summarizeTasks, type ReportTask } from "./task.report.calc";

const now = new Date("2026-06-15T12:00:00Z");
const range = { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-30T00:00:00Z") };
const task = (over: Partial<ReportTask>): ReportTask => ({
  id: "t",
  status: "in_progress",
  priority: "medium",
  projectId: "p",
  projectName: "Site",
  assignees: [{ id: "u", name: "Ada" }],
  dueDate: null,
  createdAt: new Date("2026-06-02T00:00:00Z"),
  completedAt: null,
  revisionCount: 0,
  ...over,
});

test("approved work counts as completed, rejected and cancelled do not", () => {
  const out = summarizeTasks(
    [
      task({ status: "approved", completedAt: new Date("2026-06-10T00:00:00Z") }),
      task({ status: "done", completedAt: new Date("2026-06-11T00:00:00Z") }),
      task({ status: "rejected" }),
      task({ status: "cancelled" }),
    ],
    range,
    now,
  );
  assert.equal(out.totals.completed, 2);
  assert.equal(out.totals.open, 0);
  assert.equal(out.totals.rejected, 1);
  assert.equal(out.totals.cancelled, 1);
});

test("overdue means past due and still open", () => {
  const past = new Date("2026-06-01T00:00:00Z");
  const out = summarizeTasks([task({ dueDate: past }), task({ status: "cancelled", dueDate: past }), task({ status: "draft" })], range, now);
  assert.equal(out.totals.overdue, 1);
  assert.equal(out.totals.open, 1);
});

test("on time rate only measures completed work with a due date", () => {
  const out = summarizeTasks(
    [
      task({ status: "approved", dueDate: new Date("2026-06-12T00:00:00Z"), completedAt: new Date("2026-06-10T00:00:00Z") }),
      task({ status: "approved", dueDate: new Date("2026-06-05T00:00:00Z"), completedAt: new Date("2026-06-10T00:00:00Z") }),
      task({ status: "approved", completedAt: new Date("2026-06-10T00:00:00Z") }),
    ],
    range,
    now,
  );
  assert.equal(out.totals.onTimeRate, 0.5);
});

test("the rate is null with nothing to measure, and completions outside the range do not count", () => {
  const out = summarizeTasks([task({ status: "approved", completedAt: new Date("2026-01-01T00:00:00Z") })], range, now);
  assert.equal(out.totals.onTimeRate, null);
  assert.equal(out.totals.completed, 0);
});

test("a task with two assignees counts for each person but once for the project", () => {
  const out = summarizeTasks([task({ assignees: [{ id: "a", name: "Ada" }, { id: "b", name: "Bola" }], revisionCount: 2 })], range, now);
  assert.equal(out.byAssignee.length, 2);
  assert.equal(out.byAssignee[0]!.revisions, 2);
  assert.equal(out.byProject[0]!.open, 1);
  assert.equal(out.totals.revisions, 2);
});
