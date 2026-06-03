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
authRouter.post("/refresh", asyncHandler(authController.refresh));
authRouter.post("/logout", asyncHandler(authController.logout));
authRouter.get("/me", requireAuth, asyncHandler(authController.me));

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
