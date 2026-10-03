import { randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import { Op } from "sequelize";
import { badRequest, notFound, unauthorized, AppError } from "../../lib/errors";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../../lib/totp";
import { revokeAllRefreshTokens } from "../../lib/jwt";
import { redis } from "../../redis/client";
import { sequelize } from "../../db/sequelize";
import { MfaRecoveryCode, User } from "../../models";
import {
  completeSession,
  consumeChallenge,
  failChallenge,
  readChallenge,
  type AuthStep,
} from "./session";

const ISSUER = "MyBizPush Space";

const RECOVERY_CODE_COUNT = 10;
// No vowels (no accidental words) and no 0/O/1/I/L lookalikes.
const RECOVERY_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";
const RECOVERY_HASH_ROUNDS = 10;

// Per-account ceiling on wrong second factors, across challenges. Without it,
// someone holding the password could sign in again for a fresh challenge every
// five guesses and keep going.
const FAIL_PREFIX = "mfafail:";
const FAIL_WINDOW_SECONDS = 15 * 60;
const FAIL_MAX = 10;

function generateRecoveryCode(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const hashes = await Promise.all(
    codes.map((c) => bcrypt.hash(normalizeRecoveryCode(c), RECOVERY_HASH_ROUNDS)),
  );
  await sequelize.transaction(async (transaction) => {
    await MfaRecoveryCode.destroy({ where: { userId }, transaction });
    await MfaRecoveryCode.bulkCreate(
      hashes.map((codeHash) => ({ userId, codeHash })),
      { transaction },
    );
  });
  return codes;
}

async function assertNotLockedOut(userId: string): Promise<void> {
  const fails = Number((await redis.get(`${FAIL_PREFIX}${userId}`)) ?? 0);
  if (fails >= FAIL_MAX) {
    throw new AppError(
      429,
      "Too many incorrect codes. Wait 15 minutes, then sign in again.",
      "mfa_locked",
    );
  }
}

async function recordFailure(userId: string): Promise<void> {
  const key = `${FAIL_PREFIX}${userId}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, FAIL_WINDOW_SECONDS);
}

function secretOf(user: User): string {
  if (!user.totpSecretEncrypted) throw badRequest("Two-factor authentication isn't set up yet");
  return decryptSecret(user.totpSecretEncrypted);
}

// Accept a TOTP code (refusing replays) or an unused recovery code. Returns
// false rather than throwing so callers can count the failure first.
async function verifySecondFactor(user: User, input: string): Promise<boolean> {
  const trimmed = input.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const step = verifyTotp(secretOf(user), trimmed);
    if (step === null) return false;
    // Conditional update, so two requests racing with the same code can't both
    // win: only one of them moves totp_last_step forward.
    const [updated] = await User.update(
      { totpLastStep: String(step) },
      { where: { id: user.id, totpLastStep: { [Op.lt]: step } } },
    );
    return updated === 1;
  }

  const normalized = normalizeRecoveryCode(trimmed);
  if (normalized.length !== 10) return false;
  const unused = await MfaRecoveryCode.findAll({ where: { userId: user.id, usedAt: null } });
  for (const row of unused) {
    if (await bcrypt.compare(normalized, row.codeHash)) {
      const [claimed] = await MfaRecoveryCode.update(
        { usedAt: new Date() },
        { where: { id: row.id, usedAt: null } },
      );
      if (claimed !== 1) return false;
      console.info(`[mfa] recovery code used by ${user.id} (${unused.length - 1} left)`);
      return true;
    }
  }
  return false;
}

async function loadUser(userId: string): Promise<User> {
  const user = await User.findByPk(userId);
  if (!user) throw unauthorized("Your sign-in session expired — please sign in again");
  return user;
}

export const mfaService = {
  // Enrollment, step 1: mint (or re-mint) a secret and hand back what the
  // authenticator app needs. Re-calling replaces a half-finished secret, so a
  // user who lost the QR just starts again.
  async beginSetup(challengeToken: string) {
    const challenge = await readChallenge(challengeToken, "mfa_setup");
    const user = await loadUser(challenge.userId);
    if (user.totpEnabled) throw badRequest("Two-factor authentication is already on");

    const secret = generateTotpSecret();
    user.totpSecretEncrypted = encryptSecret(secret);
    await user.save();
    return {
      secret,
      otpauthUri: otpauthUri(ISSUER, user.email, secret),
      issuer: ISSUER,
      accountName: user.email,
    };
  },

  // Enrollment, step 2: a valid code proves the app holds the secret. MFA turns
  // on, recovery codes are issued (shown this once), every other session is
  // signed out — none of them passed a second factor — and this one begins.
  async confirmSetup(challengeToken: string, code: string): Promise<AuthStep> {
    const challenge = await readChallenge(challengeToken, "mfa_setup");
    const user = await loadUser(challenge.userId);
    if (user.totpEnabled) throw badRequest("Two-factor authentication is already on");

    const step = verifyTotp(secretOf(user), code.trim());
    if (step === null) {
      await failChallenge(challengeToken, challenge);
      throw badRequest("That code isn't right. Check the time on your phone and try the newest code.");
    }

    user.totpEnabled = true;
    user.totpConfirmedAt = new Date();
    user.totpLastStep = String(step);
    await user.save();
    const recoveryCodes = await replaceRecoveryCodes(user.id);
    await consumeChallenge(challengeToken);
    await revokeAllRefreshTokens(user.id);
    console.info(`[mfa] enrolled ${user.id}`);

    return { ...(await completeSession(user)), recoveryCodes };
  },

  // Sign-in second factor.
  async verifyChallenge(challengeToken: string, code: string): Promise<AuthStep> {
    const challenge = await readChallenge(challengeToken, "mfa_challenge");
    await assertNotLockedOut(challenge.userId);
    const user = await loadUser(challenge.userId);

    if (!(await verifySecondFactor(user, code))) {
      await recordFailure(user.id);
      await failChallenge(challengeToken, challenge);
      throw badRequest("That code isn't right");
    }
    await consumeChallenge(challengeToken);
    await redis.del(`${FAIL_PREFIX}${user.id}`);
    return completeSession(user);
  },

  async status(userId: string) {
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");
    const remainingRecoveryCodes = await MfaRecoveryCode.count({ where: { userId, usedAt: null } });
    return {
      enabled: user.totpEnabled,
      confirmedAt: user.totpConfirmedAt,
      remainingRecoveryCodes,
    };
  },

  // Signed-in: issue a fresh set of recovery codes. Needs a current code, so a
  // borrowed unlocked laptop can't quietly mint a set for later.
  async regenerateRecoveryCodes(userId: string, code: string): Promise<string[]> {
    await assertNotLockedOut(userId);
    const user = await User.findByPk(userId);
    if (!user || !user.totpEnabled) throw badRequest("Two-factor authentication isn't on");
    if (!(await verifySecondFactor(user, code))) {
      await recordFailure(userId);
      throw badRequest("That code isn't right");
    }
    return replaceRecoveryCodes(userId);
  },

  // Executive-admin recovery for a lost phone with no recovery codes left. The
  // member is signed out everywhere and must enroll again at next sign-in.
  async resetForUser(actingUserId: string, targetId: string): Promise<void> {
    const user = await User.findByPk(targetId);
    if (!user) throw notFound("User not found");
    user.totpEnabled = false;
    user.totpSecretEncrypted = null;
    user.totpConfirmedAt = null;
    user.totpLastStep = "0";
    await user.save();
    await MfaRecoveryCode.destroy({ where: { userId: targetId } });
    await revokeAllRefreshTokens(targetId);
    await redis.del(`${FAIL_PREFIX}${targetId}`);
    console.info(`[mfa] ${actingUserId} reset two-factor for ${targetId}`);
  },
};
