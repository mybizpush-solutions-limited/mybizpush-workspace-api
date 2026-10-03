import type { CookieOptions, Request, Response } from "express";
import { unauthorized } from "../../lib/errors";
import { authService } from "./auth.service";
import { mfaService } from "./mfa.service";
import type { AuthStep } from "./session";

const REFRESH_COOKIE = "refresh_token";

// The UI and the API are deployed on DIFFERENT registrable domains
// (workspace.mybizpush.com → mybizpushworkspace.hyparrow.com), which makes every
// /auth/refresh call cross-site. A SameSite=Lax cookie is not sent on a
// cross-site fetch, so the refresh cookie was silently unusable in production
// and every session died the moment the 15-minute access token expired.
// SameSite=None fixes that, and the spec requires Secure alongside it.
//
// Derived from the request rather than NODE_ENV on purpose: the deployed API
// runs with NODE_ENV=development, so keying off isProd would have left the
// cookie non-Secure — and therefore rejected — in production.
function refreshCookieOptions(req: Request): CookieOptions {
  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  return {
    httpOnly: true,
    secure,
    // Plain http (local dev) can't use SameSite=None — browsers drop a
    // non-Secure None cookie — so fall back to Lax, which is same-site there.
    sameSite: secure ? "none" : "lax",
    path: "/api/v1/auth",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  };
}

function setRefreshCookie(req: Request, res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions(req));
}

// Every sign-in step answers the same way: either the session (refresh token in
// the cookie, never the body) or the challenge for the next step.
function sendStep(req: Request, res: Response, step: AuthStep, status = 200) {
  if (step.status === "complete") {
    const { refreshToken, ...body } = step;
    setRefreshCookie(req, res, refreshToken);
    res.status(status).json(body);
    return;
  }
  res.json(step);
}

export const authController = {
  // Step 1 — email a verification code.
  async registerStart(req: Request, res: Response) {
    await authService.startRegistration(req.body);
    res.json({ ok: true });
  },

  async resendOtp(req: Request, res: Response) {
    await authService.resendOtp(req.body.email);
    res.json({ ok: true });
  },

  // Step 2 — verify the code and create the account; MFA enrollment is next.
  async registerVerify(req: Request, res: Response) {
    sendStep(req, res, await authService.verifyRegistration(req.body.email, req.body.otp));
  },

  async login(req: Request, res: Response) {
    sendStep(req, res, await authService.login(req.body));
  },

  async completePasswordChange(req: Request, res: Response) {
    sendStep(
      req,
      res,
      await authService.completeForcedPasswordChange(req.body.challengeToken, req.body.newPassword),
    );
  },

  async mfaSetup(req: Request, res: Response) {
    res.json(await mfaService.beginSetup(req.body.challengeToken));
  },

  async mfaConfirm(req: Request, res: Response) {
    sendStep(req, res, await mfaService.confirmSetup(req.body.challengeToken, req.body.code));
  },

  async mfaVerify(req: Request, res: Response) {
    sendStep(req, res, await mfaService.verifyChallenge(req.body.challengeToken, req.body.code));
  },

  async mfaStatus(req: Request, res: Response) {
    res.json(await mfaService.status(req.auth!.sub));
  },

  async mfaRegenerateRecoveryCodes(req: Request, res: Response) {
    res.json({ recoveryCodes: await mfaService.regenerateRecoveryCodes(req.auth!.sub, req.body.code) });
  },

  async refresh(req: Request, res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthorized("No refresh token");
    const { accessToken, refreshToken } = await authService.refresh(token);
    setRefreshCookie(req, res, refreshToken);
    res.json({ accessToken });
  },

  async logout(req: Request, res: Response) {
    await authService.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(req), maxAge: undefined });
    res.status(204).end();
  },

  async me(req: Request, res: Response) {
    const user = await authService.me(req.auth!.sub);
    res.json({ user });
  },

  async forgotPassword(req: Request, res: Response) {
    await authService.requestPasswordReset(req.body.email, req.body.useGoogle === true);
    // Always 200 — don't reveal whether the account exists.
    res.json({ ok: true });
  },

  async resetPassword(req: Request, res: Response) {
    await authService.resetPassword(req.body.token, req.body.password);
    res.json({ ok: true });
  },

  // Logged-in self-service password change via an emailed OTP.
  async requestPasswordChange(req: Request, res: Response) {
    await authService.requestPasswordChangeOtp(req.auth!.sub, req.body?.useGoogle === true);
    res.json({ ok: true });
  },

  async changePassword(req: Request, res: Response) {
    await authService.changePasswordWithOtp(req.auth!.sub, req.body.otp, req.body.password);
    res.json({ ok: true });
  },
};
