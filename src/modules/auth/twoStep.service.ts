import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Op } from "sequelize";
import { audit } from "../../lib/audit";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { AppError, notFound } from "../../lib/errors";
import { verifyPassword } from "../../lib/password";
import { currentStep, generateTotpSecret, otpauthUri, verifyTotp } from "../../lib/totp";
import { MfaRecoveryCode, User } from "../../models";
import { redis } from "../../redis/client";

// Optional two-step sign-in (API-CHANGES A902). A correct password alone gets a
// challenge, not a session. Only verify() can finish signing in.

type Req = Parameters<typeof audit>[0]["req"];
const ISSUER = "MyBizPush";
const RECOVERY_CODES = 10;
const RECOVERY_ROUNDS = 10;
const CHALLENGE_TTL_SECONDS = 5 * 60;
const CHALLENGE_ATTEMPTS = 5;

// Only a hash is kept: reading Redis doesn't give anyone a usable challenge.
const challengeKey = (token: string) => `2fa:challenge:${createHash("sha256").update(token).digest("hex")}`;
const attemptsKey = (token: string) => `${challengeKey(token)}:attempts`;

const invalidCode = () => new AppError(400, "That code isn't right", "invalid_code");
const expired = () => new AppError(401, "This sign-in has expired. Please sign in again.", "challenge_expired");

// Unambiguous letters and digits, in two groups so it can be read out.
function generateRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
}
const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, generateRecoveryCode);
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(normalizeRecovery(c), RECOVERY_ROUNDS)));
  await MfaRecoveryCode.destroy({ where: { userId } });
  await MfaRecoveryCode.bulkCreate(hashes.map((codeHash) => ({ userId, codeHash })));
  return codes;
}

// A 6-digit code, not used before, or an unused recovery code. Both are claimed
// atomically, so the same code can't get two sessions at once.
async function consumeCode(user: User, code: string): Promise<boolean> {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    if (!user.totpSecretEncrypted) return false;
    const step = verifyTotp(decryptSecret(user.totpSecretEncrypted), trimmed);
    if (step === null) return false;
    const [claimed] = await User.update({ totpLastStep: step }, { where: { id: user.id, totpLastStep: { [Op.lt]: step } } });
    return claimed === 1;
  }
  const normalized = normalizeRecovery(trimmed);
  if (!normalized) return false;
  const unused = await MfaRecoveryCode.findAll({ where: { userId: user.id, usedAt: null } });
  for (const row of unused) {
    if (await bcrypt.compare(normalized, row.codeHash)) {
      const [claimed] = await MfaRecoveryCode.update({ usedAt: new Date() }, { where: { id: row.id, usedAt: null } });
      return claimed === 1;
    }
  }
  return false;
}

async function loadUser(userId: string): Promise<User> {
  const user = await User.findByPk(userId);
  if (!user) throw notFound("User not found");
  return user;
}

export const twoStepService = {
  async status(userId: string) {
    const user = await loadUser(userId);
    const recoveryCodesLeft = user.totpEnabled ? await MfaRecoveryCode.count({ where: { userId, usedAt: null } }) : 0;
    return { enabled: user.totpEnabled, enabledAt: user.totpConfirmedAt?.toISOString() ?? null, recoveryCodesLeft };
  },

  async setup(userId: string) {
    const user = await loadUser(userId);
    if (user.totpEnabled) throw new AppError(409, "Two-step sign-in is already on", "already_enabled");
    const secret = generateTotpSecret();
    await user.update({ totpSecretEncrypted: encryptSecret(secret) });
    return { secret, otpauthUri: otpauthUri(ISSUER, user.email, secret) };
  },

  async enable(userId: string, code: string, req?: Req) {
    const user = await loadUser(userId);
    if (user.totpEnabled) throw new AppError(409, "Two-step sign-in is already on", "already_enabled");
    if (!user.totpSecretEncrypted) throw new AppError(409, "Start the setup first", "no_setup");
    const step = verifyTotp(decryptSecret(user.totpSecretEncrypted), code.trim());
    if (step === null) throw invalidCode();
    await user.update({ totpEnabled: true, totpConfirmedAt: new Date(), totpLastStep: step });
    const recoveryCodes = await replaceRecoveryCodes(userId);
    await audit({ req, actorId: userId, action: "user.two_step.enable", target: { type: "user", id: userId } });
    return { enabled: true, recoveryCodes };
  },

  async disable(userId: string, input: { code?: string; password?: string }, req?: Req) {
    const user = await loadUser(userId);
    if (!user.totpEnabled) return { enabled: false };
    if (input.password !== undefined) {
      if (!(await verifyPassword(input.password, user.passwordHash))) throw new AppError(400, "That password isn't right", "invalid_password");
    } else if (!input.code || !(await consumeCode(user, input.code))) {
      throw invalidCode();
    }
    await user.update({ totpEnabled: false, totpSecretEncrypted: null, totpConfirmedAt: null, totpLastStep: 0 });
    await MfaRecoveryCode.destroy({ where: { userId } });
    await audit({ req, actorId: userId, action: "user.two_step.disable", target: { type: "user", id: userId } });
    return { enabled: false };
  },

  // The password was right. This stands between that and a session.
  async createChallenge(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await redis.set(challengeKey(token), userId, "EX", CHALLENGE_TTL_SECONDS);
    return token;
  },

  // Returns the user once the code is right; the caller then starts the session.
  // Suspension is the caller's check, since it may have changed in these 5 minutes.
  async verifyChallenge(token: string, code: string): Promise<User> {
    const userId = await redis.get(challengeKey(token));
    if (!userId) throw expired();
    const user = await User.findByPk(userId);
    if (!user || !user.totpEnabled) throw expired();

    if (!(await consumeCode(user, code))) {
      const attempts = await redis.incr(attemptsKey(token));
      if (attempts === 1) await redis.expire(attemptsKey(token), CHALLENGE_TTL_SECONDS);
      if (attempts >= CHALLENGE_ATTEMPTS) {
        await redis.del(challengeKey(token), attemptsKey(token));
        throw expired();
      }
      throw invalidCode();
    }
    // One challenge makes one session, even if two requests arrive together.
    const removed = await redis.del(challengeKey(token));
    await redis.del(attemptsKey(token));
    if (removed !== 1) throw expired();
    return user;
  },

  currentStep,
};
