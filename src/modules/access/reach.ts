import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { Project } from "../../models";
import { can, grantsFor, roleIndex } from "./engine";

// "Where does this person hold this permission?" (A504). can() answers for one
// scope; list screens and reports need the whole set of places to filter by.

export interface Reach {
  organization: boolean;
  products: string[];
  departments: string[];
  teams: string[];
  projects: string[];
  hasScopedDeny: boolean; // scoped denials need a per-project check
}

export async function reachFor(userId: string, permission: string): Promise<Reach> {
  const [{ grants, overrides }, roles] = await Promise.all([grantsFor(userId), roleIndex()]);
  const permits = (key: string) => {
    const r = roles.byKey.get(key);
    return !!r && (r.permissions.includes("*") || r.permissions.includes(permission));
  };
  const reach: Reach = { organization: false, products: [], departments: [], teams: [], projects: [], hasScopedDeny: false };
  const relevant = overrides.filter((o) => o.permission === permission);

  if (relevant.some((o) => o.effect === "deny" && o.scope.type === "organization")) return reach;
  reach.hasScopedDeny = relevant.some((o) => o.effect === "deny");

  const scopes = [...grants.filter((g) => permits(g.role)).map((g) => g.scope), ...relevant.filter((o) => o.effect === "grant").map((o) => o.scope)];
  for (const s of scopes) {
    if (s.type === "organization") reach.organization = true;
    else if (s.id) {
      const list = { product: reach.products, department: reach.departments, team: reach.teams, project: reach.projects }[s.type];
      if (!list.includes(s.id)) list.push(s.id);
    }
  }
  return reach;
}

export const reachIsEmpty = (r: Reach) => !r.organization && !r.products.length && !r.departments.length && !r.teams.length && !r.projects.length;

// The projects a reach covers: "all", or a list of ids.
export async function projectsInReach(userId: string, permission: string, reach: Reach): Promise<"all" | string[]> {
  if (reach.organization && !reach.hasScopedDeny) return "all";
  const ids = new Set<string>(reach.projects);
  if (reach.organization) (await Project.findAll({ attributes: ["id"] })).forEach((p) => ids.add(p.id));
  if (reach.products.length) (await Project.findAll({ where: { productId: reach.products }, attributes: ["id"] })).forEach((p) => ids.add(p.id));
  if (reach.departments.length) {
    const rows = await sequelize.query<{ id: string }>(
      `SELECT project_id AS id FROM project_departments WHERE department_id IN (:ids)
       UNION SELECT id FROM projects WHERE department_id IN (:ids)`,
      { replacements: { ids: reach.departments }, type: QueryTypes.SELECT },
    );
    rows.forEach((r) => ids.add(r.id));
  }
  if (reach.teams.length) {
    const rows = await sequelize.query<{ project_id: string }>(`SELECT project_id FROM team_projects WHERE team_id IN (:ids)`, {
      replacements: { ids: reach.teams },
      type: QueryTypes.SELECT,
    });
    rows.forEach((r) => ids.add(r.project_id));
  }
  if (!reach.hasScopedDeny) return [...ids];
  // A denial somewhere up a project's chain wins, so ask the engine per project.
  const allowed = await Promise.all([...ids].map(async (id) => ((await can({ sub: userId }, permission, { type: "project", id })) ? id : null)));
  return allowed.filter((x): x is string => !!x);
}

// Does this person hold a permission over someone: organization wide, or on a
// group they belong to? Limit `kinds` where only some groups should count.
export async function canOverUser(viewerId: string, permission: string, staffId: string, kinds: ("department" | "team" | "product" | "project")[] = ["department", "team", "product", "project"]): Promise<boolean> {
  if (await can({ sub: viewerId }, permission)) return true;
  const reach = await reachFor(viewerId, permission);
  const uses = (k: (typeof kinds)[number], list: string[]) => kinds.includes(k) && list.length > 0;
  const checks: [string, string[]][] = [];
  if (uses("department", reach.departments)) checks.push([`SELECT 1 FROM department_members WHERE user_id = :staffId AND department_id IN (:ids)`, reach.departments]);
  if (uses("team", reach.teams)) checks.push([`SELECT 1 FROM team_members WHERE user_id = :staffId AND team_id IN (:ids)`, reach.teams]);
  if (uses("product", reach.products)) checks.push([`SELECT 1 FROM product_members WHERE user_id = :staffId AND product_id IN (:ids)`, reach.products]);
  if (uses("project", reach.projects)) {
    checks.push([
      `SELECT 1 FROM project_members WHERE user_id = :staffId AND project_id IN (:ids)
       UNION SELECT 1 FROM projects WHERE manager_id = :staffId AND id IN (:ids)
       UNION SELECT 1 FROM department_members dm JOIN project_departments pd ON pd.department_id = dm.department_id WHERE dm.user_id = :staffId AND pd.project_id IN (:ids)`,
      reach.projects,
    ]);
  }
  for (const [sql, ids] of checks) {
    const rows = await sequelize.query(sql, { replacements: { staffId, ids }, type: QueryTypes.SELECT });
    if (rows.length) return true;
  }
  return false;
}

export async function projectsWith(userId: string, permission: string): Promise<"all" | string[]> {
  return projectsInReach(userId, permission, await reachFor(userId, permission));
}
