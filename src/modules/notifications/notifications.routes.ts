import { Router } from "express";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { z } from "zod";
import { validateBody } from "../../middleware/validate";
import { CATEGORIES } from "./notification.kinds";
import { notificationPreferences } from "./notification.preferences";
import { notificationsService } from "./notifications.service";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get("/", asyncHandler(async (req, res) => {
  res.json({ notifications: await notificationsService.forUser(req.auth!.sub) });
}));

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const channelsPatch = {
  inApp: z.boolean().optional(),
  push: z.boolean().optional(),
  email: z.boolean().optional(),
};
notificationsRouter.get("/preferences", asyncHandler(async (req, res) => {
  res.json(await notificationPreferences.get(req.auth!.sub));
}));
notificationsRouter.patch(
  "/preferences",
  validateBody(
    z.object({
      categories: z.array(z.object({ key: z.enum(CATEGORIES), ...channelsPatch })).max(CATEGORIES.length).optional(),
      quietHours: z.object({ enabled: z.boolean().optional(), start: hhmm.optional(), end: hhmm.optional(), timezone: z.string().min(1).max(60).optional() }).optional(),
      digestFrequency: z.enum(["off", "daily", "weekly"]).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json(await notificationPreferences.update(req.auth!.sub, req.body));
  }),
);

notificationsRouter.get("/unread-count", asyncHandler(async (req, res) => {
  res.json({ count: await notificationsService.unreadCount(req.auth!.sub) });
}));

notificationsRouter.post("/:id/read", asyncHandler(async (req, res) => {
  res.json({ notification: await notificationsService.markRead(req.params.id!, req.auth!.sub) });
}));

notificationsRouter.post("/read-all", asyncHandler(async (req, res) => {
  await notificationsService.markAllRead(req.auth!.sub);
  res.status(204).end();
}));
