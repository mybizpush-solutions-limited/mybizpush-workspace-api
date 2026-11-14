import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canMoveQuery, isReached, nextTargetStatus, progressPercent, queryReference, rollup } from "./target.calc";

test("progress is clamped and handles targets that go down", () => {
  assert.equal(progressPercent(0, 100, 25), 25);
  assert.equal(progressPercent(0, 100, 150), 100);
  assert.equal(progressPercent(0, 100, -5), 0);
  assert.equal(progressPercent(80, 20, 50), 50);
  assert.equal(progressPercent(5, 5, 5), 100);
});

test("a group's value is the average, not the sum", () => {
  assert.equal(rollup([10, 20, 30]), 20);
  assert.equal(rollup([]), 0);
});

test("reaching a target depends on direction", () => {
  assert.equal(isReached(0, 100, 100), true);
  assert.equal(isReached(80, 20, 20), true);
  assert.equal(isReached(80, 20, 21), false);
});

const base = { status: "active" as const, evaluated: false, start: 0, target: 10, current: 5, endDate: "2026-03-31", today: "2026-03-15" };

test("targets finish by themselves", () => {
  assert.equal(nextTargetStatus(base), "active");
  assert.equal(nextTargetStatus({ ...base, current: 10 }), "achieved");
  assert.equal(nextTargetStatus({ ...base, today: "2026-04-01" }), "missed");
  assert.equal(nextTargetStatus({ ...base, today: "2026-03-31" }), "active");
  assert.equal(nextTargetStatus({ ...base, status: "missed", current: 10 }), "achieved");
});

test("a person's decision is final", () => {
  assert.equal(nextTargetStatus({ ...base, status: "missed", evaluated: true, current: 10 }), "missed");
  assert.equal(nextTargetStatus({ ...base, status: "cancelled", current: 10 }), "cancelled");
});

test("query status order", () => {
  assert.equal(canMoveQuery("issued", "responded"), true);
  assert.equal(canMoveQuery("issued", "under_review"), true);
  assert.equal(canMoveQuery("issued", "resolved"), false);
  assert.equal(canMoveQuery("resolved", "under_review"), false);
  assert.equal(canMoveQuery("withdrawn", "responded"), false);
});

test("query references are readable", () => {
  assert.equal(queryReference(7, new Date("2026-02-01T00:00:00Z")), "Q-2026-0007");
});
