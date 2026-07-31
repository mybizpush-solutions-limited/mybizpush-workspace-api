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

// Managing database credentials and backups is deliberately NOT a project-level
// capability. A project manager or department head can run their project
// without ever holding the keys to its production data, so this gate is on
// access level alone: admins, chiefs and executive admins. Ordinary members are
// excluded even on projects they manage.
export function canManageDatabases(auth: Auth): boolean {
  return auth.accessLevel === "admin" || isOrgManager(auth.accessLevel);
}

export function assertCanManageDatabases(auth: Auth): void {
  if (canManageDatabases(auth)) return;
  throw forbidden("Only an admin, chief, or executive admin can manage databases");
}

// The same rule as canManageProject, answered for every project at once. Use
// this instead of calling canManageProject in a loop — that costs one query per
// project. Returns "all" for org managers, who can manage everything.
export async function manageableProjectIds(auth: Auth): Promise<Set<string> | "all"> {
  if (isOrgManager(auth.accessLevel)) return "all";
  const projects = await Project.findAll({
    attributes: ["id", "managerId"],
    include: [
      { model: Department, as: "departments", attributes: ["headId"], through: { attributes: [] } },
    ],
  });
  const ids = new Set<string>();
  for (const project of projects) {
    const depts = (project.get("departments") as Department[] | undefined) ?? [];
    if (project.managerId === auth.sub || depts.some((d) => d.headId === auth.sub)) {
      ids.add(project.id);
    }
  }
  return ids;
}
