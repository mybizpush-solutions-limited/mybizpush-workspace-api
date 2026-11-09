import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { ATTENDANCE_STATUSES, LOCATION_TYPES, MEETING_SCOPES, MEETING_TYPES } from "../../models";
import { GROUP_TYPES } from "../groups/groups.merge";
import { buildSchemas } from "../workitems/workitems.routes";
import type { WorkItemCreateInput } from "../workitems/workitems.service";
import { calendarService } from "./calendar.service";
import { meetingsService } from "./meetings.service";

export const meetingsRouter = Router();
export const calendarRouter = Router();
meetingsRouter.use(requireAuth);
calendarRouter.use(requireAuth);

const uuid = z.string().uuid();
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

const extended = {
  type: z.enum(MEETING_TYPES).optional(),
  scopeType: z.enum(MEETING_SCOPES).nullable().optional(),
  scopeId: uuid.nullable().optional(),
  locationType: z.enum(LOCATION_TYPES).optional(),
  location: z.string().trim().max(300).nullable().optional(),
  agenda: z.array(z.object({ title: z.string().trim().min(1).max(300), durationMinutes: z.number().int().min(1).max(1440).optional(), ownerId: uuid.optional() })).max(50).optional(),
  reminderMinutes: z.array(z.number().int().min(0).max(10080)).max(5).optional(),
  groups: z.array(z.object({ type: z.enum(GROUP_TYPES), id: uuid })).max(20).optional(),
  excludeUserIds: z.array(uuid).max(500).optional(),
};

const createSchema = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  attendeeIds: z.array(uuid).optional(),
  externalEmails: z.array(z.string().trim().email()).max(50).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  recurrence: recurrenceSchema.optional(),
  meetLink: z.boolean().optional(),
  ...extended,
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  attendeeIds: z.array(uuid).optional(),
  externalEmails: z.array(z.string().trim().email()).max(50).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  recurrence: recurrenceSchema.optional(),
  ...extended,
});

export const rsvpSchema = z.object({ response: z.enum(["accepted", "tentative", "declined"]), note: z.string().trim().max(500).optional() });
export const noteSchema = z.object({ id: uuid.optional(), kind: z.enum(["note", "decision"]).optional(), body: z.string().trim().min(1).max(20000) });
export const actionItemSchema = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(8000).optional(),
  ownerId: uuid.nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
});
export const actionItemUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(8000).optional(),
  ownerId: uuid.nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  status: z.enum(["open", "done"]).optional(),
});

const isMobile = (req: Request) => req.get("x-client")?.toLowerCase() === "mobile";

meetingsRouter.get("/", asyncHandler(async (req, res) => {
  res.json({ meetings: await meetingsService.list({ includeCancelled: req.query.includeCancelled === "true" }) });
}));

// Whether the caller is allowed to schedule (exec, project manager, or HR).
meetingsRouter.get("/can-schedule", asyncHandler(async (req, res) => {
  res.json({ canSchedule: await meetingsService.canSchedule(req.auth!.sub) });
}));

meetingsRouter.post("/", validateBody(createSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ meeting: await meetingsService.create({ ...req.body, organizerId: req.auth!.sub }) });
}));

meetingsRouter.get("/:id", asyncHandler(async (req, res) => {
  res.json({ meeting: await meetingsService.get(req.params.id!, req.auth!.sub) });
}));

meetingsRouter.patch("/:id", validateBody(updateSchema), asyncHandler(async (req, res) => {
  res.json({ meeting: await meetingsService.update(req.auth!.sub, req.params.id!, req.body) });
}));

meetingsRouter.delete("/:id", asyncHandler(async (req, res) => {
  await meetingsService.cancel(req.auth!.sub, req.params.id!);
  res.status(204).end();
}));

meetingsRouter.post("/:id/cancel", validateBody(z.object({ reason: z.string().trim().max(500).optional() })), asyncHandler(async (req, res) => {
  res.json({ meeting: await meetingsService.softCancel(req.auth!.sub, req.params.id!, req.body.reason, req) });
}));

meetingsRouter.post("/:id/complete", asyncHandler(async (req, res) => {
  res.json({ meeting: await meetingsService.complete(req.auth!.sub, req.params.id!) });
}));

meetingsRouter.post("/:id/rsvp", validateBody(rsvpSchema), asyncHandler(async (req, res) => {
  res.json({ attendee: await meetingsService.rsvp(req.params.id!, req.auth!.sub, req.body.response, req.body.note) });
}));

meetingsRouter.post(
  "/:id/attendance",
  validateBody(z.object({ entries: z.array(z.object({ userId: uuid, status: z.enum(ATTENDANCE_STATUSES) })).min(1).max(500) })),
  asyncHandler(async (req, res) => {
    res.json({ attendees: await meetingsService.markAttendance(req.params.id!, req.auth!.sub, req.body.entries) });
  }),
);

meetingsRouter.get("/:id/notes", asyncHandler(async (req, res) => {
  res.json(await calendarService.notes(req.params.id!, req.auth!.sub));
}));
meetingsRouter.post("/:id/notes", validateBody(noteSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ note: await calendarService.addNote(req.params.id!, req.body, req.auth!.sub) });
}));
meetingsRouter.patch("/:id/notes/:noteId", validateBody(z.object({ body: z.string().trim().min(1).max(20000) })), asyncHandler(async (req, res) => {
  res.json({ note: await calendarService.updateNote(req.params.id!, req.params.noteId!, req.body.body, req.auth!.sub) });
}));
meetingsRouter.delete("/:id/notes/:noteId", asyncHandler(async (req, res) => {
  await calendarService.removeNote(req.params.id!, req.params.noteId!, req.auth!.sub);
  res.status(204).end();
}));

meetingsRouter.post("/:id/action-items", validateBody(actionItemSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ actionItem: await calendarService.addActionItem(req.params.id!, req.body, req.auth!.sub) });
}));
meetingsRouter.patch("/:id/action-items/:itemId", validateBody(actionItemUpdateSchema), asyncHandler(async (req, res) => {
  res.json({ actionItem: await calendarService.updateActionItem(req.params.id!, req.params.itemId!, req.body, req.auth!.sub) });
}));
meetingsRouter.delete("/:id/action-items/:itemId", asyncHandler(async (req, res) => {
  await calendarService.removeActionItem(req.params.id!, req.params.itemId!, req.auth!.sub);
  res.status(204).end();
}));
meetingsRouter.post(
  "/:id/action-items/:itemId/convert",
  // The same body as POST /tasks, with the title optional: it defaults to the item.
  validateBody(buildSchemas(false).create.partial({ title: true })),
  asyncHandler(async (req, res) => {
    const out = await calendarService.convert(req.params.id!, req.params.itemId!, req.body as WorkItemCreateInput, req.auth!.sub, isMobile(req));
    res.status(201).json(out);
  }),
);

// ---- /calendar ---------------------------------------------------------------
const eventFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(8000).optional(),
  scopeType: z.enum(MEETING_SCOPES),
  scopeId: uuid.nullable().optional(),
  allDay: z.boolean().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  location: z.string().trim().max(300).nullable().optional(),
};

calendarRouter.get("/", asyncHandler(async (req, res) => {
  const q = z
    .object({
      from: z.string().datetime(),
      to: z.string().datetime(),
      view: z.enum(["mine", "all"]).optional(),
      scopeType: z.enum(MEETING_SCOPES).optional(),
      scopeId: uuid.optional(),
      includeCancelled: z.enum(["true", "false"]).optional(),
    })
    .parse(req.query);
  res.json({ items: await calendarService.items(req.auth!.sub, { ...q, includeCancelled: q.includeCancelled === "true" }) });
}));
calendarRouter.post("/events", validateBody(z.object({ id: uuid.optional(), ...eventFields })), asyncHandler(async (req, res) => {
  res.status(201).json({ event: await calendarService.createEvent(req.body, req.auth!.sub) });
}));
calendarRouter.get("/events/:id", asyncHandler(async (req, res) => {
  res.json({ event: await calendarService.getEvent(req.params.id!) });
}));
calendarRouter.patch("/events/:id", validateBody(z.object(eventFields).partial()), asyncHandler(async (req, res) => {
  res.json({ event: await calendarService.updateEvent(req.params.id!, req.body, req.auth!.sub) });
}));
calendarRouter.delete("/events/:id", asyncHandler(async (req, res) => {
  await calendarService.removeEvent(req.params.id!, req.auth!.sub);
  res.status(204).end();
}));
