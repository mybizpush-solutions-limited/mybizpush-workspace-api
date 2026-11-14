import { strict as assert } from "node:assert";
import { test } from "node:test";
import { occurrencesBetween } from "./occurrences";

const d = (s: string) => new Date(s);
const starts = (list: { start: Date }[]) => list.map((o) => o.start.toISOString().slice(0, 10));

test("a one-off meeting appears only if it overlaps the window", () => {
  const s = d("2026-03-10T09:00:00Z");
  const e = d("2026-03-10T10:00:00Z");
  assert.equal(occurrencesBetween(s, e, null, d("2026-03-10T09:30:00Z"), d("2026-03-11T00:00:00Z")).length, 1);
  assert.equal(occurrencesBetween(s, e, null, d("2026-03-10T10:00:00Z"), d("2026-03-11T00:00:00Z")).length, 0);
  assert.equal(occurrencesBetween(s, e, null, d("2026-03-01T00:00:00Z"), d("2026-03-10T09:00:00Z")).length, 0);
});

test("weekly with an interval", () => {
  const out = occurrencesBetween(d("2026-03-02T09:00:00Z"), d("2026-03-02T10:00:00Z"), { freq: "weekly", interval: 2 }, d("2026-03-01T00:00:00Z"), d("2026-04-01T00:00:00Z"));
  assert.deepEqual(starts(out), ["2026-03-02", "2026-03-16", "2026-03-30"]);
});

test("monthly keeps the day, clamping short months without drifting", () => {
  const out = occurrencesBetween(d("2026-01-31T09:00:00Z"), d("2026-01-31T10:00:00Z"), { freq: "monthly", interval: 1 }, d("2026-01-01T00:00:00Z"), d("2026-05-01T00:00:00Z"));
  assert.deepEqual(starts(out), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("count and until end the series", () => {
  const s = d("2026-03-02T09:00:00Z");
  const e = d("2026-03-02T10:00:00Z");
  const wide = [d("2026-01-01T00:00:00Z"), d("2027-01-01T00:00:00Z")] as const;
  assert.equal(occurrencesBetween(s, e, { freq: "daily", interval: 1, count: 3 }, ...wide).length, 3);
  assert.deepEqual(starts(occurrencesBetween(s, e, { freq: "daily", interval: 1, until: "2026-03-03" }, ...wide)), ["2026-03-02", "2026-03-03"]);
});

test("an occurrence in progress at the start of the window counts", () => {
  const out = occurrencesBetween(d("2026-03-02T23:00:00Z"), d("2026-03-03T01:00:00Z"), { freq: "daily", interval: 1, count: 1 }, d("2026-03-03T00:00:00Z"), d("2026-03-04T00:00:00Z"));
  assert.equal(out.length, 1);
});

test("an endless series is bounded", () => {
  const out = occurrencesBetween(d("2020-01-01T09:00:00Z"), d("2020-01-01T10:00:00Z"), { freq: "daily", interval: 1 }, d("2020-01-01T00:00:00Z"), d("2100-01-01T00:00:00Z"));
  assert.equal(out.length, 1000);
});
