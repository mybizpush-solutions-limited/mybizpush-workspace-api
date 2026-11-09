import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 6238 TOTP — HMAC-SHA1, 30-second steps, 6 digits — the parameters every
// authenticator app (Google Authenticator, 1Password, Authy, Microsoft) assumes
// when an otpauth:// URI doesn't say otherwise. Written out rather than pulled
// in as a dependency: it's forty lines, and it's the same scheme Hyparrow uses.

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20; // 160 bits, RFC 4226's recommendation for SHA-1
// Accept the previous and next step too, so a phone clock a few seconds off, or
// a code typed just as it rolled over, still works. A code is live ≤ 90s.
const SKEW_STEPS = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / PERIOD_SECONDS);
}

function codeAt(key: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return bin.toString().padStart(DIGITS, "0");
}

// Returns the step the code matched, or null. The caller must refuse a step at
// or below the last one it accepted — that's the replay guard, and it needs the
// stored state this pure function doesn't have.
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const given = Buffer.from(code);
  const step = currentStep(now);
  for (let i = -SKEW_STEPS; i <= SKEW_STEPS; i++) {
    if (timingSafeEqual(Buffer.from(codeAt(key, step + i)), given)) return step + i;
  }
  return null;
}

export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
