import Redis from "ioredis";
import { env } from "../config/env";

// Shared Redis connection. Used for the refresh-token allowlist and (later)
// rate limiting, caching, and digest scheduling.
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

redis.on("error", (err) => {
  console.error("Redis error", err);
});

// Key helpers keep the namespace consistent.
export const redisKeys = {
  refreshToken: (userId: string, tokenId: string) => `refresh:${userId}:${tokenId}`,
  refreshUserSet: (userId: string) => `refresh:${userId}`,
};
