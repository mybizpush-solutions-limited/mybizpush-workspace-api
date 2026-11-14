import { randomUUID } from "node:crypto";
import { redis } from "../../redis/client";
import { env } from "../../config/env";
import { AppError, badRequest } from "../../lib/errors";
import { isAllowedReturn } from "../integrations/integrations.pure";
import { GoogleAccount } from "../../models";
import { exchangeCodeAndStore, getAuthUrl } from "../../lib/google";

export function assertReturnTo(returnTo: string | undefined): void {
  if (returnTo && !isAllowedReturn(returnTo, env.OAUTH_RETURN_ALLOWLIST)) throw new AppError(400, "That return address isn't allowed", "bad_return_url");
}

// States made just before this change hold a plain user id.
function parseState(raw: string): { userId: string; returnTo: string | null; gmail: boolean } {
  try {
    const v = JSON.parse(raw) as { userId: string; returnTo: string | null; gmail: boolean };
    if (v && typeof v === "object" && v.userId) return v;
  } catch {
    /* an older plain id */
  }
  return { userId: raw, returnTo: null, gmail: false };
}

const STATE_PREFIX = "gstate:";
const STATE_TTL_SECONDS = 600; // 10 minutes

export const googleService = {
  // Generate a consent URL, tying the CSRF state to the user (in Redis).
  async createAuthUrl(userId: string, opts: { returnTo?: string; gmail?: boolean } = {}): Promise<string> {
    assertReturnTo(opts.returnTo);
    const state = randomUUID();
    await redis.set(`${STATE_PREFIX}${state}`, JSON.stringify({ userId, returnTo: opts.returnTo ?? null, gmail: !!opts.gmail }), "EX", STATE_TTL_SECONDS);
    return getAuthUrl(state, { gmail: opts.gmail });
  },

  // Where this attempt should end up, without using the state up.
  async peekState(state: string): Promise<{ returnTo: string | null; gmail: boolean } | null> {
    const raw = state ? await redis.get(`${STATE_PREFIX}${state}`) : null;
    return raw ? parseState(raw) : null;
  },

  // Handle Google's redirect: resolve the user from state, store their tokens.
  async handleCallback(code: string, state: string): Promise<void> {
    if (!code || !state) throw badRequest("Missing code or state");
    const raw = await redis.get(`${STATE_PREFIX}${state}`);
    if (!raw) throw badRequest("Invalid or expired OAuth state");
    await redis.del(`${STATE_PREFIX}${state}`);
    const parsed = parseState(raw);
    await exchangeCodeAndStore(parsed.userId, code, { gmail: parsed.gmail });
  },

  async status(userId: string): Promise<{ connected: boolean; email: string | null; gmail: boolean }> {
    const account = await GoogleAccount.findByPk(userId);
    return { connected: Boolean(account?.refreshToken), email: account?.email ?? null, gmail: Boolean(account?.gmailRefreshToken) };
  },

  async disconnect(userId: string): Promise<void> {
    await GoogleAccount.destroy({ where: { userId } });
  },
};
