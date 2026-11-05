import type { CookieOptions, Request, Response } from "express";
import { badRequest, unauthorized } from "../../lib/errors";
import type { ClientInfo } from "../../lib/jwt";
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

// Native apps (the Expo mobile app) have no browser cookie jar, so they carry
// the refresh token themselves: they identify with `X-Client: mobile`, or simply
// send the token in the body. Those clients get the rotated token back in the
// JSON body instead of a cookie. Browsers are unaffected: no header, no body
// token, cookie flow exactly as before.
function isTokenClient(req: Request): boolean {
  return req.get("x-client")?.toLowerCase() === "mobile" || typeof req.body?.refreshToken === "string";
}

// The refresh token presented by the caller: body first (mobile), then cookie (web).
function presentedRefreshToken(req: Request): string | undefined {
  const fromBody = req.body?.refreshToken;
  if (typeof fromBody === "string" && fromBody.length > 0) return fromBody;
  return req.cookies?.[REFRESH_COOKIE];
}

// Delivers a refresh token the way the client can store it: JSON body for
// native clients, httpOnly cookie for browsers. Returns the extra body fields.
function deliverRefreshToken(req: Request, res: Response, token: string): { refreshToken?: string } {
  if (isTokenClient(req)) return { refreshToken: token };
  setRefreshCookie(req, res, token);
  return {};
}

// Where this request comes from, for session and login-history records. The
// app sends X-Device-Name ("Pixel 8") and X-Platform (ios | android | web).
function clientInfo(req: Request): ClientInfo {
  const platform = req.get("x-platform")?.toLowerCase();
  return {
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
    device: req.get("x-device-name")?.slice(0, 120) ?? null,
    platform: platform && ["ios", "android", "web"].includes(platform) ? platform : null,
  };
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
      clientInfo(req),
    );
    res.status(201).json({ user, accessToken, ...deliverRefreshToken(req, res, refreshToken) });
  },

  async login(req: Request, res: Response) {
    const { user, accessToken, refreshToken } = await authService.login(req.body, clientInfo(req));
    res.json({ user, accessToken, ...deliverRefreshToken(req, res, refreshToken) });
  },

  async refresh(req: Request, res: Response) {
    const token = presentedRefreshToken(req);
    if (!token) throw unauthorized("No refresh token");
    const { accessToken, refreshToken } = await authService.refresh(token, clientInfo(req));
    res.json({ accessToken, ...deliverRefreshToken(req, res, refreshToken) });
  },

  async logout(req: Request, res: Response) {
    await authService.logout(presentedRefreshToken(req));
    if (!isTokenClient(req)) {
      res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(req), maxAge: undefined });
    }
    res.status(204).end();
  },

  async sessions(req: Request, res: Response) {
    const sessions = await authService.sessions(req.auth!.sub, req.auth!.sid);
    res.json({ sessions });
  },

  async revokeSession(req: Request, res: Response) {
    const id = String(req.params.id ?? "");
    if (!id) throw badRequest("Session id is required");
    await authService.revokeSession(req.auth!.sub, id);
    res.status(204).end();
  },

  async revokeOtherSessions(req: Request, res: Response) {
    await authService.revokeOtherSessions(req.auth!.sub, req.auth!.sid);
    res.status(204).end();
  },

  async loginHistory(req: Request, res: Response) {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const events = await authService.loginHistory(req.auth!.sub, limit);
    res.json({ events });
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
