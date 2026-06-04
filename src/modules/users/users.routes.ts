import { Router } from "express";
import { asyncHandler, notFound } from "../../lib/errors";
import { requireAuth, requireAccessLevel } from "../../middleware/auth";
import { usersRepo } from "./users.repo";
import { usersService } from "./users.service";

export const usersRouter = Router();

usersRouter.use(requireAuth);

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
