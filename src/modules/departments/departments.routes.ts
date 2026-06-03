import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAuth, requireAccessLevel } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { departmentsService, type Viewer } from "./departments.service";
import type { AccessLevel } from "../../models";

export const departmentsRouter = Router();

const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

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
    res.json({ departments: await departmentsService.list() });
  }),
);

// Name-only directory of all departments (for joining / requesting to join).
// Registered before /:slug so it isn't captured as a slug.
departmentsRouter.get(
  "/directory",
  asyncHandler(async (_req, res) => {
    res.json({ departments: await departmentsService.directory() });
  }),
);

departmentsRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    res.json({ department: await departmentsService.bySlug(req.params.slug!) });
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

departmentsRouter.delete(
  "/:id",
  requireAccessLevel("executive_admin"),
  asyncHandler(async (req, res) => {
    await departmentsService.delete(req.params.id!);
    res.status(204).end();
  }),
);

// ---- Join-request management (department head or executive admin) ----------
departmentsRouter.get(
  "/:id/requests",
  asyncHandler(async (req, res) => {
    res.json({ requests: await departmentsService.listRequests(req.params.id!, viewerOf(req)) });
  }),
);

departmentsRouter.post(
  "/:id/requests/:reqId/approve",
  asyncHandler(async (req, res) => {
    res.json(await departmentsService.decideRequest(req.params.reqId!, true, viewerOf(req)));
  }),
);

departmentsRouter.post(
  "/:id/requests/:reqId/reject",
  asyncHandler(async (req, res) => {
    res.json(await departmentsService.decideRequest(req.params.reqId!, false, viewerOf(req)));
  }),
);

departmentsRouter.post(
  "/:id/members",
  validateBody(z.object({ userId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    res.json({ department: await departmentsService.addMember(req.params.id!, req.body.userId, viewerOf(req)) });
  }),
);

// Department profile image (head / exec admin — enforced in the service).
departmentsRouter.post(
  "/:id/avatar",
  avatarUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("An image is required (multipart field 'file')");
    res.json({
      department: await departmentsService.setAvatar(
        req.params.id!,
        {
          buffer: req.file.buffer,
          originalname: req.file.originalname,
          size: req.file.size,
          mimetype: req.file.mimetype,
        },
        viewerOf(req),
      ),
    });
  }),
);
