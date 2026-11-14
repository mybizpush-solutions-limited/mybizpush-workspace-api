import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { GROUP_TYPES } from "./groups.merge";
import { groupsService } from "./groups.service";

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

export const groupRefSchema = z.object({ type: z.enum(GROUP_TYPES), id: z.string().uuid() });

groupsRouter.post(
  "/expand",
  validateBody(z.object({ groups: z.array(groupRefSchema).min(1).max(20), excludeUserIds: z.array(z.string().uuid()).max(500).optional() })),
  asyncHandler(async (req, res) => {
    res.json(await groupsService.expand(req.body.groups, req.body.excludeUserIds ?? []));
  }),
);
