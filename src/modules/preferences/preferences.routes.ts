import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { preferencesService } from "./preferences.service";

export const preferencesRouter = Router();
preferencesRouter.use(requireAuth);

const patchSchema = z.object({
  channels: z
    .object({
      meetingReminders: z.boolean().optional(),
      pendingTasks: z.boolean().optional(),
      feedbackRequests: z.boolean().optional(),
      mentions: z.boolean().optional(),
      events: z.boolean().optional(),
    })
    .optional(),
  digestFrequency: z.enum(["off", "daily", "weekly"]).optional(),
});

preferencesRouter.get("/", asyncHandler(async (req, res) => {
  res.json({ preferences: await preferencesService.forUser(req.auth!.sub) });
}));

preferencesRouter.patch("/", validateBody(patchSchema), asyncHandler(async (req, res) => {
  res.json({ preferences: await preferencesService.update(req.auth!.sub, req.body) });
}));
