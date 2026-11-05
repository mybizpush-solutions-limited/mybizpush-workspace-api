import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler, badRequest, forbidden, notFound } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { AccessAssignment, AccessOverride, AccessRole, User } from "../../models";
import { ALL_PERMISSIONS, CATALOG, PERMISSION_SET, SCOPE_TYPES, type Scope } from "./catalog";
import { can, clearRoleIndex, explain, invalidateAccess, permissionsAt, scopeOf } from "./engine";
import { slugify } from "../../lib/slug";

// Roles, assignments, overrides and "who can" (API-CHANGES A105, PERM-01..08).
export const accessRouter = Router();
accessRouter.use(requireAuth);

async function require(req: Request, permission: string, scope?: Scope) {
  if (!(await can(req.auth!, permission, scope))) throw forbidden("You don't have permission to do this");
}

function scopeFrom(q: { scopeType?: unknown; scopeId?: unknown }): Scope {
  const type = String(q.scopeType ?? "organization");
  if (!(SCOPE_TYPES as readonly string[]).includes(type)) throw badRequest("Unknown scope type");
  if (type !== "organization" && !q.scopeId) throw badRequest("scopeId is required for this scope");
  return scopeOf(type as Scope["type"], type === "organization" ? null : String(q.scopeId));
}

const serializeRole = (r: AccessRole, members?: number) => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  system: r.isSystem,
  defaultScope: r.defaultScope,
  permissions: r.permissions,
  ...(members !== undefined ? { assignments: members } : {}),
});

const permissionList = z.array(z.string()).refine((ps) => ps.every((p) => p === "*" || PERMISSION_SET.has(p)), "Unknown permission");

// ---- Catalog and my permissions ----------------------------------------------

accessRouter.get(
  "/catalog",
  asyncHandler(async (_req, res) => {
    res.json({ resources: CATALOG, scopes: SCOPE_TYPES });
  }),
);

// What I can do at a scope; the app hides actions not in this list.
accessRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const scope = scopeFrom(req.query);
    res.json({ scope, permissions: await permissionsAt(req.auth!.sub, scope, ALL_PERMISSIONS) });
  }),
);

// ---- Roles ----------------------------------------------------------------------

accessRouter.get(
  "/roles",
  asyncHandler(async (req, res) => {
    await require(req, "role.view");
    const [roles, counts] = await Promise.all([
      AccessRole.findAll({ order: [["isSystem", "DESC"], ["name", "ASC"]] }),
      AccessAssignment.count({ group: ["roleId"] }) as unknown as Promise<{ roleId: string; count: number }[]>,
    ]);
    const byRole = new Map(counts.map((c) => [c.roleId, Number(c.count)]));
    res.json({ roles: roles.map((r) => serializeRole(r, byRole.get(r.id) ?? 0)) });
  }),
);

const roleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(240).optional(),
  defaultScope: z.enum(SCOPE_TYPES).optional(),
  permissions: permissionList.optional(),
  copyFromRoleId: z.string().uuid().optional(),
});

accessRouter.post(
  "/roles",
  validateBody(roleSchema),
  asyncHandler(async (req, res) => {
    await require(req, "role.manage");
    const body = req.body as z.infer<typeof roleSchema>;
    let permissions = body.permissions ?? [];
    if (body.copyFromRoleId) {
      const src = await AccessRole.findByPk(body.copyFromRoleId);
      if (!src) throw notFound("Role to copy not found");
      permissions = src.permissions.filter((p) => p !== "*");
    }
    const key = slugify(body.name).replace(/-/g, "_");
    if (await AccessRole.findOne({ where: { key } })) throw badRequest("A role with this name already exists");
    const role = await AccessRole.create({
      key,
      name: body.name,
      description: body.description ?? "",
      defaultScope: body.defaultScope ?? "organization",
      permissions,
      createdBy: req.auth!.sub,
    });
    clearRoleIndex();
    await invalidateAccess();
    await audit({ req, action: "role.create", target: { type: "role", id: role.id }, after: { name: role.name, permissions } });
    res.status(201).json({ role: serializeRole(role, 0) });
  }),
);

accessRouter.patch(
  "/roles/:id",
  validateBody(roleSchema.partial().omit({ copyFromRoleId: true })),
  asyncHandler(async (req, res) => {
    await require(req, "role.manage");
    const role = await AccessRole.findByPk(req.params.id!);
    if (!role) throw notFound("Role not found");
    if (role.key === "executive_admin") throw badRequest("Executive admin always has every permission");
    const before = serializeRole(role);
    const body = req.body as Partial<z.infer<typeof roleSchema>>;
    if (body.name !== undefined && !role.isSystem) role.name = body.name;
    if (body.description !== undefined) role.description = body.description;
    if (body.defaultScope !== undefined) role.defaultScope = body.defaultScope;
    if (body.permissions !== undefined) role.permissions = body.permissions;
    await role.save();
    clearRoleIndex();
    await invalidateAccess();
    await audit({
      req,
      action: "role.update",
      target: { type: "role", id: role.id },
      before: { name: before.name, permissions: before.permissions },
      after: { name: role.name, permissions: role.permissions },
    });
    res.json({ role: serializeRole(role) });
  }),
);

accessRouter.delete(
  "/roles/:id",
  asyncHandler(async (req, res) => {
    await require(req, "role.manage");
    const role = await AccessRole.findByPk(req.params.id!);
    if (!role) throw notFound("Role not found");
    if (role.isSystem) throw badRequest("System roles can't be deleted");
    await audit({ req, action: "role.delete", target: { type: "role", id: role.id }, before: { name: role.name, permissions: role.permissions } });
    await role.destroy();
    clearRoleIndex();
    await invalidateAccess();
    res.status(204).end();
  }),
);

// ---- Assignments ---------------------------------------------------------------

const assignSchema = z.object({
  roleId: z.string().uuid(),
  subjects: z.array(z.object({ type: z.enum(["user", "department", "team"]), id: z.string().uuid() })).min(1).max(200),
  scopeType: z.enum(SCOPE_TYPES),
  scopeId: z.string().uuid().nullable().optional(),
});

accessRouter.get(
  "/assignments",
  asyncHandler(async (req, res) => {
    await require(req, "role.view");
    const where: Record<string, unknown> = {};
    if (typeof req.query.userId === "string") Object.assign(where, { subjectType: "user", subjectId: req.query.userId });
    if (typeof req.query.roleId === "string") where.roleId = req.query.roleId;
    if (typeof req.query.scopeType === "string") where.scopeType = req.query.scopeType;
    if (typeof req.query.scopeId === "string") where.scopeId = req.query.scopeId;
    const rows = await AccessAssignment.findAll({ where, order: [["createdAt", "DESC"]], limit: 500 });
    res.json({ assignments: rows.map((a) => ({ id: a.id, roleId: a.roleId, subject: { type: a.subjectType, id: a.subjectId }, scope: { type: a.scopeType, id: a.scopeId }, createdAt: a.createdAt })) });
  }),
);

accessRouter.post(
  "/assignments",
  validateBody(assignSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof assignSchema>;
    const scope = scopeFrom({ scopeType: body.scopeType, scopeId: body.scopeId });
    // Assigning inside a product or project needs role.assign there; org-wide needs it org-wide.
    await require(req, "role.assign", scope);
    const role = await AccessRole.findByPk(body.roleId);
    if (!role) throw notFound("Role not found");
    if (role.key === "executive_admin" && !(await can(req.auth!, "role.manage"))) throw forbidden("Only executives can assign executive admin");
    const created = [];
    for (const s of body.subjects) {
      const [row] = await AccessAssignment.findOrCreate({
        where: { roleId: role.id, subjectType: s.type, subjectId: s.id, scopeType: scope.type, scopeId: scope.id ?? null },
        defaults: { roleId: role.id, subjectType: s.type, subjectId: s.id, scopeType: scope.type, scopeId: scope.id ?? null, createdBy: req.auth!.sub },
      });
      created.push(row);
      await audit({ req, action: "role.assign", target: { type: s.type, id: s.id }, scope: { type: scope.type, id: scope.id ?? null }, after: { role: role.key } });
    }
    await invalidateAccess();
    res.status(201).json({ assignments: created.map((a) => ({ id: a.id, roleId: a.roleId, subject: { type: a.subjectType, id: a.subjectId }, scope: { type: a.scopeType, id: a.scopeId } })) });
  }),
);

accessRouter.delete(
  "/assignments/:id",
  asyncHandler(async (req, res) => {
    const a = await AccessAssignment.findByPk(req.params.id!);
    if (!a) throw notFound("Assignment not found");
    await require(req, "role.assign", scopeOf(a.scopeType, a.scopeId));
    const role = await AccessRole.findByPk(a.roleId);
    await audit({ req, action: "role.unassign", target: { type: a.subjectType, id: a.subjectId }, scope: { type: a.scopeType, id: a.scopeId ?? null }, before: { role: role?.key } });
    await a.destroy();
    await invalidateAccess();
    res.status(204).end();
  }),
);

// ---- Overrides -----------------------------------------------------------------

const overrideSchema = z.object({
  userId: z.string().uuid(),
  permission: z.string().refine((p) => PERMISSION_SET.has(p), "Unknown permission"),
  effect: z.enum(["grant", "deny"]),
  scopeType: z.enum(SCOPE_TYPES),
  scopeId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().max(240).optional(),
  expiresAt: z.string().datetime().optional(),
});

accessRouter.get(
  "/overrides",
  asyncHandler(async (req, res) => {
    await require(req, "role.view");
    const where = typeof req.query.userId === "string" ? { userId: req.query.userId } : {};
    const rows = await AccessOverride.findAll({ where, order: [["createdAt", "DESC"]], limit: 500 });
    res.json({ overrides: rows });
  }),
);

accessRouter.post(
  "/overrides",
  validateBody(overrideSchema),
  asyncHandler(async (req, res) => {
    await require(req, "role.manage");
    const body = req.body as z.infer<typeof overrideSchema>;
    const scope = scopeFrom({ scopeType: body.scopeType, scopeId: body.scopeId });
    if (body.userId === req.auth!.sub && body.effect === "grant") throw badRequest("You can't grant yourself permissions");
    const row = await AccessOverride.create({
      userId: body.userId,
      permission: body.permission,
      effect: body.effect,
      scopeType: scope.type,
      scopeId: scope.id ?? null,
      reason: body.reason ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      createdBy: req.auth!.sub,
    });
    await invalidateAccess();
    await audit({
      req,
      action: `permission.${body.effect}`,
      target: { type: "user", id: body.userId },
      scope: { type: scope.type, id: scope.id ?? null },
      after: { permission: body.permission, reason: body.reason ?? null },
    });
    res.status(201).json({ override: row });
  }),
);

accessRouter.delete(
  "/overrides/:id",
  asyncHandler(async (req, res) => {
    await require(req, "role.manage");
    const o = await AccessOverride.findByPk(req.params.id!);
    if (!o) throw notFound("Override not found");
    await audit({ req, action: "permission.override.remove", target: { type: "user", id: o.userId }, scope: { type: o.scopeType, id: o.scopeId ?? null }, before: { permission: o.permission, effect: o.effect } });
    await o.destroy();
    await invalidateAccess();
    res.status(204).end();
  }),
);

// ---- Who can, effective permissions --------------------------------------------

accessRouter.get(
  "/who-can",
  asyncHandler(async (req, res) => {
    await require(req, "role.view");
    const permission = String(req.query.permission ?? "");
    if (!PERMISSION_SET.has(permission)) throw badRequest("Unknown permission");
    const scope = scopeFrom(req.query);
    const users = await User.findAll({ attributes: ["id", "name", "avatarUrl"], order: [["name", "ASC"]] });
    const results = [];
    for (const u of users) {
      const d = await explain(u.id, permission, scope);
      if (d.allowed || d.reason === "denied_override") results.push({ user: { id: u.id, name: u.name, avatarUrl: u.avatarUrl }, ...d });
    }
    res.json({ permission, scope, people: results });
  }),
);

accessRouter.get(
  "/users/:id/effective",
  asyncHandler(async (req, res) => {
    if (req.params.id !== req.auth!.sub) await require(req, "role.view");
    const scope = scopeFrom(req.query);
    const decisions = await Promise.all(ALL_PERMISSIONS.map(async (p) => ({ permission: p, ...(await explain(req.params.id!, p, scope)) })));
    res.json({ scope, decisions });
  }),
);

// Assignments a user holds (explicit only), for the staff profile Roles section.
accessRouter.get(
  "/users/:id/roles",
  asyncHandler(async (req, res) => {
    if (req.params.id !== req.auth!.sub) await require(req, "role.view");
    const rows = await AccessAssignment.findAll({
      where: { subjectType: "user", subjectId: req.params.id! },
      include: [{ model: AccessRole, as: "role", attributes: ["key", "name"] }],
    });
    res.json({
      roles: rows.map((a) => ({ id: a.id, role: a.get("role"), scope: { type: a.scopeType, id: a.scopeId } })),
    });
  }),
);
