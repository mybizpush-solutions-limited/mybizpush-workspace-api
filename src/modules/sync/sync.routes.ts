import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { DELTA_COLLECTIONS, REFERENCE_COLLECTIONS, mutationSchema, pull, push } from "./sync.service";

// Offline sync endpoints for the mobile app (API-CHANGES A006).
export const syncRouter = Router();
syncRouter.use(requireAuth);

const KNOWN = new Set<string>([...DELTA_COLLECTIONS, ...REFERENCE_COLLECTIONS]);

// GET /sync/pull?cursor=<opaque>&collections=tasks,notifications
// Repeat with the returned cursor while hasMore is true.
syncRouter.get(
  "/pull",
  asyncHandler(async (req, res) => {
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const collections =
      typeof req.query.collections === "string"
        ? req.query.collections.split(",").map((c) => c.trim()).filter((c) => KNOWN.has(c))
        : undefined;
    res.json(await pull(req.auth!.sub, cursor, collections));
  }),
);

const pushSchema = z.object({ mutations: z.array(mutationSchema).min(1).max(200) });

// POST /sync/push { mutations: [...] } -> { results: [...] } in the same order.
syncRouter.post(
  "/push",
  validateBody(pushSchema),
  asyncHandler(async (req, res) => {
    const { mutations } = req.body as z.infer<typeof pushSchema>;
    res.json({ results: await push(req.auth!.sub, mutations) });
  }),
);
