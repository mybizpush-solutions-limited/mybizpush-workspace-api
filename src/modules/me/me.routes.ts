import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { ROLES } from "../../models";
import { meService } from "./me.service";
import { profileService } from "./profile.service";

// "My work" aggregations backing the dashboard and the My Queue view, plus the
// caller's own self-service profile / membership / onboarding actions.
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

// ---- Self-service profile + onboarding ------------------------------------
const profileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  roles: z.array(z.enum(ROLES)).max(ROLES.length).optional(),
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

meRouter.patch(
  "/",
  validateBody(profileSchema),
  asyncHandler(async (req, res) => {
    res.json({ user: await profileService.updateProfile(req.auth!.sub, req.body) });
  }),
);

meRouter.post(
  "/avatar",
  avatarUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("An image is required (multipart field 'file')");
    res.json({
      user: await profileService.setAvatar(req.auth!.sub, {
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      }),
    });
  }),
);

meRouter.post(
  "/onboarding/complete",
  asyncHandler(async (req, res) => {
    res.json({ user: await profileService.completeOnboarding(req.auth!.sub) });
  }),
);

meRouter.post(
  "/departments/:id",
  asyncHandler(async (req, res) => {
    res.json({ user: await profileService.joinDepartment(req.auth!.sub, req.params.id!) });
  }),
);

meRouter.delete(
  "/departments/:id",
  asyncHandler(async (req, res) => {
    res.json({ user: await profileService.leaveDepartment(req.auth!.sub, req.params.id!) });
  }),
);

meRouter.post(
  "/projects/:id",
  asyncHandler(async (req, res) => {
    res.json({ user: await profileService.joinProject(req.auth!.sub, req.params.id!) });
  }),
);

meRouter.delete(
  "/projects/:id",
  asyncHandler(async (req, res) => {
    res.json({ user: await profileService.leaveProject(req.auth!.sub, req.params.id!) });
  }),
);
