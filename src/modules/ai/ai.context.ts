import { Department, Project, User } from "../../models";
import { unauthorized } from "../../lib/errors";
import type { Auth } from "../../lib/permissions";

// Who the assistant is talking to. Resolved once per request from the access
// token and injected into the system prompt, so the model never has to ask
// "who are you?" and never guesses.
export interface ActorContext {
  auth: Auth;
  id: string;
  name: string;
  email: string;
  accessLevel: string;
  roles: string[];
  departments: { id: string; name: string; isHead: boolean }[];
  projects: { id: string; name: string; isManager: boolean }[];
}

export async function resolveActor(auth: Auth): Promise<ActorContext> {
  const user = await User.findByPk(auth.sub, {
    include: [
      { model: Department, as: "departments", through: { attributes: [] } },
      { model: Project, as: "projects", through: { attributes: [] } },
    ],
  });
  // The token verified but the user is gone (deleted mid-session).
  if (!user) throw unauthorized("Your account no longer exists");

  const departments = ((user.get("departments") as Department[] | undefined) ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    isHead: d.headId === user.id,
  }));

  // `projects` on the user is only the explicit-guest join. Projects reached via
  // a department lane, or managed outright, belong here too — otherwise the
  // assistant would tell a PM they're on no projects.
  const [managed, deptProjects] = await Promise.all([
    Project.findAll({ where: { managerId: user.id }, attributes: ["id", "name"] }),
    departments.length
      ? Project.findAll({
          attributes: ["id", "name", "managerId"],
          include: [
            {
              model: Department,
              as: "departments",
              attributes: [],
              where: { id: departments.map((d) => d.id) },
              through: { attributes: [] },
            },
          ],
        })
      : Promise.resolve([]),
  ]);

  const byId = new Map<string, { id: string; name: string; isManager: boolean }>();
  for (const p of (user.get("projects") as Project[] | undefined) ?? []) {
    byId.set(p.id, { id: p.id, name: p.name, isManager: p.managerId === user.id });
  }
  for (const p of deptProjects) {
    byId.set(p.id, { id: p.id, name: p.name, isManager: p.managerId === user.id });
  }
  for (const p of managed) byId.set(p.id, { id: p.id, name: p.name, isManager: true });

  return {
    auth,
    id: user.id,
    name: user.name,
    email: user.email,
    accessLevel: user.accessLevel,
    roles: user.roles ?? [],
    departments,
    projects: [...byId.values()],
  };
}

// Rendered into the system prompt. Deliberately compact — the roster and the
// full project list are tools, not prompt padding.
export function describeActor(actor: ActorContext, now: Date): string {
  const depts = actor.departments.length
    ? actor.departments.map((d) => `${d.name}${d.isHead ? " (head)" : ""}`).join(", ")
    : "none";
  const projects = actor.projects.length
    ? actor.projects.map((p) => `${p.name}${p.isManager ? " (manager)" : ""} [${p.id}]`).join(", ")
    : "none";

  return (
    `You are speaking with ${actor.name} <${actor.email}>.\n` +
    `Their user id is ${actor.id} — use it whenever a tool needs "me".\n` +
    `Access level: ${actor.accessLevel}. Roles: ${actor.roles.join(", ") || "none"}.\n` +
    `Departments: ${depts}.\n` +
    `Projects: ${projects}.\n` +
    `Current date and time: ${now.toISOString()}.`
  );
}
