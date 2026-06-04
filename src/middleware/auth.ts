import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/jwt";
import { forbidden, unauthorized } from "../lib/errors";

type AccessLevel = "member" | "admin" | "chief" | "executive_admin";

// Requires a valid Bearer access token; attaches req.auth.
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized("Missing bearer token");
  req.auth = verifyAccessToken(header.slice("Bearer ".length).trim());
  next();
}

// Requires the authenticated user to hold one of the given access levels.
// executive_admin implicitly satisfies admin-level checks.
export function requireAccessLevel(...allowed: AccessLevel[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw unauthorized();
    const level = req.auth.accessLevel as AccessLevel;
    const ok = allowed.includes(level) || (level === "executive_admin" && allowed.includes("admin"));
    if (!ok) throw forbidden("Insufficient permissions");
    next();
  };
}
