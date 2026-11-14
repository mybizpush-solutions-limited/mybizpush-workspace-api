import { strict as assert } from "node:assert";
import { test } from "node:test";
import { currentStep, generateTotpSecret, otpauthUri, verifyTotp } from "./totp";

// RFC 6238 test vector secret ("12345678901234567890" in base32).
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("matches the RFC 6238 test vectors, last six digits", () => {
  // Published values: T=59 gives 94287082, T=1111111109 gives 07081804.
  assert.equal(verifyTotp(RFC_SECRET, "287082", 59_000), currentStep(59_000));
  assert.equal(verifyTotp(RFC_SECRET, "081804", 1111111109_000), currentStep(1111111109_000));
});

test("wrong or malformed codes fail", () => {
  assert.equal(verifyTotp(RFC_SECRET, "000000", 59_000), null);
  assert.equal(verifyTotp(RFC_SECRET, "12345", 59_000), null);
  assert.equal(verifyTotp(RFC_SECRET, "abcdef", 59_000), null);
});

test("allows one step of clock drift, no more", () => {
  assert.notEqual(verifyTotp(RFC_SECRET, "287082", 59_000 + 30_000), null);
  assert.equal(verifyTotp(RFC_SECRET, "287082", 59_000 + 90_000), null);
});

test("the URI holds what authenticator apps expect", () => {
  const uri = otpauthUri("MyBizPush", "a@b.c", "ABC");
  assert.ok(uri.startsWith("otpauth://totp/MyBizPush%3Aa%40b.c?"));
  for (const part of ["secret=ABC", "issuer=MyBizPush", "algorithm=SHA1", "digits=6", "period=30"]) assert.ok(uri.includes(part), part);
});

test("secrets are long base32", () => {
  assert.match(generateTotpSecret(), /^[A-Z2-7]{32}$/);
  assert.notEqual(generateTotpSecret(), generateTotpSecret());
});
