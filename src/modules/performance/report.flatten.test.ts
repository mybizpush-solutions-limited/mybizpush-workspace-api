import { strict as assert } from "node:assert";
import { test } from "node:test";
import { flatten, rowCount } from "./report.flatten";

const report = {
  range: { from: "a", to: "b" },
  scope: "full",
  staff: { id: "x", name: "Ada", avatarUrl: "u" },
  tasks: { open: 2, completed: 1 },
  hr: null,
  team: [{ userId: "u1", name: "Ada", open: 2 }],
  empty: [],
};

test("nested values become a summary, lists become tables", () => {
  const out = flatten(report);
  assert.equal(out[0]!.title, "Key numbers");
  assert.deepEqual(out.map((s) => s.title), ["Key numbers", "Team"]);
  assert.ok(out[0]!.rows.some((r) => r.Measure === "Open" && r.Section === "Tasks" && r.Value === "2"));
});

test("ids and image links aren't exported", () => {
  const text = JSON.stringify(flatten(report));
  assert.ok(!text.includes("u1"));
  assert.ok(!text.includes("avatar"));
});

test("a section left out by the requester or hidden by the API stays out", () => {
  const out = flatten(report, ["tasks"]);
  assert.deepEqual(out.map((s) => s.title), ["Key numbers"]);
  assert.ok(out[0]!.rows.every((r) => r.Section === "Tasks"));
  assert.ok(!JSON.stringify(flatten(report)).includes("Hr"));
});

test("counts every row", () => {
  assert.equal(rowCount(flatten(report)), flatten(report)[0]!.rows.length + 1);
});
