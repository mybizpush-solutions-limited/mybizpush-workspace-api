import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
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
});

aiRouter.post(
  "/chat",
  validateBody(chatSchema),
  asyncHandler(async (req, res) => {
    res.json({ reply: await aiService.chat(req.body.messages) });
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
