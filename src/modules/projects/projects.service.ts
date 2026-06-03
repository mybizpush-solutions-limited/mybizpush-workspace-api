import { Department, Project, User } from "../../models";
import { notFound } from "../../lib/errors";
import { env } from "../../config/env";
import { uploadAvatarImage, type UploadFile } from "../../lib/avatar";
import { serializeProject } from "../shared/serializers";

// People on a project are derived from its involved departments' members, so we
// load departments → their members.
const withDepartments = {
  include: [
    {
      model: Department,
      as: "departments",
      attributes: ["id"],
      through: { attributes: [] },
      include: [{ model: User, as: "members", attributes: ["id"], through: { attributes: [] } }],
    },
  ],
};

async function reload(id: string) {
  const project = await Project.findByPk(id, withDepartments);
  if (!project) throw notFound("Project not found");
  return serializeProject(project);
}

export const projectsService = {
  async list(departmentId?: string) {
    // ?departmentId= filters to projects that department works on (the join).
    if (departmentId) {
      const dept = await Department.findByPk(departmentId, {
        include: [{ model: Project, as: "workingProjects", through: { attributes: [] } }],
      });
      const ids = ((dept?.get("workingProjects") as Project[] | undefined) ?? []).map((p) => p.id);
      if (!ids.length) return [];
      const rows = await Project.findAll({ where: { id: ids }, ...withDepartments, order: [["createdAt", "DESC"]] });
      return rows.map(serializeProject);
    }
    const rows = await Project.findAll({ ...withDepartments, order: [["createdAt", "DESC"]] });
    return rows.map(serializeProject);
  },

  byId: (id: string) => reload(id),

  async create(input: {
    name: string;
    description?: string;
    managerId?: string;
    departmentIds?: string[];
  }) {
    const project = await Project.create({
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      managerId: input.managerId ?? null,
    });
    if (input.departmentIds?.length) await (project as any).setDepartments(input.departmentIds);
    return reload(project.id);
  },

  async update(id: string, patch: { name?: string; description?: string; managerId?: string; progress?: number }) {
    const project = await Project.findByPk(id);
    if (!project) throw notFound("Project not found");
    await project.update({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.managerId !== undefined ? { managerId: patch.managerId } : {}),
      ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
    });
    return reload(id);
  },

  // Add / remove a department "lane" on a project.
  async addDepartment(id: string, departmentId: string) {
    const project = await Project.findByPk(id);
    if (!project) throw notFound("Project not found");
    const dept = await Department.findByPk(departmentId);
    if (!dept) throw notFound("Department not found");
    await (project as any).addDepartment(departmentId);
    return reload(id);
  },

  async removeDepartment(id: string, departmentId: string) {
    const project = await Project.findByPk(id);
    if (!project) throw notFound("Project not found");
    await (project as any).removeDepartment(departmentId);
    return reload(id);
  },

  async setAvatar(id: string, file: UploadFile) {
    const project = await Project.findByPk(id);
    if (!project) throw notFound("Project not found");
    project.avatarUrl = await uploadAvatarImage(file, {
      folder: `${env.CLOUDINARY_UPLOAD_FOLDER}/projects`,
      publicId: id,
      tags: ["project", id],
    });
    await project.save();
    return reload(id);
  },
};
