import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth, requireAccessLevel } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { rolesService } from "./roles.service";
import { audit } from "../../lib/audit";

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
    const roles = await rolesService.list();
    res.json({ roles, builtIn: roles.filter((name) => rolesService.isStandard(name)) });
  }),
);

// Executives and chiefs: add a new role to the shared catalog.
rolesRouter.post(
  "/",
  requireAccessLevel("executive_admin", "chief"),
  validateBody(addRoleSchema),
  asyncHandler(async (req, res) => {
    const roles = await rolesService.add(req.body.name, req.auth!.sub);
    await audit({ req, action: "job_title.create", target: { type: "job_title", id: req.body.name } });
    res.status(201).json({ roles });
  }),
);

// Executives and chiefs: rename a custom role (updates it on every member too). Built-in
// roles can't be renamed.
rolesRouter.patch(
  "/",
  requireAccessLevel("executive_admin", "chief"),
  validateBody(renameRoleSchema),
  asyncHandler(async (req, res) => {
    const roles = await rolesService.rename(req.body.from, req.body.to);
    await audit({
      req,
      action: "job_title.rename",
      target: { type: "job_title", id: req.body.to },
      before: { name: req.body.from },
      after: { name: req.body.to },
    });
    res.json({ roles });
  }),
);

// Executives and chiefs: remove a custom role (and strip it from every member). The role
// name rides in the query string since names can contain "/" and spaces.
rolesRouter.delete(
  "/",
  requireAccessLevel("executive_admin", "chief"),
  asyncHandler(async (req, res) => {
    const name = String(req.query.name ?? "");
    const roles = await rolesService.remove(name);
    await audit({ req, action: "job_title.delete", target: { type: "job_title", id: name } });
    res.json({ roles });
  }),
);
