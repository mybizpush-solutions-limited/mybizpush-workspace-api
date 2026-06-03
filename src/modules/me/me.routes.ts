import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { ROLES } from "../../models";
import { meService } from "./me.service";
import { profileService } from "./profile.service";
import { departmentsService } from "../departments/departments.service";
import { authService } from "../auth/auth.service";

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

// ---- Secondary (second @domain) email linking -----------------------------
const secondaryEmailSchema = z.object({ email: z.string().trim().email() });
const secondaryVerifySchema = z.object({ otp: z.string().trim().length(6) });

// Step 1: email a verification code to the address being linked.
meRouter.post(
  "/secondary-email/request",
  validateBody(secondaryEmailSchema),
  asyncHandler(async (req, res) => {
    await authService.requestSecondaryEmailOtp(req.auth!.sub, req.body.email);
    res.json({ ok: true });
  }),
);

// Step 2: verify the code and attach the address.
meRouter.post(
  "/secondary-email/verify",
  validateBody(secondaryVerifySchema),
  asyncHandler(async (req, res) => {
    res.json({ user: await authService.verifySecondaryEmail(req.auth!.sub, req.body.otp) });
  }),
);

meRouter.delete(
  "/secondary-email",
  asyncHandler(async (req, res) => {
    res.json({ user: await authService.removeSecondaryEmail(req.auth!.sub) });
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

// Request to join a department (after onboarding) — needs head/admin approval.
meRouter.post(
  "/departments/:id/request",
  asyncHandler(async (req, res) => {
    res.status(201).json({ request: await departmentsService.requestToJoin(req.auth!.sub, req.params.id!) });
  }),
);

meRouter.get(
  "/department-requests",
  asyncHandler(async (req, res) => {
    res.json({ requests: await departmentsService.myRequests(req.auth!.sub) });
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
