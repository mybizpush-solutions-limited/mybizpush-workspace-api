import { Router } from "express";
import { asyncHandler } from "../../lib/errors";
import { sequelize } from "../../db/sequelize";
import { redis } from "../../redis/client";

export const healthRouter = Router();

healthRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const checks = { db: false, redis: false };
    try {
      await sequelize.authenticate();
      checks.db = true;
    } catch {
      /* reported below */
    }
    try {
      checks.redis = (await redis.ping()) === "PONG";
    } catch {
      /* reported below */
    }
    const ok = checks.db && checks.redis;
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", checks });
  }),
);
