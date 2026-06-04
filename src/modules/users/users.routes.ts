import { Router } from "express";
import { z } from "zod";
import { asyncHandler, notFound } from "../../lib/errors";
import { requireAuth, requireAccessLevel } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { ROLES } from "../../models";
import { usersRepo } from "./users.repo";
import { usersService } from "./users.service";

export const usersRouter = Router();

usersRouter.use(requireAuth);

const accessLevelSchema = z.object({
  accessLevel: z.enum(["member", "admin", "chief", "executive_admin"]),
});

const rolesSchema = z.object({
  roles: z.array(z.enum(ROLES)),
});

const chiefBadgeSchema = z.object({ value: z.boolean() });

usersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ users: await usersRepo.list() });
  }),
);

usersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const user = await usersRepo.publicById(req.params.id!);
    if (!user) throw notFound("User not found");
    res.json({ user });
  }),
);

// Exec-only: change a member's access level (this is what makes someone an
// executive admin — not their department).
usersRouter.patch(
  "/:id/access-level",
  requireAccessLevel("executive_admin"),
  validateBody(accessLevelSchema),
  asyncHandler(async (req, res) => {
    const user = await usersService.setAccessLevel(req.auth!.sub, req.params.id!, req.body.accessLevel);
    res.json({ user });
  }),
);

// Exec-only: set any member's roles (Frontend, Backend, CEO, CTO, …). Members
// edit their own roles via PATCH /me; this lets an executive admin manage them
// for anyone.
usersRouter.patch(
  "/:id/roles",
  requireAccessLevel("executive_admin"),
  validateBody(rolesSchema),
  asyncHandler(async (req, res) => {
    res.json({ user: await usersService.setRoles(req.params.id!, req.body.roles) });
  }),
);

// Exec-only: grant/remove the golden Chief badge (independent of access level).
usersRouter.patch(
  "/:id/chief-badge",
  requireAccessLevel("executive_admin"),
  validateBody(chiefBadgeSchema),
  asyncHandler(async (req, res) => {
    res.json({ user: await usersService.setChiefBadge(req.params.id!, req.body.value) });
  }),
);

// Exec-only: permanently delete a member. `?blacklist=true` (or body
// { blacklist: true }) also bans their email(s) from signing up again.
usersRouter.delete(
  "/:id",
  requireAccessLevel("executive_admin"),
  asyncHandler(async (req, res) => {
    const blacklist = req.query.blacklist === "true" || req.body?.blacklist === true;
    await usersService.remove(req.auth!.sub, req.params.id!, blacklist);
    res.status(204).end();
  }),
);
