import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CODE_STEP_SECONDS, issueCode, localDayAndTime, parseCode, verifyCode } from "./attendance.code";

const OFFICE = "11111111-1111-4111-8111-111111111111";
const SECRET = "a".repeat(64);
const NOW = 1_800_000_000_000;

test("a fresh code verifies", () => {
  const parsed = parseCode(issueCode(OFFICE, SECRET, NOW).code);
  assert.ok(parsed);
  assert.equal(parsed.officeId, OFFICE);
  assert.ok(verifyCode(parsed, SECRET, NOW));
});

test("a code still works in the next step, then expires", () => {
  const parsed = parseCode(issueCode(OFFICE, SECRET, NOW).code)!;
  assert.ok(verifyCode(parsed, SECRET, NOW + CODE_STEP_SECONDS * 1000));
  assert.ok(!verifyCode(parsed, SECRET, NOW + CODE_STEP_SECONDS * 2000 + 1));
});

test("a code from the future, another secret or a tampered signature fails", () => {
  const parsed = parseCode(issueCode(OFFICE, SECRET, NOW + CODE_STEP_SECONDS * 1000).code)!;
  assert.ok(!verifyCode(parsed, SECRET, NOW));
  const current = parseCode(issueCode(OFFICE, SECRET, NOW).code)!;
  assert.ok(!verifyCode(current, "b".repeat(64), NOW));
  assert.ok(!verifyCode({ ...current, signature: "x".repeat(current.signature.length) }, SECRET, NOW));
});

test("malformed codes are rejected", () => {
  assert.equal(parseCode("hello"), null);
  assert.equal(parseCode(`mbp1.${OFFICE}.abc.sig`), null);
  assert.equal(parseCode(`mbp2.${OFFICE}.1.${"x".repeat(24)}`), null);
});

test("local day and time follow the organization time zone", () => {
  const at = new Date("2026-11-20T23:30:00Z");
  assert.deepEqual(localDayAndTime(at, "Africa/Lagos"), { day: "2026-11-21", time: "00:30" });
  assert.deepEqual(localDayAndTime(at, "UTC"), { day: "2026-11-20", time: "23:30" });
});
