import { Router } from "express";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { meService } from "./me.service";

// "My work" aggregations backing the dashboard and the My Queue view.
export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get("/assigned", asyncHandler(async (req, res) => {
  res.json({ items: await meService.assigned(req.auth!.sub) });
}));

meRouter.get("/awaiting-feedback", asyncHandler(async (req, res) => {
  res.json({ items: await meService.awaitingFeedback(req.auth!.sub) });
}));

meRouter.get("/due-soon", asyncHandler(async (req, res) => {
  const withinDays = Number(req.query.withinDays) || 7;
  res.json({ items: await meService.dueSoon(req.auth!.sub, withinDays) });
}));

meRouter.get("/reported", asyncHandler(async (req, res) => {
  res.json({ items: await meService.reported(req.auth!.sub) });
}));
