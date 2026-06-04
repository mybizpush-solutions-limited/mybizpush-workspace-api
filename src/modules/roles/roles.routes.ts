import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth, requireAccessLevel } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { rolesService } from "./roles.service";

export const rolesRouter = Router();
rolesRouter.use(requireAuth);

const addRoleSchema = z.object({ name: z.string().trim().min(1).max(40) });
const renameRoleSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1).max(40),
});

// The role catalog everyone picks from (built-in roles + exec-added ones).
rolesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ roles: await rolesService.list() });
  }),
);

// Exec-only: add a new role to the shared catalog.
rolesRouter.post(
  "/",
  requireAccessLevel("executive_admin"),
  validateBody(addRoleSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ roles: await rolesService.add(req.body.name, req.auth!.sub) });
  }),
);

// Exec-only: rename a custom role (updates it on every member too). Built-in
// roles can't be renamed.
rolesRouter.patch(
  "/",
  requireAccessLevel("executive_admin"),
  validateBody(renameRoleSchema),
  asyncHandler(async (req, res) => {
    res.json({ roles: await rolesService.rename(req.body.from, req.body.to) });
  }),
);

// Exec-only: remove a custom role (and strip it from every member). The role
// name rides in the query string since names can contain "/" and spaces.
rolesRouter.delete(
  "/",
  requireAccessLevel("executive_admin"),
  asyncHandler(async (req, res) => {
    res.json({ roles: await rolesService.remove(String(req.query.name ?? "")) });
  }),
);
