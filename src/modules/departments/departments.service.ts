import { Department, User, type AccessLevel } from "../../models";
import { notFound, forbidden } from "../../lib/errors";

export interface PublicDepartment {
  id: string;
  slug: string;
  name: string;
  description: string;
  headId: string | null;
  memberIds: string[];
}

// Who's asking — drives department visibility. Only executive admins may see
// departments they don't belong to; everyone else is scoped to their own.
export interface Viewer {
  id: string;
  accessLevel: AccessLevel;
}

function canSee(dept: PublicDepartment, viewer: Viewer): boolean {
  return viewer.accessLevel === "executive_admin" || dept.memberIds.includes(viewer.id);
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
  // Executive admins see every department; everyone else only their own.
  async list(viewer: Viewer): Promise<PublicDepartment[]> {
    const rows = await Department.findAll({ ...withMembers, order: [["name", "ASC"]] });
    return rows.map(serialize).filter((d) => canSee(d, viewer));
  },

  async bySlug(slug: string, viewer?: Viewer): Promise<PublicDepartment> {
    const dept = await Department.findOne({ where: { slug }, ...withMembers });
    if (!dept) throw notFound("Department not found");
    const pub = serialize(dept);
    if (viewer && !canSee(pub, viewer)) {
      throw forbidden("You don't have access to this department");
    }
    return pub;
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
