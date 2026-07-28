import { forbidden, notFound } from "./errors";
import { Department, Project, isOrgManager } from "../models";

export type Auth = { sub: string; accessLevel: string };

// "Can this person run the project?" — its manager, the head of any department
// working on it, or an org manager (chief / executive admin). This is the gate
// for editing a project and for appointing its blog editors.
export async function canManageProject(projectId: string, auth: Auth): Promise<boolean> {
  if (isOrgManager(auth.accessLevel)) return true;
  const project = await Project.findByPk(projectId, {
    include: [
      { model: Department, as: "departments", attributes: ["headId"], through: { attributes: [] } },
    ],
  });
  if (!project) throw notFound("Project not found");
  if (project.managerId === auth.sub) return true;
  const depts = (project.get("departments") as Department[] | undefined) ?? [];
  return depts.some((d) => d.headId === auth.sub);
}

export async function assertCanManageProject(projectId: string, auth: Auth): Promise<void> {
  if (await canManageProject(projectId, auth)) return;
  throw forbidden("Only the project manager, a department head, or an executive admin can do this");
}
