import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { meetingsService } from "./meetings.service";

export const meetingsRouter = Router();
meetingsRouter.use(requireAuth);

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  attendeeIds: z.array(z.string().uuid()).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

meetingsRouter.get("/", asyncHandler(async (_req, res) => {
  res.json({ meetings: await meetingsService.list() });
}));

// Whether the caller is allowed to schedule (exec, project manager, or HR).
meetingsRouter.get("/can-schedule", asyncHandler(async (req, res) => {
  res.json({ canSchedule: await meetingsService.canSchedule(req.auth!.sub) });
}));

meetingsRouter.post("/", validateBody(createSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ meeting: await meetingsService.create({ ...req.body, organizerId: req.auth!.sub }) });
}));
