import { randomInt, randomUUID } from "node:crypto";
import { env } from "../../config/env";
import { badRequest, conflict, unauthorized } from "../../lib/errors";
import { hashPassword, verifyPassword } from "../../lib/password";
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeAllRefreshTokens,
  revokeRefreshToken,
  signAccessToken,
  verifyRefreshToken,
} from "../../lib/jwt";
import { emails } from "../../lib/email";
import { redis } from "../../redis/client";
import { usersRepo, toPublicUser, type PublicUser } from "../users/users.repo";
import { User } from "../../models";
import type { LoginInput, RegisterInput } from "./auth.schemas";

const RESET_PREFIX = "pwreset:";
const RESET_TTL_SECONDS = 30 * 60;

const PWCHANGE_PREFIX = "pwchange:";
const PWCHANGE_TTL_SECONDS = 10 * 60;

const REG_PREFIX = "reg:";
const REG_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;

interface PendingRegistration {
  name: string;
  passwordHash: string;
  otp: string;
  attempts: number;
}

function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

// Enforce the company email policy: only @<ALLOWED_EMAIL_DOMAIN> addresses.
function assertAllowedDomain(email: string): void {
  const domain = `@${env.ALLOWED_EMAIL_DOMAIN}`.toLowerCase();
  if (!email.toLowerCase().endsWith(domain)) {
    throw badRequest(`Only ${domain} email addresses may use MyBizPush Dev Space`);
  }
}

async function buildTokens(user: User): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, accessLevel: user.accessLevel });
  const refreshToken = await issueRefreshToken(user.id);
  return { accessToken, refreshToken };
}

export const authService = {
  // Step 1: validate, stash a pending registration in Redis, and email a 6-digit OTP.
  async startRegistration(input: RegisterInput): Promise<void> {
    assertAllowedDomain(input.email);
    const existing = await usersRepo.rawByEmail(input.email);
    if (existing) throw conflict("An account with this email already exists");

    const passwordHash = await hashPassword(input.password);
    const pending: PendingRegistration = { name: input.name, passwordHash, otp: generateOtp(), attempts: 0 };
    await redis.set(`${REG_PREFIX}${input.email}`, JSON.stringify(pending), "EX", REG_TTL_SECONDS);
    await emails.verifyOtp(input.email, pending.otp).catch(() => undefined);
  },

  // Resend a fresh code for an in-progress signup (preserves the pending data).
  async resendOtp(email: string): Promise<void> {
    const raw = await redis.get(`${REG_PREFIX}${email}`);
    if (!raw) throw badRequest("Your sign-up session expired — please start again");
    const pending = JSON.parse(raw) as PendingRegistration;
    pending.otp = generateOtp();
    pending.attempts = 0;
    await redis.set(`${REG_PREFIX}${email}`, JSON.stringify(pending), "EX", REG_TTL_SECONDS);
    await emails.verifyOtp(email, pending.otp).catch(() => undefined);
  },

  // Step 2: verify the OTP and create the account.
  async verifyRegistration(
    email: string,
    otp: string,
  ): Promise<{ user: PublicUser; accessToken: string; refreshToken: string }> {
    const key = `${REG_PREFIX}${email}`;
    const raw = await redis.get(key);
    if (!raw) throw badRequest("Your code has expired — please start sign up again");
    const pending = JSON.parse(raw) as PendingRegistration;

    if (pending.otp !== otp) {
      pending.attempts += 1;
      if (pending.attempts >= OTP_MAX_ATTEMPTS) {
        await redis.del(key);
        throw badRequest("Too many incorrect codes — please start sign up again");
      }
      await redis.set(key, JSON.stringify(pending), "KEEPTTL");
      throw badRequest("That code isn't right");
    }

    // Guard against a race where the account was created in the meantime.
    const existing = await usersRepo.rawByEmail(email);
    if (existing) {
      await redis.del(key);
      throw conflict("An account with this email already exists");
    }

    const user = await usersRepo.create({ name: pending.name, email, passwordHash: pending.passwordHash });
    await redis.del(key);
    void emails.welcome(user.email, user.name).catch(() => undefined);

    const tokens = await buildTokens(user);
    const publicUser = (await usersRepo.publicById(user.id))!;
    return { user: publicUser, ...tokens };
  },

  async login(input: LoginInput): Promise<{ user: PublicUser; accessToken: string; refreshToken: string }> {
    assertAllowedDomain(input.email);
    const user = await usersRepo.rawByEmail(input.email);
    if (!user) throw unauthorized("Invalid email or password");

    const ok = await verifyPassword(input.password, user.passwordHash);
    if (!ok) throw unauthorized("Invalid email or password");

    const tokens = await buildTokens(user);
    const publicUser = (await usersRepo.publicById(user.id))!;
    return { user: publicUser, ...tokens };
  },

  // Rotate the refresh token and mint a new access token.
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const decoded = await verifyRefreshToken(refreshToken);
    const user = await User.findByPk(decoded.sub);
    if (!user) throw unauthorized("User no longer exists");

    const newRefresh = await rotateRefreshToken(decoded.sub, decoded.jti);
    const accessToken = signAccessToken({ sub: user.id, email: user.email, accessLevel: user.accessLevel });
    return { accessToken, refreshToken: newRefresh };
  },

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    try {
      const decoded = await verifyRefreshToken(refreshToken);
      await revokeRefreshToken(decoded.sub, decoded.jti);
    } catch {
      // Already invalid/expired — nothing to revoke.
    }
  },

  async me(userId: string): Promise<PublicUser> {
    const user = await usersRepo.publicById(userId);
    if (!user) throw unauthorized("User no longer exists");
    return user;
  },

  // Issue a reset token + email. Always resolves (never reveals whether the
  // email exists) to avoid account enumeration.
  async requestPasswordReset(email: string): Promise<void> {
    const user = await usersRepo.rawByEmail(email);
    if (!user) return;
    const token = randomUUID();
    await redis.set(`${RESET_PREFIX}${token}`, user.id, "EX", RESET_TTL_SECONDS);
    const link = `${env.APP_URL}/reset-password?token=${token}`;
    await emails.passwordReset(user.email, link).catch(() => undefined);
  },

  // Logged-in user changes their own password: email a 6-digit code, then verify
  // it + set the new password.
  async requestPasswordChangeOtp(userId: string): Promise<void> {
    const user = await User.findByPk(userId);
    if (!user) return;
    const otp = generateOtp();
    await redis.set(`${PWCHANGE_PREFIX}${userId}`, otp, "EX", PWCHANGE_TTL_SECONDS);
    await emails.passwordChangeOtp(user.email, otp).catch(() => undefined);
  },

  async changePasswordWithOtp(userId: string, otp: string, password: string): Promise<void> {
    const stored = await redis.get(`${PWCHANGE_PREFIX}${userId}`);
    if (!stored || stored !== otp.trim()) throw badRequest("That code is invalid or has expired");
    const user = await User.findByPk(userId);
    if (!user) throw badRequest("User not found");
    user.passwordHash = await hashPassword(password);
    await user.save();
    await redis.del(`${PWCHANGE_PREFIX}${userId}`);
  },

  async resetPassword(token: string, password: string): Promise<void> {
    const userId = await redis.get(`${RESET_PREFIX}${token}`);
    if (!userId) throw badRequest("This reset link is invalid or has expired");
    const user = await User.findByPk(userId);
    if (!user) throw badRequest("This reset link is invalid or has expired");

    user.passwordHash = await hashPassword(password);
    await user.save();
    await redis.del(`${RESET_PREFIX}${token}`);
    await revokeAllRefreshTokens(user.id); // log out everywhere
  },
};

export { toPublicUser };
