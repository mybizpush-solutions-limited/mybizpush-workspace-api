import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth, requireAccessLevel } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { User } from "../../models";
import { buildDigest, prefsFor, runDigests, sendDigestToUser } from "./digests.service";

export const digestsRouter = Router();
digestsRouter.use(requireAuth);

// Preview the current user's digest HTML without sending anything.
digestsRouter.get(
  "/preview",
  asyncHandler(async (req, res) => {
    const userId = req.auth!.sub;
    const prefs = await prefsFor(userId);
    const digest = await buildDigest(userId, prefs, 7);
    res.json({ subject: digest.subject, html: digest.html, hasContent: digest.hasContent });
  }),
);

// Send the current user a test digest right now.
digestsRouter.post(
  "/send-me",
  asyncHandler(async (req, res) => {
    const me = await User.findByPk(req.auth!.sub);
    const sent = me ? await sendDigestToUser({ id: me.id, email: me.email }, 7) : false;
    res.json({ sent });
  }),
);

// Admin: run the batch for a cadence (the scheduler does this automatically).
const runSchema = z.object({ frequency: z.enum(["daily", "weekly"]).default("daily") });
digestsRouter.post(
  "/run",
  requireAccessLevel("admin"),
  validateBody(runSchema),
  asyncHandler(async (req, res) => {
    res.json(await runDigests(req.body.frequency));
  }),
);
