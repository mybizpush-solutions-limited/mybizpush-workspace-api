import { z } from "zod";
import { twoStepService } from "./twoStep.service";
import { Router } from "express";
import { asyncHandler } from "../../lib/errors";
import { validateBody } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";
import { authController } from "./auth.controller";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendOtpSchema,
  resetPasswordSchema,
  verifyRegistrationSchema,
} from "./auth.schemas";

export const authRouter = Router();

// Throttle credential + reset endpoints to blunt brute-force / abuse.
const loginLimiter = rateLimit({ windowSec: 60, max: 10, keyPrefix: "login" });
const resetLimiter = rateLimit({ windowSec: 600, max: 5, keyPrefix: "pwreset" });
const otpLimiter = rateLimit({ windowSec: 600, max: 8, keyPrefix: "otp" });

// Two-step signup: start → emailed 6-digit code → verify.
authRouter.post("/register/start", otpLimiter, validateBody(registerSchema), asyncHandler(authController.registerStart));
authRouter.post("/register/resend", otpLimiter, validateBody(resendOtpSchema), asyncHandler(authController.resendOtp));
authRouter.post("/register/verify", otpLimiter, validateBody(verifyRegistrationSchema), asyncHandler(authController.registerVerify));

authRouter.post("/login", loginLimiter, validateBody(loginSchema), asyncHandler(authController.login));
// Two-step sign-in (A902). Verify takes the challenge from login, not a bearer token.
// Per person when signed in. Verify can only go by address, but it can allow more
// because each challenge already stops at 5 tries, and an office shares one address.
const twoStepLimiter = rateLimit({ windowSec: 600, max: 20, keyPrefix: "two-step", key: (req) => req.auth?.sub ?? req.ip ?? "unknown" });
const twoStepVerifyLimiter = rateLimit({ windowSec: 600, max: 100, keyPrefix: "two-step-verify" });
const codeBody = z.string().trim().min(6).max(20);
authRouter.get("/2fa/status", requireAuth, asyncHandler(async (req, res) => {
  res.json(await twoStepService.status(req.auth!.sub));
}));
authRouter.post("/2fa/setup", requireAuth, twoStepLimiter, asyncHandler(async (req, res) => {
  res.json(await twoStepService.setup(req.auth!.sub));
}));
authRouter.post("/2fa/enable", requireAuth, twoStepLimiter, validateBody(z.object({ code: codeBody })), asyncHandler(async (req, res) => {
  res.json(await twoStepService.enable(req.auth!.sub, req.body.code, req));
}));
authRouter.post(
  "/2fa/disable",
  requireAuth,
  twoStepLimiter,
  validateBody(z.object({ code: codeBody.optional(), password: z.string().min(1).max(200).optional() }).refine((v) => !!v.code || !!v.password, { message: "Send your code or password" })),
  asyncHandler(async (req, res) => {
    res.json(await twoStepService.disable(req.auth!.sub, req.body, req));
  }),
);
authRouter.post("/2fa/verify", twoStepVerifyLimiter, validateBody(z.object({ challengeToken: z.string().min(1).max(200), code: codeBody })), asyncHandler(authController.twoStepVerify));

authRouter.post("/refresh", asyncHandler(authController.refresh));
authRouter.post("/logout", asyncHandler(authController.logout));
authRouter.get("/me", requireAuth, asyncHandler(authController.me));

// Sessions and devices (A002). "Others" keeps the caller's own session.
authRouter.get("/sessions", requireAuth, asyncHandler(authController.sessions));
authRouter.post("/sessions/revoke-others", requireAuth, asyncHandler(authController.revokeOtherSessions));
authRouter.delete("/sessions/:id", requireAuth, asyncHandler(authController.revokeSession));
authRouter.get("/login-history", requireAuth, asyncHandler(authController.loginHistory));

authRouter.post(
  "/forgot-password",
  resetLimiter,
  validateBody(forgotPasswordSchema),
  asyncHandler(authController.forgotPassword),
);
authRouter.post(
  "/reset-password",
  resetLimiter,
  validateBody(resetPasswordSchema),
  asyncHandler(authController.resetPassword),
);

// Logged-in password change via emailed OTP.
authRouter.post(
  "/change-password/request",
  requireAuth,
  resetLimiter,
  asyncHandler(authController.requestPasswordChange),
);
authRouter.post(
  "/change-password",
  requireAuth,
  validateBody(changePasswordSchema),
  asyncHandler(authController.changePassword),
);
