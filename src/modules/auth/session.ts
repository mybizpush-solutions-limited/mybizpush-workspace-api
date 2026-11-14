import { randomBytes } from "node:crypto";
import { AppError, unauthorized } from "../../lib/errors";
import { issueRefreshToken, signAccessToken, type ClientInfo } from "../../lib/jwt";
import { redis } from "../../redis/client";
import { usersRepo, type PublicUser } from "../users/users.repo";
import { LoginEvent, User, type LoginEventKind } from "../../models";

// Sign-in is a short sequence of steps, and a session (access + refresh token)
// is only issued at the end of it:
//
//   password ─► [change password] ─► [enroll MFA | enter MFA code] ─► session
//
// Between steps the client holds a challenge token: an opaque, single-purpose
// value in Redis that proves "this person got past the previous step" and
// nothing else. It is never accepted as a bearer token. MFA is compulsory, so
// there is no path to a session that skips the second factor. Web and mobile
// get the same steps; only how the refresh token travels differs (controller).

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

// Suspended staff can't sign in or refresh (A106). A distinct code lets the
// app show the "account paused" screen (AUTH-07). Checked after the password,
// so a suspension isn't revealed without it, and again at every later step.
export function assertActive(user: User): void {
  if (user.status === "suspended") throw new AppError(403, "Your account is suspended. Contact HR to restore access.", "account_suspended");
}

// Record a sign-in attempt for login history (A002). Never blocks or fails the sign-in.
export function recordLogin(kind: LoginEventKind, email: string, userId: string | null, client?: ClientInfo, sid?: string): void {
  void LoginEvent.create({
    kind,
    email,
    userId,
    sessionId: sid ?? null,
    ip: client?.ip ?? null,
    userAgent: client?.userAgent?.slice(0, 400) ?? null,
    device: client?.device?.slice(0, 120) ?? null,
    platform: client?.platform?.slice(0, 20) ?? null,
  }).catch((err) => console.error("login event not recorded", err));
}

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
    throw unauthorized("Your sign-in session expired. Please sign in again.");
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

// Returns true only for the one caller that removed it, so two requests racing
// with the same challenge can't both end in a session.
export async function consumeChallenge(token: string): Promise<boolean> {
  return (await redis.del(`${CHALLENGE_PREFIX}${token}`)) === 1;
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

// The only place a session starts. The refresh token is tied to a session id
// with the device details (A002), and the access token carries the same id.
export async function completeSession(user: User, client?: ClientInfo): Promise<Extract<AuthStep, { status: "complete" }>> {
  assertActive(user);
  const { token: refreshToken, sid } = await issueRefreshToken(user.id, client);
  const accessToken = signAccessToken({ sub: user.id, email: user.email, accessLevel: user.accessLevel, sid });
  recordLogin("login", user.email, user.id, client, sid);
  const publicUser = (await usersRepo.publicById(user.id))!;
  return { status: "complete", user: publicUser, accessToken, refreshToken };
}

// A refresh token may only keep a session alive for an account that has
// finished securing itself. Sessions from before compulsory MFA are cut off
// here, which is what sends every existing user back through sign-in.
export function isSessionEligible(user: User): boolean {
  return user.passwordMeetsPolicy && user.totpEnabled;
}
