import type { NextFunction, Request, Response } from "express";
import { redis } from "../redis/client";
import { AppError } from "../lib/errors";

// Fixed-window rate limiter backed by Redis. Keyed by client IP + a prefix so
// different routes get independent budgets. Fails open if Redis is unavailable.
export function rateLimit(opts: { windowSec: number; max: number; keyPrefix: string }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `rl:${opts.keyPrefix}:${ip}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, opts.windowSec);
      if (count > opts.max) {
        const ttl = await redis.ttl(key);
        res.setHeader("Retry-After", String(Math.max(ttl, 1)));
        return next(new AppError(429, "Too many requests — please slow down", "rate_limited"));
      }
      return next();
    } catch {
      // Redis down → don't block legitimate traffic.
      return next();
    }
  };
}
