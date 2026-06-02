import { Router } from "express";
import { z } from "zod";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { commentsService } from "./comments.service";

export const commentsRouter = Router();
commentsRouter.use(requireAuth);

const addSchema = z.object({
  itemId: z.string().uuid(),
  itemType: z.enum(["task", "issue"]),
  body: z.string().trim().min(1).max(8000),
  mentions: z.array(z.string().uuid()).optional(),
});

commentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const itemId = typeof req.query.itemId === "string" ? req.query.itemId : undefined;
    if (!itemId) throw badRequest("itemId query param is required");
    res.json({ comments: await commentsService.forItem(itemId) });
  }),
);

commentsRouter.post(
  "/",
  validateBody(addSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ comment: await commentsService.add({ ...req.body, authorId: req.auth!.sub }) });
  }),
);
