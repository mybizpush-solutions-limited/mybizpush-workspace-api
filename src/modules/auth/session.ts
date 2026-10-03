import { randomBytes } from "node:crypto";
import { unauthorized } from "../../lib/errors";
import { issueRefreshToken, signAccessToken } from "../../lib/jwt";
import { redis } from "../../redis/client";
import { usersRepo, type PublicUser } from "../users/users.repo";
import { User } from "../../models";

// Sign-in is a short sequence of steps, and a session (access + refresh token)
// is only issued at the end of it:
//
//   password ─► [change password] ─► [enroll MFA | enter MFA code] ─► session
//
// Between steps the client holds a challenge token: an opaque, single-purpose
// value in Redis that proves "this person got past the previous step" and
// nothing else. It is never accepted as a bearer token. MFA is compulsory, so
// there is no path to a session that skips the second factor.

export type ChallengeScope = "password_change" | "mfa_setup" | "mfa_challenge";

export type AuthStep =
  | { status: "complete"; user: PublicUser; accessToken: string; refreshToken: string; recoveryCodes?: string[] }
  | { status: "password_change_required" | "mfa_setup_required" | "mfa_required"; challengeToken: string; message: string };

interface Challenge {
  userId: string;
  scope: ChallengeScope;
  attempts: number;
}

const CHALLENGE_PREFIX = "authch:";
// Enrollment gets longer: installing an app and scanning a QR code takes a while.
const CHALLENGE_TTL: Record<ChallengeScope, number> = {
  password_change: 10 * 60,
  mfa_setup: 15 * 60,
  mfa_challenge: 5 * 60,
};
export const MAX_CHALLENGE_ATTEMPTS = 5;

export async function issueChallenge(userId: string, scope: ChallengeScope): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const value: Challenge = { userId, scope, attempts: 0 };
  await redis.set(`${CHALLENGE_PREFIX}${token}`, JSON.stringify(value), "EX", CHALLENGE_TTL[scope]);
  return token;
}

// Resolve a challenge token for one specific step. A token from a different
// step is rejected exactly like a missing one.
export async function readChallenge(token: string, scope: ChallengeScope): Promise<Challenge> {
  const raw = token ? await redis.get(`${CHALLENGE_PREFIX}${token}`) : null;
  const challenge = raw ? (JSON.parse(raw) as Challenge) : null;
  if (!challenge || challenge.scope !== scope) {
    throw unauthorized("Your sign-in session expired — please sign in again");
  }
  return challenge;
}

// Count a wrong code against the challenge; the fifth burns it, so guessing has
// to restart from the password.
export async function failChallenge(token: string, challenge: Challenge): Promise<void> {
  challenge.attempts += 1;
  const key = `${CHALLENGE_PREFIX}${token}`;
  if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) await redis.del(key);
  else await redis.set(key, JSON.stringify(challenge), "KEEPTTL");
}

export async function consumeChallenge(token: string): Promise<void> {
  await redis.del(`${CHALLENGE_PREFIX}${token}`);
}

// Whatever this account still owes before it may have a session.
export async function nextStep(user: User): Promise<AuthStep> {
  if (!user.passwordMeetsPolicy) {
    return {
      status: "password_change_required",
      challengeToken: await issueChallenge(user.id, "password_change"),
      message:
        "Your password no longer meets our security policy. Choose a new one of at least 12 characters to continue.",
    };
  }
  if (!user.totpEnabled) {
    return {
      status: "mfa_setup_required",
      challengeToken: await issueChallenge(user.id, "mfa_setup"),
      message: "Two-factor authentication is required for every Dev Space account. Set it up to continue.",
    };
  }
  return {
    status: "mfa_required",
    challengeToken: await issueChallenge(user.id, "mfa_challenge"),
    message: "Enter the 6-digit code from your authenticator app.",
  };
}

export async function completeSession(user: User): Promise<Extract<AuthStep, { status: "complete" }>> {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, accessLevel: user.accessLevel });
  const refreshToken = await issueRefreshToken(user.id);
  const publicUser = (await usersRepo.publicById(user.id))!;
  return { status: "complete", user: publicUser, accessToken, refreshToken };
}

// A refresh token may only keep a session alive for an account that has
// finished securing itself. Sessions from before compulsory MFA are cut off
// here, which is what sends every existing user back through sign-in.
export function isSessionEligible(user: User): boolean {
  return user.passwordMeetsPolicy && user.totpEnabled;
}
