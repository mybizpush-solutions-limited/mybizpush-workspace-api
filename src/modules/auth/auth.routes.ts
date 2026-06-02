import { Router } from "express";
import { asyncHandler } from "../../lib/errors";
import { validateBody } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";
import { authController } from "./auth.controller";
import { forgotPasswordSchema, loginSchema, registerSchema, resetPasswordSchema } from "./auth.schemas";

export const authRouter = Router();

// Throttle credential + reset endpoints to blunt brute-force / abuse.
const loginLimiter = rateLimit({ windowSec: 60, max: 10, keyPrefix: "login" });
const resetLimiter = rateLimit({ windowSec: 600, max: 5, keyPrefix: "pwreset" });

authRouter.post("/register", loginLimiter, validateBody(registerSchema), asyncHandler(authController.register));
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
