import { randomUUID } from "node:crypto";
import { redis } from "../../redis/client";
import { badRequest } from "../../lib/errors";
import { GoogleAccount } from "../../models";
import { exchangeCodeAndStore, getAuthUrl } from "../../lib/google";

const STATE_PREFIX = "gstate:";
const STATE_TTL_SECONDS = 600; // 10 minutes

export const googleService = {
  // Generate a consent URL, tying the CSRF state to the user (in Redis).
  async createAuthUrl(userId: string): Promise<string> {
    const state = randomUUID();
    await redis.set(`${STATE_PREFIX}${state}`, userId, "EX", STATE_TTL_SECONDS);
    return getAuthUrl(state);
  },

  // Handle Google's redirect: resolve the user from state, store their tokens.
  async handleCallback(code: string, state: string): Promise<void> {
    if (!code || !state) throw badRequest("Missing code or state");
    const userId = await redis.get(`${STATE_PREFIX}${state}`);
    if (!userId) throw badRequest("Invalid or expired OAuth state");
    await redis.del(`${STATE_PREFIX}${state}`);
    await exchangeCodeAndStore(userId, code);
  },

  async status(userId: string): Promise<{ connected: boolean; email: string | null }> {
    const account = await GoogleAccount.findByPk(userId);
    return { connected: Boolean(account?.refreshToken), email: account?.email ?? null };
  },

  async disconnect(userId: string): Promise<void> {
    await GoogleAccount.destroy({ where: { userId } });
  },
};
