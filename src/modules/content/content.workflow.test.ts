import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CONTENT_TRANSITIONS, decideContentMove, type ContentActor } from "./content.workflow";

const roles = (...r: ContentActor[]) => new Set<ContentActor>(r);

test("the normal path works", () => {
  const path = [["idea", "briefed", "manager"], ["briefed", "in_progress", "writer"], ["in_progress", "in_design", "writer"], ["in_design", "in_review", "designer"]] as const;
  for (const [from, to, who] of path) assert.equal(decideContentMove({ from, to, roles: roles(who) }).allowed, true, `${from}>${to}`);
  assert.equal(decideContentMove({ from: "in_review", to: "approved", roles: roles("reviewer"), via: "review" }).allowed, true);
  assert.equal(decideContentMove({ from: "approved", to: "scheduled", roles: roles("reviewer") }).allowed, true);
  assert.equal(decideContentMove({ from: "scheduled", to: "published", roles: roles("manager"), via: "publish" }).allowed, true);
});

test("approval and publishing need their own actions", () => {
  const a = decideContentMove({ from: "in_review", to: "approved", roles: roles("reviewer", "manager") });
  assert.equal(!a.allowed && a.code, "use_endpoint");
  const p = decideContentMove({ from: "approved", to: "published", roles: roles("manager") });
  assert.equal(!p.allowed && p.code, "use_endpoint");
});

test("nothing is published or approved without going through review", () => {
  const skip = decideContentMove({ from: "in_progress", to: "published", roles: roles("manager"), via: "publish" });
  assert.equal(!skip.allowed && skip.code, "invalid_transition");
  const appr = decideContentMove({ from: "in_progress", to: "approved", roles: roles("reviewer"), via: "review" });
  assert.equal(!appr.allowed && appr.code, "invalid_transition");
});

test("writers can't approve, and only managers cancel", () => {
  const w = decideContentMove({ from: "in_review", to: "approved", roles: roles("writer"), via: "review" });
  assert.equal(!w.allowed && w.code, "not_allowed_transition");
  const c = decideContentMove({ from: "in_progress", to: "cancelled", roles: roles("writer") });
  assert.equal(!c.allowed && c.code, "not_allowed_transition");
});

test("taking a scheduled item back is a plain move", () => {
  assert.equal(decideContentMove({ from: "scheduled", to: "approved", roles: roles("reviewer") }).allowed, true);
});

test("published is final", () => {
  assert.ok(!CONTENT_TRANSITIONS.some((t) => t.from === "published"));
});
