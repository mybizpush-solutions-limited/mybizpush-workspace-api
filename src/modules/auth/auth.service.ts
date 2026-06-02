import { randomUUID } from "node:crypto";
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
  async register(input: RegisterInput): Promise<{ user: PublicUser; accessToken: string; refreshToken: string }> {
    assertAllowedDomain(input.email);
    const existing = await usersRepo.rawByEmail(input.email);
    if (existing) throw conflict("An account with this email already exists");

    const passwordHash = await hashPassword(input.password);
    const user = await usersRepo.create({ name: input.name, email: input.email, passwordHash });

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
