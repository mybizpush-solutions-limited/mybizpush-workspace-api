import jwt, { type SignOptions } from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { redis, redisKeys } from "../redis/client";
import { unauthorized } from "./errors";

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  accessLevel: string;
}

interface RefreshTokenPayload {
  sub: string;
  jti: string; // unique token id, tracked in redis for revocation
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
  } as SignOptions);
}

// Issues a refresh token and records its jti in Redis so it can be revoked
// (logout, rotation, or "log out everywhere").
export async function issueRefreshToken(userId: string): Promise<string> {
  const jti = randomUUID();
  const token = jwt.sign({ sub: userId, jti } satisfies RefreshTokenPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
  } as SignOptions);

  const decoded = jwt.decode(token) as { exp?: number } | null;
  const ttlSeconds = decoded?.exp ? Math.max(1, decoded.exp - Math.floor(Date.now() / 1000)) : 60 * 60 * 24 * 30;
  await redis.set(redisKeys.refreshToken(userId, jti), "1", "EX", ttlSeconds);
  return token;
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  } catch {
    throw unauthorized("Invalid or expired access token");
  }
}

// Verifies signature AND that the token's jti is still allowlisted in Redis.
export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  let decoded: RefreshTokenPayload;
  try {
    decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  } catch {
    throw unauthorized("Invalid or expired refresh token");
  }
  const exists = await redis.exists(redisKeys.refreshToken(decoded.sub, decoded.jti));
  if (!exists) throw unauthorized("Refresh token has been revoked");
  return decoded;
}

export async function revokeRefreshToken(userId: string, jti: string): Promise<void> {
  await redis.del(redisKeys.refreshToken(userId, jti));
}

// How long a just-rotated refresh token keeps working. Two tabs that hit an
// expired access token at the same moment both send the SAME cookie: the first
// rotates it, and without this window the second is told its token was revoked
// and the user is bounced to /login mid-edit. The window is short enough that a
// genuinely stolen token is still useless.
const ROTATION_GRACE_SECONDS = 60;

// Revoke every refresh token for a user (e.g. after a password reset).
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  const keys = await redis.keys(`refresh:${userId}:*`);
  if (keys.length) await redis.del(...keys);
}

// Rotate: expire the presented refresh token after a short grace window and
// issue a fresh one. Expiring rather than deleting lets a concurrent request
// that raced with this rotation still succeed instead of logging the user out.
export async function rotateRefreshToken(userId: string, oldJti: string): Promise<string> {
  const oldKey = redisKeys.refreshToken(userId, oldJti);
  const ttl = await redis.ttl(oldKey);
  // Only shorten the window — never extend a token that is already expiring.
  if (ttl < 0 || ttl > ROTATION_GRACE_SECONDS) {
    await redis.expire(oldKey, ROTATION_GRACE_SECONDS);
  }
  return issueRefreshToken(userId);
}
