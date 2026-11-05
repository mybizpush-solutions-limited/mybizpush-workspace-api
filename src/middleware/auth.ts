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

// Requires a permission from the permission engine (A103). `scope` reads the
// target scope from the request (e.g. the product id in the URL); omit it for
// organization-wide permissions.
export function requirePermission(
  permission: string,
  scope?: (req: Request) => { type: "organization" | "department" | "team" | "product" | "project"; id?: string | null },
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw unauthorized();
    // Lazy import keeps the auth middleware free of model imports at load time.
    import("../modules/access/engine")
      .then(({ can }) => can(req.auth!, permission, scope?.(req)))
      .then((ok) => (ok ? next() : next(forbidden("You don't have permission to do this"))))
      .catch(next);
  };
}
