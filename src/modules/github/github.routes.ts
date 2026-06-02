import { Router } from "express";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { env } from "../../config/env";
import { verifyWebhookSignature } from "../../lib/github";
import { githubService } from "./github.service";
import { githubOauthService } from "./github.oauth.service";

export const githubRouter = Router();

// ---- Per-user OAuth (connect / status / disconnect) -----------------------
// Start the connect flow — returns the GitHub consent URL for the current user.
githubRouter.get(
  "/auth-url",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ url: await githubOauthService.createAuthUrl(req.auth!.sub) });
  }),
);

githubRouter.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await githubOauthService.status(req.auth!.sub));
  }),
);

githubRouter.post(
  "/disconnect",
  requireAuth,
  asyncHandler(async (req, res) => {
    await githubOauthService.disconnect(req.auth!.sub);
    res.status(204).end();
  }),
);

// OAuth redirect target — hit by GitHub in the browser (no JWT); uses `state`.
githubRouter.get(
  "/callback",
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    try {
      await githubOauthService.handleCallback(code, state);
      res.redirect(`${env.APP_URL}/profile?github=connected`);
    } catch {
      res.redirect(`${env.APP_URL}/profile?github=error`);
    }
  }),
);

// ---- Inbound webhooks. No auth — verified by the HMAC signature instead. ----
githubRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.header("X-Hub-Signature-256");
    if (!raw || !verifyWebhookSignature(raw, signature)) {
      return res.status(401).json({ error: { code: "invalid_signature", message: "Invalid webhook signature" } });
    }

    const event = req.header("X-GitHub-Event");
    if (event === "ping") return res.json({ ok: true });
    if (event === "pull_request") {
      const updated = await githubService.handlePullRequestEvent(req.body);
      return res.json({ ok: true, updated });
    }
    return res.json({ ok: true, ignored: event });
  }),
);
