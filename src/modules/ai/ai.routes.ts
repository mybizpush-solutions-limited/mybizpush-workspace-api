import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { discardAction } from "./ai.actions";
import { aiService } from "./ai.service";

export const aiRouter = Router();
aiRouter.use(requireAuth);

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(40),
  // Where the person is in the UI. Lets "summarize this" work without them
  // repeating which item they mean.
  context: z
    .object({
      itemId: z.string().uuid().optional(),
      itemType: z.enum(["task", "issue"]).optional(),
      projectId: z.string().uuid().optional(),
    })
    .optional(),
});

aiRouter.post(
  "/chat",
  validateBody(chatSchema),
  asyncHandler(async (req, res) => {
    res.json(await aiService.chat(req.auth!, req.body));
  }),
);

const actionSchema = z.object({ actionId: z.string().uuid() });

// Approve a write the assistant proposed. The arguments were stored server-side
// when it was staged, so this only names the action — the client can't alter
// what runs between the preview and the approval.
aiRouter.post(
  "/actions/confirm",
  validateBody(actionSchema),
  asyncHandler(async (req, res) => {
    res.json(await aiService.confirmAction(req.auth!, req.body.actionId));
  }),
);

aiRouter.post(
  "/actions/cancel",
  validateBody(actionSchema),
  asyncHandler(async (req, res) => {
    await discardAction(req.body.actionId, req.auth!.sub);
    res.status(204).end();
  }),
);

const summarizeSchema = z.object({
  itemId: z.string().uuid(),
  itemType: z.enum(["task", "issue"]),
});

aiRouter.post(
  "/summarize",
  validateBody(summarizeSchema),
  asyncHandler(async (req, res) => {
    res.json({ summary: await aiService.summarizeItem(req.body.itemId, req.body.itemType) });
  }),
);

// Generate a brief for an external coding agent (Claude Code, etc.) with repo
// context. Same input shape as summarize.
aiRouter.post(
  "/agent-brief",
  validateBody(summarizeSchema),
  asyncHandler(async (req, res) => {
    res.json({ brief: await aiService.agentBrief(req.body.itemId, req.body.itemType) });
  }),
);
