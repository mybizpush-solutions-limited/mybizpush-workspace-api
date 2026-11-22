import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The office screen shows a QR code that changes every CODE_STEP_SECONDS. A code
// is only accepted during its own step and the one after, so a photo of the
// screen stops working within a minute and the code can't be reused from home.
export const CODE_STEP_SECONDS = 30;
const ACCEPTED_STEPS = 2;
const SIGNATURE_LENGTH = 24;

export function newCodeSecret(): string {
  return randomBytes(32).toString("hex");
}

export function stepAt(time: number): number {
  return Math.floor(time / 1000 / CODE_STEP_SECONDS);
}

function sign(secret: string, officeId: string, step: number): string {
  return createHmac("sha256", secret).update(`${officeId}.${step}`).digest("base64url").slice(0, SIGNATURE_LENGTH);
}

export function issueCode(officeId: string, secret: string, now = Date.now()): { code: string; expiresAt: Date } {
  const step = stepAt(now);
  return { code: `mbp1.${officeId}.${step}.${sign(secret, officeId, step)}`, expiresAt: new Date((step + 1) * CODE_STEP_SECONDS * 1000) };
}

export function parseCode(code: string): { officeId: string; step: number; signature: string } | null {
  const parts = code.trim().split(".");
  if (parts.length !== 4 || parts[0] !== "mbp1") return null;
  const [, officeId, rawStep, signature] = parts as [string, string, string, string];
  const step = Number(rawStep);
  if (!/^[0-9a-f-]{36}$/i.test(officeId) || !Number.isInteger(step) || signature.length !== SIGNATURE_LENGTH) return null;
  return { officeId, step, signature };
}

export function verifyCode(parsed: { officeId: string; step: number; signature: string }, secret: string, now = Date.now()): boolean {
  const current = stepAt(now);
  if (parsed.step > current || current - parsed.step >= ACCEPTED_STEPS) return false;
  const expected = Buffer.from(sign(secret, parsed.officeId, parsed.step));
  const given = Buffer.from(parsed.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// The working day and wall-clock time of an instant in the organization's zone.
export function localDayAndTime(at: Date, timeZone: string): { day: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
