import { Op, QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { redis } from "../../redis/client";
import { AccessAssignment, AccessOverride, AccessRole, Department, Product, Project, Team, User } from "../../models";
import { ACCESS_LEVEL_ROLE, ORG, type Scope, type ScopeType } from "./catalog";

// The permission engine (API-CHANGES A103, PRD 4.5).
//
// can(user, "task.approve", { type: "project", id }) evaluates, in order:
//   1. the scopes that apply: the target plus its ancestors (organization; a
//      project's product, departments and teams);
//   2. explicit DENY overrides at any of those scopes -> refuse;
//   3. explicit GRANT overrides -> allow;
//   4. role grants: the user's roles, their departments' and teams' roles, and
//      derived roles (access level, department head, project manager, product
//      owner, team lead), each bound to a scope.
// Resolved grants are cached per user in Redis under a global version number;
// any change to roles, assignments or overrides bumps the version.

export interface Grant {
  role: string; // role key
  roleName: string;
  scope: Scope;
  source: "access_level" | "default" | "assigned" | "department" | "team" | "derived";
}

interface Resolved {
  grants: Grant[];
  overrides: { permission: string; effect: "grant" | "deny"; scope: Scope; reason: string | null }[];
}

const VERSION_KEY = "access:version";
const CACHE_TTL_SECONDS = 300;

export async function invalidateAccess(): Promise<void> {
  await redis.incr(VERSION_KEY);
}

let rolesCache: { at: number; byId: Map<string, AccessRole>; byKey: Map<string, AccessRole> } | null = null;
export async function roleIndex() {
  if (rolesCache && Date.now() - rolesCache.at < 30_000) return rolesCache;
  const rows = await AccessRole.findAll();
  rolesCache = { at: Date.now(), byId: new Map(rows.map((r) => [r.id, r])), byKey: new Map(rows.map((r) => [r.key, r])) };
  return rolesCache;
}
export function clearRoleIndex() {
  rolesCache = null;
}

const sameScope = (a: Scope, b: Scope) => a.type === b.type && (a.id ?? null) === (b.id ?? null);

async function resolve(userId: string): Promise<Resolved> {
  const version = (await redis.get(VERSION_KEY)) ?? "0";
  const key = `access:grants:${userId}:${version}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as Resolved;

  const roles = await roleIndex();
  const grants: Grant[] = [];
  const add = (roleKey: string, scope: Scope, source: Grant["source"]) => {
    const r = roles.byKey.get(roleKey);
    if (r) grants.push({ role: r.key, roleName: r.name, scope, source });
  };

  const user = await User.findByPk(userId, {
    attributes: ["id", "accessLevel"],
    include: [
      { model: Department, as: "departments", attributes: ["id"], through: { attributes: [] } },
      { model: Team, as: "teams", attributes: ["id"], through: { attributes: [] } },
    ],
  });
  if (!user) return { grants: [], overrides: [] };

  add("member", ORG, "default");
  const levelRole = ACCESS_LEVEL_ROLE[user.accessLevel];
  if (levelRole && levelRole !== "member") add(levelRole, ORG, "access_level");

  const departmentIds = ((user.get("departments") as Department[] | undefined) ?? []).map((d) => d.id);
  const teamIds = ((user.get("teams") as Team[] | undefined) ?? []).map((t) => t.id);

  const assignments = await AccessAssignment.findAll({
    where: {
      [Op.or]: [
        { subjectType: "user", subjectId: userId },
        ...(departmentIds.length ? [{ subjectType: "department" as const, subjectId: departmentIds }] : []),
        ...(teamIds.length ? [{ subjectType: "team" as const, subjectId: teamIds }] : []),
      ],
    },
  });
  for (const a of assignments) {
    const r = roles.byId.get(a.roleId);
    if (!r) continue;
    grants.push({
      role: r.key,
      roleName: r.name,
      scope: { type: a.scopeType, id: a.scopeId ?? null },
      source: a.subjectType === "user" ? "assigned" : a.subjectType,
    });
  }

  // Positions people already hold keep their powers (parity with the old checks).
  const [headOf, manages, owns, leads] = await Promise.all([
    Department.findAll({ where: { headId: userId }, attributes: ["id"] }),
    Project.findAll({ where: { managerId: userId }, attributes: ["id"] }),
    Product.findAll({ where: { ownerId: userId }, attributes: ["id"] }),
    Team.findAll({ where: { leadId: userId }, attributes: ["id"] }),
  ]);
  headOf.forEach((d) => add("department_head", { type: "department", id: d.id }, "derived"));
  manages.forEach((p) => add("project_manager", { type: "project", id: p.id }, "derived"));
  owns.forEach((p) => add("product_manager", { type: "product", id: p.id }, "derived"));
  leads.forEach((t) => add("team_lead", { type: "team", id: t.id }, "derived"));

  const now = new Date();
  const overrides = (await AccessOverride.findAll({ where: { userId } }))
    .filter((o) => !o.expiresAt || o.expiresAt > now)
    .map((o) => ({ permission: o.permission, effect: o.effect, scope: { type: o.scopeType, id: o.scopeId ?? null }, reason: o.reason ?? null }));

  const resolved: Resolved = { grants, overrides };
  await redis.set(key, JSON.stringify(resolved), "EX", CACHE_TTL_SECONDS);
  return resolved;
}

// The scopes a check at `scope` is covered by (itself first).
export async function scopeChain(scope: Scope): Promise<Scope[]> {
  const chain: Scope[] = [scope];
  if (scope.type === "organization") return chain;
  if (scope.type === "project" && scope.id) {
    const project = await Project.findByPk(scope.id, { attributes: ["id", "productId", "departmentId"] });
    if (project?.productId) chain.push({ type: "product", id: project.productId });
    const links = await sequelize.query<{ department_id: string }>(
      `SELECT department_id FROM project_departments WHERE project_id = :id`,
      { replacements: { id: scope.id }, type: QueryTypes.SELECT },
    );
    const deptIds = new Set(links.map((l) => l.department_id));
    if (project?.departmentId) deptIds.add(project.departmentId);
    deptIds.forEach((id) => chain.push({ type: "department", id }));
    const teams = await sequelize.query<{ team_id: string }>(`SELECT team_id FROM team_projects WHERE project_id = :id`, {
      replacements: { id: scope.id },
      type: QueryTypes.SELECT,
    });
    teams.forEach((t) => chain.push({ type: "team", id: t.team_id }));
  }
  chain.push(ORG);
  return chain;
}

function rolePermits(roleKey: string, permission: string, roles: Awaited<ReturnType<typeof roleIndex>>): boolean {
  const r = roles.byKey.get(roleKey);
  return !!r && (r.permissions.includes("*") || r.permissions.includes(permission));
}

export interface Decision {
  allowed: boolean;
  reason: "denied_override" | "granted_override" | "role" | "none";
  via?: { role?: string; roleName?: string; scope: Scope; source?: Grant["source"]; note?: string | null };
}

export async function explain(userId: string, permission: string, scope: Scope = ORG): Promise<Decision> {
  const [resolved, chain, roles] = await Promise.all([resolve(userId), scopeChain(scope), roleIndex()]);
  const inChain = (s: Scope) => chain.some((c) => sameScope(c, s));

  const deny = resolved.overrides.find((o) => o.effect === "deny" && o.permission === permission && inChain(o.scope));
  if (deny) return { allowed: false, reason: "denied_override", via: { scope: deny.scope, note: deny.reason } };
  const grant = resolved.overrides.find((o) => o.effect === "grant" && o.permission === permission && inChain(o.scope));
  if (grant) return { allowed: true, reason: "granted_override", via: { scope: grant.scope, note: grant.reason } };

  const g = resolved.grants.find((x) => inChain(x.scope) && rolePermits(x.role, permission, roles));
  if (g) return { allowed: true, reason: "role", via: { role: g.role, roleName: g.roleName, scope: g.scope, source: g.source } };
  return { allowed: false, reason: "none" };
}

export async function can(auth: { sub: string }, permission: string, scope: Scope = ORG): Promise<boolean> {
  return (await explain(auth.sub, permission, scope)).allowed;
}

// Every permission the user holds at a scope (drives what the app shows).
// Resolves grants and the scope chain once, then checks each permission.
export async function permissionsAt(userId: string, scope: Scope = ORG, all: string[]): Promise<string[]> {
  const [resolved, chain, roles] = await Promise.all([resolve(userId), scopeChain(scope), roleIndex()]);
  const inChain = (s: Scope) => chain.some((c) => sameScope(c, s));
  return all.filter((permission) => {
    if (resolved.overrides.some((o) => o.effect === "deny" && o.permission === permission && inChain(o.scope))) return false;
    if (resolved.overrides.some((o) => o.effect === "grant" && o.permission === permission && inChain(o.scope))) return true;
    return resolved.grants.some((g) => inChain(g.scope) && rolePermits(g.role, permission, roles));
  });
}

export async function grantsFor(userId: string): Promise<Resolved> {
  return resolve(userId);
}

export const scopeOf = (type: ScopeType, id?: string | null): Scope => (type === "organization" ? ORG : { type, id: id ?? null });
