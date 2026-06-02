import { Router } from "express";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { notificationsService } from "./notifications.service";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get("/", asyncHandler(async (req, res) => {
  res.json({ notifications: await notificationsService.forUser(req.auth!.sub) });
}));

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
