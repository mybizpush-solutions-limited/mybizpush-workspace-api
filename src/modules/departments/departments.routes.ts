import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth, requireAccessLevel } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { departmentsService, type Viewer } from "./departments.service";
import type { AccessLevel } from "../../models";

export const departmentsRouter = Router();

const viewerOf = (req: { auth?: { sub: string; accessLevel: string } }): Viewer => ({
  id: req.auth!.sub,
  accessLevel: req.auth!.accessLevel as AccessLevel,
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  headId: z.string().uuid().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  headId: z.string().uuid().optional(),
});

// All department routes require authentication.
departmentsRouter.use(requireAuth);

departmentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ departments: await departmentsService.list(viewerOf(req)) });
  }),
);

departmentsRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    res.json({ department: await departmentsService.bySlug(req.params.slug!, viewerOf(req)) });
  }),
);

// Only executive admins may create or modify departments.
departmentsRouter.post(
  "/",
  requireAccessLevel("executive_admin"),
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ department: await departmentsService.create(req.body) });
  }),
);

departmentsRouter.patch(
  "/:id",
  requireAccessLevel("executive_admin"),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    res.json({ department: await departmentsService.update(req.params.id!, req.body) });
  }),
);
