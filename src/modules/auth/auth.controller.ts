import type { CookieOptions, Request, Response } from "express";
import { unauthorized } from "../../lib/errors";
import { authService } from "./auth.service";

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

  // Step 2 — verify the code, create the account, and sign in.
  async registerVerify(req: Request, res: Response) {
    const { user, accessToken, refreshToken } = await authService.verifyRegistration(
      req.body.email,
      req.body.otp,
    );
    setRefreshCookie(req, res, refreshToken);
    res.status(201).json({ user, accessToken });
  },

  async login(req: Request, res: Response) {
    const { user, accessToken, refreshToken } = await authService.login(req.body);
    setRefreshCookie(req, res, refreshToken);
    res.json({ user, accessToken });
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
