import { Router } from "express";
import { z } from "zod";
import { sequelize } from "../../db/sequelize";
import { asyncHandler, forbidden, notFound } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { uniqueSlug } from "../../lib/slug";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { isOrgManager, Project, Team, User } from "../../models";

// Teams: cross-department working groups (API-CHANGES A102). Interim access:
// org managers create; the lead or an org manager edits. Replaced by the
// permission engine (A103).
export const teamsRouter = Router();
teamsRouter.use(requireAuth);

const withRelations = {
  include: [
    { model: User, as: "members", attributes: ["id"], through: { attributes: [] } },
    { model: Project, as: "projects", attributes: ["id"], through: { attributes: [] } },
  ],
};

function serialize(t: Team) {
  const members = (t.get("members") as User[] | undefined) ?? [];
  const projects = (t.get("projects") as Project[] | undefined) ?? [];
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    description: t.description,
    leadId: t.leadId ?? null,
    memberIds: members.map((m) => m.id),
    projectIds: projects.map((p) => p.id),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

async function load(id: string): Promise<Team> {
  const t = await Team.findByPk(id, withRelations);
  if (!t) throw notFound("Team not found");
  return t;
}

function assertCanEdit(t: Team, auth: { sub: string; accessLevel: string }) {
  if (isOrgManager(auth.accessLevel) || t.leadId === auth.sub) return;
  throw forbidden("Only the team lead or an executive can change this team");
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).optional(),
  leadId: z.string().uuid().optional(),
  memberIds: z.array(z.string().uuid()).max(200).optional(),
  projectIds: z.array(z.string().uuid()).max(100).optional(),
});
const updateSchema = createSchema.partial();

teamsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await Team.findAll({ ...withRelations, order: [["name", "ASC"]] });
    res.json({ teams: rows.map(serialize) });
  }),
);

teamsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ team: serialize(await load(req.params.id!)) });
  }),
);

teamsRouter.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    if (!isOrgManager(req.auth!.accessLevel)) throw forbidden("Only executives can create teams");
    const body = req.body as z.infer<typeof createSchema>;
    const id = await sequelize.transaction(async (transaction) => {
      const t = await Team.create(
        { name: body.name, slug: await uniqueSlug(Team, body.name), description: body.description ?? "", leadId: body.leadId ?? null },
        { transaction },
      );
      const memberIds = new Set(body.memberIds ?? []);
      if (body.leadId) memberIds.add(body.leadId);
      const mixins = t as unknown as { setMembers: (ids: string[], o: object) => Promise<void>; setProjects: (ids: string[], o: object) => Promise<void> };
      if (memberIds.size) await mixins.setMembers([...memberIds], { transaction });
      if (body.projectIds?.length) await mixins.setProjects(body.projectIds, { transaction });
      return t.id;
    });
    const team = serialize(await load(id));
    await audit({ req, action: "team.create", target: { type: "team", id }, after: { name: team.name, leadId: team.leadId, memberIds: team.memberIds } });
    res.status(201).json({ team });
  }),
);

teamsRouter.patch(
  "/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const t = await load(req.params.id!);
    assertCanEdit(t, req.auth!);
    const before = serialize(t);
    const body = req.body as z.infer<typeof updateSchema>;
    if (body.name !== undefined) {
      t.name = body.name;
      t.slug = await uniqueSlug(Team, body.name, t.id);
    }
    if (body.description !== undefined) t.description = body.description;
    if (body.leadId !== undefined) t.leadId = body.leadId;
    t.changed("updatedAt", true);
    await t.save();
    const mixins = t as unknown as { setMembers: (ids: string[]) => Promise<void>; setProjects: (ids: string[]) => Promise<void> };
    if (body.memberIds) await mixins.setMembers([...new Set([...body.memberIds, ...(t.leadId ? [t.leadId] : [])])]);
    if (body.projectIds) await mixins.setProjects(body.projectIds);
    const after = serialize(await load(t.id));
    await audit({
      req,
      action: "team.update",
      target: { type: "team", id: t.id },
      before: { name: before.name, leadId: before.leadId, memberIds: before.memberIds, projectIds: before.projectIds },
      after: { name: after.name, leadId: after.leadId, memberIds: after.memberIds, projectIds: after.projectIds },
    });
    res.json({ team: after });
  }),
);

teamsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!isOrgManager(req.auth!.accessLevel)) throw forbidden("Only executives can delete teams");
    const t = await load(req.params.id!);
    await audit({ req, action: "team.delete", target: { type: "team", id: t.id }, before: { name: t.name } });
    await t.destroy();
    res.status(204).end();
  }),
);
