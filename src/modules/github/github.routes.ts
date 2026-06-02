import { Router } from "express";
import { asyncHandler } from "../../lib/errors";
import { verifyWebhookSignature } from "../../lib/github";
import { githubService } from "./github.service";

// Inbound GitHub webhooks. No auth — verified instead by the HMAC signature.
export const githubRouter = Router();

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
