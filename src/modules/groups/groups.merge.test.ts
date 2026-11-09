import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mergeGroupMembers } from "./groups.merge";

const team = { type: "team" as const, id: "t1" };
const dept = { type: "department" as const, id: "d1" };

test("a person in two groups appears once and remembers both", () => {
  const out = mergeGroupMembers([
    { ref: team, userIds: ["a", "b"] },
    { ref: dept, userIds: ["b", "c"] },
  ]);
  assert.deepEqual(out.map((u) => u.userId).sort(), ["a", "b", "c"]);
  assert.deepEqual(out.find((u) => u.userId === "b")!.via, [team, dept]);
});

test("removed people stay out however many groups include them", () => {
  const out = mergeGroupMembers(
    [
      { ref: team, userIds: ["a", "b"] },
      { ref: dept, userIds: ["b"] },
    ],
    ["b"],
  );
  assert.deepEqual(out.map((u) => u.userId), ["a"]);
});

test("repeats within one group do not duplicate the group", () => {
  const out = mergeGroupMembers([{ ref: team, userIds: ["a", "a"] }]);
  assert.deepEqual(out, [{ userId: "a", via: [team] }]);
});
