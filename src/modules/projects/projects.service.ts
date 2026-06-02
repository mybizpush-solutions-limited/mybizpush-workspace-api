import { Project, User } from "../../models";
import { notFound } from "../../lib/errors";
import { serializeProject } from "../shared/serializers";

const withMembers = {
  include: [{ model: User, as: "members", attributes: ["id"], through: { attributes: [] } }],
};

async function reload(id: string) {
  const project = await Project.findByPk(id, withMembers);
  if (!project) throw notFound("Project not found");
  return serializeProject(project);
}

export const projectsService = {
  async list(departmentId?: string) {
    const rows = await Project.findAll({
      ...withMembers,
      where: departmentId ? { departmentId } : undefined,
      order: [["createdAt", "DESC"]],
    });
    return rows.map(serializeProject);
  },

  byId: (id: string) => reload(id),

  async create(input: {
    departmentId: string;
    name: string;
    description?: string;
    managerId?: string;
    memberIds?: string[];
  }) {
    const project = await Project.create({
      departmentId: input.departmentId,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      managerId: input.managerId ?? null,
    });
    const members = new Set(input.memberIds ?? []);
    if (input.managerId) members.add(input.managerId);
    if (members.size) await (project as any).setMembers([...members]);
    return reload(project.id);
  },

  async update(id: string, patch: { name?: string; description?: string; managerId?: string; progress?: number; memberIds?: string[] }) {
    const project = await Project.findByPk(id);
    if (!project) throw notFound("Project not found");
    await project.update({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.managerId !== undefined ? { managerId: patch.managerId } : {}),
      ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
    });
    if (patch.memberIds) await (project as any).setMembers(patch.memberIds);
    return reload(id);
  },
};
