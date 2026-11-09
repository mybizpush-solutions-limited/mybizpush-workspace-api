import { Op, QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { notFound } from "../../lib/errors";
import { Department, Product, Project, Team, User } from "../../models";
import { mergeGroupMembers, type GroupRef } from "./groups.merge";

// Picking a team, department, product or project and getting the actual people.

const MEMBER_SQL: Record<GroupRef["type"], string> = {
  team: `SELECT user_id FROM team_members WHERE team_id = :id`,
  department: `SELECT user_id FROM department_members WHERE department_id = :id`,
  product: `SELECT user_id FROM product_members WHERE product_id = :id
            UNION SELECT owner_id FROM products WHERE id = :id AND owner_id IS NOT NULL`,
  // A project's people are its manager, its guests and its departments' members.
  project: `SELECT user_id FROM project_members WHERE project_id = :id
            UNION SELECT manager_id FROM projects WHERE id = :id AND manager_id IS NOT NULL
            UNION SELECT dm.user_id FROM department_members dm
                  JOIN project_departments pd ON pd.department_id = dm.department_id WHERE pd.project_id = :id`,
};

async function groupName(ref: GroupRef): Promise<string> {
  const model = { team: Team, department: Department, product: Product, project: Project }[ref.type] as unknown as {
    findByPk: (id: string, o: object) => Promise<{ name: string } | null>;
  };
  const row = await model.findByPk(ref.id, { attributes: ["name"] });
  if (!row) throw notFound(`That ${ref.type} no longer exists`);
  return row.name;
}

export async function memberIdsOf(ref: GroupRef): Promise<string[]> {
  const rows = await sequelize.query<{ user_id: string }>(MEMBER_SQL[ref.type], { replacements: { id: ref.id }, type: QueryTypes.SELECT });
  return rows.map((r) => r.user_id);
}

export interface ExpandedGroups {
  users: { id: string; name: string; avatarUrl: string | null; via: GroupRef[] }[];
  groups: (GroupRef & { name: string; count: number })[];
}

export const groupsService = {
  async expand(refs: GroupRef[], excludeUserIds: string[] = []): Promise<ExpandedGroups> {
    const loaded = await Promise.all(refs.map(async (ref) => ({ ref, name: await groupName(ref), userIds: await memberIdsOf(ref) })));
    const merged = mergeGroupMembers(loaded, excludeUserIds);
    const active = await User.findAll({
      where: { id: { [Op.in]: merged.map((m) => m.userId) }, status: "active" },
      attributes: ["id", "name", "avatarUrl"],
    });
    const byId = new Map(active.map((u) => [u.id, u]));
    const users = merged
      .filter((m) => byId.has(m.userId))
      .map((m) => {
        const u = byId.get(m.userId)!;
        return { id: u.id, name: u.name, avatarUrl: u.avatarUrl ?? null, via: m.via };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const groups = loaded.map((g) => ({ ...g.ref, name: g.name, count: users.filter((u) => u.via.some((v) => v.type === g.ref.type && v.id === g.ref.id)).length }));
    return { users, groups };
  },

  // Just the active people, for callers that apply the result directly.
  async expandIds(refs: GroupRef[], excludeUserIds: string[] = []): Promise<string[]> {
    return (await this.expand(refs, excludeUserIds)).users.map((u) => u.id);
  },
};
