import { z } from "zod";
import { passwordPolicyFailures, passwordPolicyMessage } from "../../lib/passwordPolicy";

// Every password a user sets goes through the shared policy.
const newPassword = z
  .string()
  .max(200)
  .superRefine((value, ctx) => {
    const failures = passwordPolicyFailures(value);
    if (failures.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: passwordPolicyMessage(failures) });
  });

const challengeToken = z.string().min(1, "Missing sign-in session").max(200);
const mfaCode = z.string().trim().min(6, "Enter the 6-digit code").max(20);

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: newPassword,
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export const verifyRegistrationSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  otp: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

export const resendOtpSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  useGoogle: z.boolean().optional(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: newPassword,
});

export const changePasswordSchema = z.object({
  otp: z.string().trim().length(6, "Enter the 6-digit code"),
  password: newPassword,
});

export const completePasswordChangeSchema = z.object({
  challengeToken,
  newPassword,
});

export const mfaSetupSchema = z.object({ challengeToken });

// `code` is a 6-digit TOTP or, for /verify only, a recovery code (XXXXX-XXXXX).
export const mfaChallengeSchema = z.object({ challengeToken, code: mfaCode });

export const mfaCodeSchema = z.object({ code: mfaCode });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
