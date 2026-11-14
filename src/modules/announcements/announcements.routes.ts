import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { AUDIENCE_TYPES } from "../../models";
import { announcementsService } from "./announcements.service";

export const announcementsRouter = Router();
announcementsRouter.use(requireAuth);

const audience = z.object({ type: z.enum(AUDIENCE_TYPES), ids: z.array(z.string().uuid()).max(500).optional() });
const fields = {
  requireAck: z.boolean().optional(),
  pinned: z.boolean().optional(),
  publishAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
};
const createSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
  audience,
  publishNow: z.boolean().optional(),
  ...fields,
});
const updateSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(20000).optional(), audience: audience.optional(), ...fields });

announcementsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z.object({ state: z.enum(["active", "mine", "drafts", "scheduled", "expired", "archived"]).optional(), unacknowledged: z.enum(["true", "false"]).optional() }).parse(req.query);
    res.json({ announcements: await announcementsService.list(req.auth!.sub, { state: q.state, unacknowledged: q.unacknowledged === "true" }) });
  }),
);
announcementsRouter.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ announcement: await announcementsService.create(req.body, req.auth!.sub, req) });
  }),
);
announcementsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await announcementsService.get(req.params.id!, req.auth!.sub));
  }),
);
announcementsRouter.patch(
  "/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    res.json({ announcement: await announcementsService.update(req.params.id!, req.body, req.auth!.sub) });
  }),
);
announcementsRouter.post(
  "/:id/publish",
  asyncHandler(async (req, res) => {
    res.json({ announcement: await announcementsService.publish(req.params.id!, req.auth!.sub, req) });
  }),
);
announcementsRouter.post(
  "/:id/archive",
  asyncHandler(async (req, res) => {
    res.json({ announcement: await announcementsService.archive(req.params.id!, req.auth!.sub, req) });
  }),
);
announcementsRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    res.json({ receipt: await announcementsService.markRead(req.params.id!, req.auth!.sub) });
  }),
);
announcementsRouter.post(
  "/:id/acknowledge",
  asyncHandler(async (req, res) => {
    res.json({ receipt: await announcementsService.acknowledge(req.params.id!, req.auth!.sub) });
  }),
);
announcementsRouter.get(
  "/:id/acknowledgements",
  asyncHandler(async (req, res) => {
    res.json(await announcementsService.acknowledgements(req.params.id!, req.auth!.sub));
  }),
);
announcementsRouter.post(
  "/:id/remind",
  asyncHandler(async (req, res) => {
    res.json({ reminded: await announcementsService.remind(req.params.id!, req.auth!.sub) });
  }),
);
