import { Router } from "express";
import { asyncHandler, notFound } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { usersRepo } from "./users.repo";

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
