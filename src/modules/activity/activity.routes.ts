import { Router } from "express";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { activityService } from "./activity.service";

export const activityRouter = Router();
activityRouter.use(requireAuth);

// GET /activity?itemId=…  or  ?departmentId=…  (latter is admin-facing audit log)
activityRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const itemId = typeof req.query.itemId === "string" ? req.query.itemId : undefined;
    const departmentId = typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;
    if (itemId) return res.json({ activity: await activityService.forItem(itemId) });
    if (departmentId) return res.json({ activity: await activityService.forDepartment(departmentId) });
    res.json({ activity: await activityService.recent() });
  }),
);

activityRouter.get(
  "/recent",
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit) || 20;
    res.json({ activity: await activityService.recent(limit) });
  }),
);
