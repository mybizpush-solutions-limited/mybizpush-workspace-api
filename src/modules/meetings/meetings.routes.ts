import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { meetingsService } from "./meetings.service";

export const meetingsRouter = Router();
meetingsRouter.use(requireAuth);

const recurrenceSchema = z
  .object({
    freq: z.enum(["daily", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(99),
    count: z.number().int().min(1).max(999).nullish(),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullish(),
  })
  .nullable();

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  attendeeIds: z.array(z.string().uuid()).optional(),
  externalEmails: z.array(z.string().trim().email()).max(50).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  recurrence: recurrenceSchema.optional(),
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  attendeeIds: z.array(z.string().uuid()).optional(),
  externalEmails: z.array(z.string().trim().email()).max(50).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  recurrence: recurrenceSchema.optional(),
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

meetingsRouter.patch("/:id", validateBody(updateSchema), asyncHandler(async (req, res) => {
  res.json({ meeting: await meetingsService.update(req.auth!.sub, req.params.id!, req.body) });
}));

meetingsRouter.delete("/:id", asyncHandler(async (req, res) => {
  await meetingsService.cancel(req.auth!.sub, req.params.id!);
  res.status(204).end();
}));
