import { Department, User } from "../../models";
import { notFound } from "../../lib/errors";

export interface PublicDepartment {
  id: string;
  slug: string;
  name: string;
  description: string;
  headId: string | null;
  memberIds: string[];
}

function serialize(dept: Department): PublicDepartment {
  const members = (dept.get("members") as User[] | undefined) ?? [];
  return {
    id: dept.id,
    slug: dept.slug,
    name: dept.name,
    description: dept.description,
    headId: dept.headId ?? null,
    memberIds: members.map((m) => m.id),
  };
}

const withMembers = {
  include: [{ model: User, as: "members", attributes: ["id"], through: { attributes: [] } }],
};

export const departmentsService = {
  async list(): Promise<PublicDepartment[]> {
    const rows = await Department.findAll({ ...withMembers, order: [["name", "ASC"]] });
    return rows.map(serialize);
  },

  async bySlug(slug: string): Promise<PublicDepartment> {
    const dept = await Department.findOne({ where: { slug }, ...withMembers });
    if (!dept) throw notFound("Department not found");
    return serialize(dept);
  },

  async create(input: { name: string; description?: string; headId?: string | null }): Promise<PublicDepartment> {
    const slug = input.name.trim().toLowerCase().replace(/\s+/g, "-");
    const dept = await Department.create({
      slug,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      headId: input.headId ?? null,
    });
    // The head is also a member by default.
    if (input.headId) await (dept as any).addMember(input.headId);
    return this.bySlug(dept.slug);
  },

  async update(
    id: string,
    patch: { name?: string; description?: string; headId?: string | null },
  ): Promise<PublicDepartment> {
    const dept = await Department.findByPk(id);
    if (!dept) throw notFound("Department not found");
    await dept.update({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.headId !== undefined ? { headId: patch.headId } : {}),
    });
    // Keep a newly-assigned head in the member list.
    if (patch.headId) await (dept as any).addMember(patch.headId);
    return this.bySlug(dept.slug);
  },
};
