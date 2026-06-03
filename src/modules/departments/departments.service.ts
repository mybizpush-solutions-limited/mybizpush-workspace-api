import { Department, DepartmentJoinRequest, User, type AccessLevel } from "../../models";
import { badRequest, notFound, forbidden } from "../../lib/errors";
import { env } from "../../config/env";
import { uploadAvatarImage, type UploadFile } from "../../lib/avatar";

// A user can manage a department if they're its head or an executive admin.
function canManage(dept: Department, viewer: Viewer): boolean {
  return viewer.accessLevel === "executive_admin" || dept.headId === viewer.id;
}

function serializeRequest(r: DepartmentJoinRequest) {
  const u = r.get("user") as User | undefined;
  return {
    id: r.id,
    userId: r.userId,
    departmentId: r.departmentId,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    user: u ? { id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl ?? null } : null,
  };
}

export interface PublicDepartment {
  id: string;
  slug: string;
  name: string;
  description: string;
  headId: string | null;
  avatarUrl: string | null;
  memberIds: string[];
}

// Who's asking — drives department visibility. Only executive admins may see
// departments they don't belong to; everyone else is scoped to their own.
export interface Viewer {
  id: string;
  accessLevel: AccessLevel;
}

function serialize(dept: Department): PublicDepartment {
  const members = (dept.get("members") as User[] | undefined) ?? [];
  return {
    id: dept.id,
    slug: dept.slug,
    name: dept.name,
    description: dept.description,
    headId: dept.headId ?? null,
    avatarUrl: dept.avatarUrl ?? null,
    memberIds: members.map((m) => m.id),
  };
}

const withMembers = {
  include: [{ model: User, as: "members", attributes: ["id"], through: { attributes: [] } }],
};

export const departmentsService = {
  // Every department is visible to everyone (the directory). Access to a
  // department's *contents* is enforced per-page in the UI; non-members get a
  // limited view with a "request to join" action.
  async list(): Promise<PublicDepartment[]> {
    const rows = await Department.findAll({ ...withMembers, order: [["name", "ASC"]] });
    return rows.map(serialize);
  },

  // A name-only directory of every department — used so anyone can pick a
  // department to join (onboarding) or request to join, without exposing the
  // member lists / contents that the visibility rule guards.
  async directory(): Promise<Array<{ id: string; slug: string; name: string; description: string; headId: string | null }>> {
    const rows = await Department.findAll({ order: [["name", "ASC"]] });
    return rows.map((d) => ({ id: d.id, slug: d.slug, name: d.name, description: d.description, headId: d.headId ?? null }));
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

  // ---- Join requests -------------------------------------------------------
  // A user asks to join a department; a head/exec admin approves or rejects.
  async requestToJoin(userId: string, departmentId: string) {
    const dept = await Department.findByPk(departmentId);
    if (!dept) throw notFound("Department not found");
    if (await (dept as any).hasMember(userId)) throw badRequest("You're already in this department");
    const pending = await DepartmentJoinRequest.findOne({
      where: { userId, departmentId, status: "pending" },
    });
    if (pending) return serializeRequest(pending);
    const created = await DepartmentJoinRequest.create({ userId, departmentId });
    return serializeRequest(created);
  },

  // The caller's own requests (with department names), newest first.
  async myRequests(userId: string) {
    const rows = await DepartmentJoinRequest.findAll({
      where: { userId },
      include: [{ model: Department, as: "department", attributes: ["id", "name"] }],
      order: [["createdAt", "DESC"]],
    });
    return rows.map((r) => ({
      id: r.id,
      departmentId: r.departmentId,
      departmentName: (r.get("department") as Department | undefined)?.name ?? null,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  },

  // Pending requests for a department (head / exec admin only).
  async listRequests(departmentId: string, viewer: Viewer) {
    const dept = await Department.findByPk(departmentId);
    if (!dept) throw notFound("Department not found");
    if (!canManage(dept, viewer)) throw forbidden("Only the department head or an admin can do this");
    const rows = await DepartmentJoinRequest.findAll({
      where: { departmentId, status: "pending" },
      include: [{ model: User, as: "user", attributes: ["id", "name", "email", "avatarUrl"] }],
      order: [["createdAt", "ASC"]],
    });
    return rows.map(serializeRequest);
  },

  async decideRequest(requestId: string, approve: boolean, viewer: Viewer) {
    const req = await DepartmentJoinRequest.findByPk(requestId);
    if (!req) throw notFound("Request not found");
    const dept = await Department.findByPk(req.departmentId);
    if (!dept) throw notFound("Department not found");
    if (!canManage(dept, viewer)) throw forbidden("Only the department head or an admin can do this");
    if (req.status !== "pending") throw badRequest("This request was already decided");

    if (approve) await (dept as any).addMember(req.userId);
    await req.update({ status: approve ? "approved" : "rejected", decidedBy: viewer.id, decidedAt: new Date() });
    return { id: req.id, status: req.status };
  },

  // Directly add a member (head / exec admin) — resolves any pending request.
  async addMember(departmentId: string, userId: string, viewer: Viewer) {
    const dept = await Department.findByPk(departmentId);
    if (!dept) throw notFound("Department not found");
    if (!canManage(dept, viewer)) throw forbidden("Only the department head or an admin can do this");
    const user = await User.findByPk(userId);
    if (!user) throw notFound("User not found");
    await (dept as any).addMember(userId);
    await DepartmentJoinRequest.update(
      { status: "approved", decidedBy: viewer.id, decidedAt: new Date() },
      { where: { departmentId, userId, status: "pending" } },
    );
    return this.bySlug(dept.slug);
  },

  async setAvatar(departmentId: string, file: UploadFile, viewer: Viewer) {
    const dept = await Department.findByPk(departmentId);
    if (!dept) throw notFound("Department not found");
    if (!canManage(dept, viewer)) throw forbidden("Only the department head or an admin can do this");
    dept.avatarUrl = await uploadAvatarImage(file, {
      folder: `${env.CLOUDINARY_UPLOAD_FOLDER}/departments`,
      publicId: departmentId,
      tags: ["department", departmentId],
    });
    await dept.save();
    return this.bySlug(dept.slug);
  },
};
