import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { projectsService } from "./projects.service";

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

const createSchema = z.object({
  departmentId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).optional(),
  managerId: z.string().uuid().optional(),
  memberIds: z.array(z.string().uuid()).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(4000).optional(),
  managerId: z.string().uuid().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  memberIds: z.array(z.string().uuid()).optional(),
});

projectsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const departmentId = typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;
    res.json({ projects: await projectsService.list(departmentId) });
  }),
);

projectsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ project: await projectsService.byId(req.params.id!) });
  }),
);

projectsRouter.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ project: await projectsService.create(req.body) });
  }),
);

projectsRouter.patch(
  "/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    res.json({ project: await projectsService.update(req.params.id!, req.body) });
  }),
);
