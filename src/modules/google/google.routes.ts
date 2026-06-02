import { Router } from "express";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { env } from "../../config/env";
import { googleService } from "./google.service";

export const googleRouter = Router();

// Start the connect flow — returns the Google consent URL for the current user.
googleRouter.get(
  "/auth-url",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ url: await googleService.createAuthUrl(req.auth!.sub) });
  }),
);

googleRouter.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await googleService.status(req.auth!.sub));
  }),
);

googleRouter.post(
  "/disconnect",
  requireAuth,
  asyncHandler(async (req, res) => {
    await googleService.disconnect(req.auth!.sub);
    res.status(204).end();
  }),
);

// OAuth redirect target — hit by Google in the browser (no JWT); uses `state`.
googleRouter.get(
  "/callback",
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    try {
      await googleService.handleCallback(code, state);
      res.redirect(`${env.APP_URL}/profile?google=connected`);
    } catch {
      res.redirect(`${env.APP_URL}/profile?google=error`);
    }
  }),
);
