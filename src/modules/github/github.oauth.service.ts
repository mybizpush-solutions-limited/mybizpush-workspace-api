import { randomUUID } from "node:crypto";
import { redis } from "../../redis/client";
import { badRequest } from "../../lib/errors";
import { env } from "../../config/env";
import { GithubAccount } from "../../models";
import { assertReturnTo } from "../google/google.service";
import { exchangeOAuthCodeAndStore, getOAuthUrl } from "../../lib/github";

// States made just before this change hold a plain user id.
function parseState(raw: string): { userId: string; returnTo: string | null } {
  try {
    const v = JSON.parse(raw) as { userId: string; returnTo: string | null };
    if (v && typeof v === "object" && v.userId) return v;
  } catch {
    /* an older plain id */
  }
  return { userId: raw, returnTo: null };
}

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
  async createAuthUrl(userId: string, opts: { returnTo?: string } = {}): Promise<string> {
    assertReturnTo(opts.returnTo);
    const state = randomUUID();
    await redis.set(`${STATE_PREFIX}${state}`, JSON.stringify({ userId, returnTo: opts.returnTo ?? null }), "EX", STATE_TTL_SECONDS);
    return getOAuthUrl(state);
  },

  // Where this attempt should end up, without using the state up.
  async peekReturnTo(state: string): Promise<string | null> {
    const raw = state ? await redis.get(`${STATE_PREFIX}${state}`) : null;
    return raw ? parseState(raw).returnTo : null;
  },

  // Handle GitHub's redirect: resolve the user from state, store their token.
  async handleCallback(code: string, state: string): Promise<void> {
    if (!code || !state) throw badRequest("Missing code or state");
    const raw = await redis.get(`${STATE_PREFIX}${state}`);
    if (!raw) throw badRequest("Invalid or expired OAuth state");
    await redis.del(`${STATE_PREFIX}${state}`);
    await exchangeOAuthCodeAndStore(parseState(raw).userId, code);
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
