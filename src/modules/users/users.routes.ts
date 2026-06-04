import { Router } from "express";
import { z } from "zod";
import { asyncHandler, notFound } from "../../lib/errors";
import { requireAuth, requireAccessLevel } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { usersRepo } from "./users.repo";
import { usersService } from "./users.service";

export const usersRouter = Router();

usersRouter.use(requireAuth);

const accessLevelSchema = z.object({
  accessLevel: z.enum(["member", "admin", "chief", "executive_admin"]),
});

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
