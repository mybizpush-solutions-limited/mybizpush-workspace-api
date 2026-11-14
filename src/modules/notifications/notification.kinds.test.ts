import { strict as assert } from "node:assert";
import { test } from "node:test";
import { categoryOf, CATEGORIES, deepLink, defaultChannels, isQuietNow, isSensitiveKind } from "./notification.kinds";

const quiet = { enabled: true, start: "22:00", end: "07:00", timezone: "UTC" };

test("quiet hours work across midnight", () => {
  assert.equal(isQuietNow(quiet, new Date("2026-01-01T23:30:00Z")), true);
  assert.equal(isQuietNow(quiet, new Date("2026-01-01T06:59:00Z")), true);
  assert.equal(isQuietNow(quiet, new Date("2026-01-01T07:00:00Z")), false);
  assert.equal(isQuietNow(quiet, new Date("2026-01-01T12:00:00Z")), false);
});

test("quiet hours work within one day and respect the time zone", () => {
  const day = { enabled: true, start: "09:00", end: "17:00", timezone: "Africa/Lagos" };
  assert.equal(isQuietNow(day, new Date("2026-01-01T08:30:00Z")), true); // 09:30 in Lagos
  assert.equal(isQuietNow(day, new Date("2026-01-01T07:30:00Z")), false);
});

test("off, or equal start and end, is never quiet", () => {
  assert.equal(isQuietNow({ ...quiet, enabled: false }, new Date("2026-01-01T23:30:00Z")), false);
  assert.equal(isQuietNow({ ...quiet, end: "22:00" }, new Date("2026-01-01T22:00:00Z")), false);
});

test("a bad time zone name doesn't throw", () => {
  assert.equal(typeof isQuietNow({ ...quiet, timezone: "Not/AZone" }), "boolean");
});

test("deep links use real plurals and messages open their conversation", () => {
  assert.equal(deepLink("query", "1"), "mybizpush://queries/1");
  assert.equal(deepLink("content", "1"), "mybizpush://content/1");
  assert.equal(deepLink("task", "1"), "mybizpush://tasks/1");
  assert.equal(deepLink("message", "m", { conversationId: "c" }), "mybizpush://conversations/c");
});

test("chat messages are push only by default", () => {
  assert.deepEqual(defaultChannels("message"), { inApp: false, push: true, email: false });
  assert.equal(defaultChannels("mention").inApp, true);
});

test("every kind maps to a known category and HR kinds are sensitive", () => {
  for (const k of ["assigned", "deadline", "query", "integration_failure", "unknown_new_kind"]) {
    assert.ok(CATEGORIES.includes(categoryOf(k)), k);
  }
  assert.equal(isSensitiveKind("query"), true);
  assert.equal(isSensitiveKind("message"), false);
});
