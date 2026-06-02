import { randomUUID } from "node:crypto";
import { redis } from "../../redis/client";
import { badRequest } from "../../lib/errors";
import { env } from "../../config/env";
import { GithubAccount } from "../../models";
import { exchangeOAuthCodeAndStore, getOAuthUrl } from "../../lib/github";

const STATE_PREFIX = "ghstate:";
const STATE_TTL_SECONDS = 600; // 10 minutes

export interface GithubStatus {
  connected: boolean;
  login: string | null;
  avatarUrl: string | null;
  orgMember: boolean;
  org: string | null;
}

export const githubOauthService = {
  // Generate a consent URL, tying the CSRF state to the user (in Redis).
  async createAuthUrl(userId: string): Promise<string> {
    const state = randomUUID();
    await redis.set(`${STATE_PREFIX}${state}`, userId, "EX", STATE_TTL_SECONDS);
    return getOAuthUrl(state);
  },

  // Handle GitHub's redirect: resolve the user from state, store their token.
  async handleCallback(code: string, state: string): Promise<void> {
    if (!code || !state) throw badRequest("Missing code or state");
    const userId = await redis.get(`${STATE_PREFIX}${state}`);
    if (!userId) throw badRequest("Invalid or expired OAuth state");
    await redis.del(`${STATE_PREFIX}${state}`);
    await exchangeOAuthCodeAndStore(userId, code);
  },

  async status(userId: string): Promise<GithubStatus> {
    const account = await GithubAccount.findByPk(userId);
    return {
      connected: Boolean(account?.accessToken),
      login: account?.login ?? null,
      avatarUrl: account?.avatarUrl ?? null,
      orgMember: account?.orgMember ?? false,
      org: env.GITHUB_ORG || null,
    };
  },

  async disconnect(userId: string): Promise<void> {
    await GithubAccount.destroy({ where: { userId } });
  },
};
