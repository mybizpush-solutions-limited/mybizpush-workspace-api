import jwt, { type SignOptions } from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { redis, redisKeys } from "../redis/client";
import { unauthorized } from "./errors";

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  accessLevel: string;
  // Session id: stable across refreshes for one sign-in on one device. Lets the
  // API tell which listed session is "this device". Absent on tokens issued
  // before sessions existed.
  sid?: string;
}

interface RefreshTokenPayload {
  sub: string;
  jti: string; // unique token id, tracked in redis for revocation
  sid?: string; // session id, carried across rotations
}

// Where a sign-in came from. Supplied by the controller from request headers.
export interface ClientInfo {
  ip?: string | null;
  userAgent?: string | null;
  device?: string | null; // e.g. "Pixel 8", from X-Device-Name
  platform?: string | null; // "ios" | "android" | "web", from X-Platform
}

// What we keep in Redis next to each live refresh token. Legacy tokens stored
// the literal "1"; readSession() maps those to an "unknown device" session.
export interface SessionRecord {
  sid: string;
  device: string | null;
  platform: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string; // ISO, when this session first signed in
  lastUsedAt: string; // ISO, last sign-in or refresh
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
  } as SignOptions);
}

function newSession(client: ClientInfo | undefined, sid: string = randomUUID()): SessionRecord {
  const now = new Date().toISOString();
  return {
    sid,
    device: client?.device ?? null,
    platform: client?.platform ?? null,
    ip: client?.ip ?? null,
    userAgent: client?.userAgent ?? null,
    createdAt: now,
    lastUsedAt: now,
  };
}

async function storeRefreshToken(userId: string, session: SessionRecord): Promise<{ token: string; sid: string }> {
  const jti = randomUUID();
  const token = jwt.sign(
    { sub: userId, jti, sid: session.sid } satisfies RefreshTokenPayload,
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_TTL } as SignOptions,
  );
  const decoded = jwt.decode(token) as { exp?: number } | null;
  const ttlSeconds = decoded?.exp ? Math.max(1, decoded.exp - Math.floor(Date.now() / 1000)) : 60 * 60 * 24 * 30;
  await redis.set(redisKeys.refreshToken(userId, jti), JSON.stringify(session), "EX", ttlSeconds);
  return { token, sid: session.sid };
}

// Issues a refresh token for a NEW session (a sign-in) and records it in Redis
// so it can be listed and revoked (logout, rotation, "sign out everywhere").
export async function issueRefreshToken(userId: string, client?: ClientInfo): Promise<{ token: string; sid: string }> {
  return storeRefreshToken(userId, newSession(client));
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

// Every live refresh-token key for a user. SCAN, not KEYS: KEYS blocks Redis
// while it walks the whole keyspace.
async function refreshKeysFor(userId: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `refresh:${userId}:*`, "COUNT", 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

function readSession(key: string, raw: string | null | undefined): SessionRecord | null {
  if (raw === null || raw === undefined) return null;
  if (raw === "1") {
    // Issued before sessions existed: one session per token, no device details.
    const jti = key.slice(key.lastIndexOf(":") + 1);
    return { sid: jti, device: null, platform: null, ip: null, userAgent: null, createdAt: "", lastUsedAt: "" };
  }
  try {
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

// Revoke every refresh token for a user (e.g. after a password reset), or every
// one except the given session ("sign out other devices").
export async function revokeAllRefreshTokens(userId: string, exceptSid?: string): Promise<void> {
  const keys = await refreshKeysFor(userId);
  if (!keys.length) return;
  if (!exceptSid) {
    await redis.del(...keys);
    return;
  }
  const values = await redis.mget(...keys);
  const doomed = keys.filter((key, i) => readSession(key, values[i])?.sid !== exceptSid);
  if (doomed.length) await redis.del(...doomed);
}

// The user's signed-in sessions, newest activity first. A session can briefly
// hold two tokens (the rotated one in its grace window), so tokens are grouped
// by session id and the most recently used record wins.
export async function listSessions(userId: string): Promise<SessionRecord[]> {
  const keys = await refreshKeysFor(userId);
  if (!keys.length) return [];
  const values = await redis.mget(...keys);
  const bySid = new Map<string, SessionRecord>();
  keys.forEach((key, i) => {
    const session = readSession(key, values[i]);
    if (!session) return;
    const seen = bySid.get(session.sid);
    if (!seen || session.lastUsedAt > seen.lastUsedAt) bySid.set(session.sid, session);
  });
  return [...bySid.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

// Sign one session out: drop every token belonging to it. Returns false when the
// user has no such session.
export async function revokeSession(userId: string, sid: string): Promise<boolean> {
  const keys = await refreshKeysFor(userId);
  if (!keys.length) return false;
  const values = await redis.mget(...keys);
  const doomed = keys.filter((key, i) => readSession(key, values[i])?.sid === sid);
  if (doomed.length) await redis.del(...doomed);
  return doomed.length > 0;
}

// Rotate: expire the presented refresh token after a short grace window and
// issue a fresh one in the SAME session, refreshing its last-used details.
// Expiring rather than deleting lets a concurrent request that raced with this
// rotation still succeed instead of logging the user out.
export async function rotateRefreshToken(
  userId: string,
  oldJti: string,
  client?: ClientInfo,
): Promise<{ token: string; sid: string }> {
  const oldKey = redisKeys.refreshToken(userId, oldJti);
  const [ttl, raw] = await Promise.all([redis.ttl(oldKey), redis.get(oldKey)]);
  // Only shorten the window — never extend a token that is already expiring.
  if (ttl < 0 || ttl > ROTATION_GRACE_SECONDS) {
    await redis.expire(oldKey, ROTATION_GRACE_SECONDS);
  }
  const previous = readSession(oldKey, raw);
  const base = previous && previous.createdAt ? previous : newSession(client, previous?.sid);
  const session: SessionRecord = {
    ...base,
    device: client?.device ?? base.device,
    platform: client?.platform ?? base.platform,
    ip: client?.ip ?? base.ip,
    userAgent: client?.userAgent ?? base.userAgent,
    lastUsedAt: new Date().toISOString(),
  };
  return storeRefreshToken(userId, session);
}
