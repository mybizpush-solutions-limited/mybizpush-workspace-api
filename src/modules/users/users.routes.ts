import { Router } from "express";
import { z } from "zod";
import { asyncHandler, notFound } from "../../lib/errors";
import { requireAuth, requireAccessLevel } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { usersRepo } from "./users.repo";
import { usersService } from "./users.service";
import { audit } from "../../lib/audit";
import { maskStaff, seesPrivateStaffFields } from "../access/visibility";

export const usersRouter = Router();

usersRouter.use(requireAuth);

const accessLevelSchema = z.object({
  accessLevel: z.enum(["member", "admin", "chief", "executive_admin"]),
});

// Membership in the catalog (built-ins + custom roles) is enforced in the
// service; here we just bound the shape.
const rolesSchema = z.object({
  roles: z.array(z.string().trim().min(1).max(40)),
});

const chiefBadgeSchema = z.object({ value: z.boolean() });

usersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const privileged = await seesPrivateStaffFields(req.auth!.sub);
    res.json({ users: (await usersRepo.list()).map((u) => maskStaff(u, req.auth!.sub, privileged)) });
  }),
);

usersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const user = await usersRepo.publicById(req.params.id!);
    if (!user) throw notFound("User not found");
    res.json({ user: maskStaff(user, req.auth!.sub, await seesPrivateStaffFields(req.auth!.sub)) });
  }),
);

// Exec-only: change a member's access level (this is what makes someone an
// executive admin — not their department).
usersRouter.patch(
  "/:id/access-level",
  requireAccessLevel("executive_admin"),
  validateBody(accessLevelSchema),
  asyncHandler(async (req, res) => {
    const before = await usersRepo.publicById(req.params.id!);
    const user = await usersService.setAccessLevel(req.auth!.sub, req.params.id!, req.body.accessLevel);
    await audit({
      req,
      action: "user.access_level.change",
      target: { type: "user", id: req.params.id! },
      scope: { type: "organization" },
      before: { accessLevel: before?.accessLevel },
      after: { accessLevel: user.accessLevel },
    });
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
    const before = await usersRepo.publicById(req.params.id!);
    const user = await usersService.setRoles(req.params.id!, req.body.roles);
    await audit({
      req,
      action: "user.job_titles.change",
      target: { type: "user", id: req.params.id! },
      before: { roles: before?.roles },
      after: { roles: user.roles },
    });
    res.json({ user });
  }),
);

// Exec-only: grant/remove the golden Chief badge (independent of access level).
usersRouter.patch(
  "/:id/chief-badge",
  requireAccessLevel("executive_admin"),
  validateBody(chiefBadgeSchema),
  asyncHandler(async (req, res) => {
    const user = await usersService.setChiefBadge(req.params.id!, req.body.value);
    await audit({
      req,
      action: "user.chief_badge.change",
      target: { type: "user", id: req.params.id! },
      after: { chiefBadge: req.body.value },
    });
    res.json({ user });
  }),
);

// Exec-only: permanently delete a member. `?blacklist=true` (or body
// { blacklist: true }) also bans their email(s) from signing up again.
usersRouter.delete(
  "/:id",
  requireAccessLevel("executive_admin"),
  asyncHandler(async (req, res) => {
    const blacklist = req.query.blacklist === "true" || req.body?.blacklist === true;
    const before = await usersRepo.publicById(req.params.id!);
    await usersService.remove(req.auth!.sub, req.params.id!, blacklist);
    await audit({
      req,
      action: blacklist ? "user.delete_and_block" : "user.delete",
      target: { type: "user", id: req.params.id! },
      before: before ? { name: before.name, email: before.email, accessLevel: before.accessLevel } : null,
    });
    res.status(204).end();
  }),
);
