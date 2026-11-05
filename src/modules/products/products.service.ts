import { Op } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { forbidden, notFound, badRequest } from "../../lib/errors";
import { uniqueSlug } from "../../lib/slug";
import { isOrgManager, Issue, Product, ProductMember, Project, Task, User, type ProductStage } from "../../models";

// Products: the business umbrella over projects, people, marketing and social
// (API-CHANGES A101). Access checks here are interim (owner or org manager)
// until the permission engine (A103) replaces them.

type Auth = { sub: string; accessLevel: string };

export interface PublicProduct {
  id: string;
  name: string;
  slug: string;
  description: string;
  logoUrl: string | null;
  tint: string | null;
  stage: ProductStage;
  ownerId: string | null;
  projectIds: string[];
  members: { userId: string; title: string | null }[];
  counts: { people: number; projects: number; openTasks: number };
  createdAt: string;
  updatedAt: string;
}

const withRelations = {
  include: [
    { model: Project, as: "projects", attributes: ["id"] },
    { model: User, as: "members", attributes: ["id"], through: { attributes: ["title"] } },
  ],
};

async function openTaskCounts(productIds: string[]): Promise<Map<string, number>> {
  if (!productIds.length) return new Map();
  const rows = (await Task.findAll({
    attributes: [[sequelize.col("Project.product_id"), "productId"], [sequelize.fn("COUNT", sequelize.col("Task.id")), "n"]],
    include: [{ model: Project, attributes: [], where: { productId: { [Op.in]: productIds } } }],
    where: { status: { [Op.ne]: "done" } },
    group: ["Project.product_id"],
    raw: true,
  })) as unknown as { productId: string; n: string }[];
  return new Map(rows.map((r) => [r.productId, Number(r.n)]));
}

function serialize(p: Product, openTasks = 0): PublicProduct {
  const projects = (p.get("projects") as Project[] | undefined) ?? [];
  const members = (p.get("members") as (User & { ProductMember?: { title: string | null } })[] | undefined) ?? [];
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    logoUrl: p.logoUrl ?? null,
    tint: p.tint ?? null,
    stage: p.stage,
    ownerId: p.ownerId ?? null,
    projectIds: projects.map((x) => x.id),
    members: members.map((m) => ({ userId: m.id, title: m.ProductMember?.title ?? null })),
    counts: { people: members.length, projects: projects.length, openTasks },
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

async function load(id: string): Promise<Product> {
  const p = await Product.findByPk(id, withRelations);
  if (!p) throw notFound("Product not found");
  return p;
}

export async function canManageProduct(productId: string, auth: Auth): Promise<boolean> {
  if (isOrgManager(auth.accessLevel)) return true;
  const p = await Product.findByPk(productId, { attributes: ["ownerId"] });
  if (!p) throw notFound("Product not found");
  return p.ownerId === auth.sub;
}

async function assertCanManage(productId: string, auth: Auth): Promise<void> {
  if (!(await canManageProduct(productId, auth))) throw forbidden("Only the product owner or an executive can change this product");
}

// Bumps updated_at so offline clients pick up membership and project changes.
async function touch(id: string): Promise<void> {
  const p = await Product.findByPk(id);
  if (!p) return;
  p.changed("updatedAt", true);
  await p.save();
}

export const productsService = {
  async list(): Promise<PublicProduct[]> {
    const rows = await Product.findAll({ ...withRelations, order: [["name", "ASC"]] });
    const open = await openTaskCounts(rows.map((r) => r.id));
    return rows.map((r) => serialize(r, open.get(r.id) ?? 0));
  },

  async byId(id: string): Promise<PublicProduct> {
    const p = await load(id);
    const open = await openTaskCounts([id]);
    return serialize(p, open.get(id) ?? 0);
  },

  // Products the user belongs to (member, owner, or via a project they're on).
  async forUser(userId: string): Promise<PublicProduct[]> {
    const memberOf = await ProductMember.findAll({ where: { userId }, attributes: ["productId"] });
    const owned = await Product.findAll({ where: { ownerId: userId }, attributes: ["id"] });
    const ids = new Set([...memberOf.map((m) => m.productId), ...owned.map((p) => p.id)]);
    if (!ids.size) return [];
    const rows = await Product.findAll({ where: { id: [...ids] }, ...withRelations, order: [["name", "ASC"]] });
    const open = await openTaskCounts(rows.map((r) => r.id));
    return rows.map((r) => serialize(r, open.get(r.id) ?? 0));
  },

  async create(
    input: { name: string; description?: string; stage?: ProductStage; ownerId?: string; tint?: string; projectIds?: string[] },
    auth: Auth,
  ): Promise<PublicProduct> {
    if (!isOrgManager(auth.accessLevel)) throw forbidden("Only executives can create products");
    const ownerId = input.ownerId ?? auth.sub;
    const product = await sequelize.transaction(async (transaction) => {
      const p = await Product.create(
        {
          name: input.name.trim(),
          slug: await uniqueSlug(Product, input.name),
          description: input.description?.trim() ?? "",
          stage: input.stage ?? "in_development",
          ownerId,
          tint: input.tint ?? null,
        },
        { transaction },
      );
      await ProductMember.create({ productId: p.id, userId: ownerId, title: "Owner" }, { transaction });
      if (input.projectIds?.length) {
        await Project.update({ productId: p.id }, { where: { id: input.projectIds, productId: { [Op.is]: null } }, transaction });
      }
      return p;
    });
    return this.byId(product.id);
  },

  async update(
    id: string,
    patch: { name?: string; description?: string; stage?: ProductStage; ownerId?: string; tint?: string | null; logoUrl?: string | null },
    auth: Auth,
  ): Promise<{ before: PublicProduct; after: PublicProduct }> {
    await assertCanManage(id, auth);
    const before = await this.byId(id);
    const p = await Product.findByPk(id);
    if (!p) throw notFound("Product not found");
    if (patch.name !== undefined) {
      p.name = patch.name.trim();
      p.slug = await uniqueSlug(Product, patch.name, id);
    }
    if (patch.description !== undefined) p.description = patch.description.trim();
    if (patch.stage !== undefined) p.stage = patch.stage;
    if (patch.tint !== undefined) p.tint = patch.tint;
    if (patch.logoUrl !== undefined) p.logoUrl = patch.logoUrl;
    if (patch.ownerId !== undefined) {
      p.ownerId = patch.ownerId;
      await ProductMember.findOrCreate({ where: { productId: id, userId: patch.ownerId }, defaults: { productId: id, userId: patch.ownerId, title: "Owner" } });
    }
    await p.save();
    return { before, after: await this.byId(id) };
  },

  async linkProjects(id: string, projectIds: string[], auth: Auth): Promise<PublicProduct> {
    await assertCanManage(id, auth);
    const taken = await Project.findAll({ where: { id: projectIds, productId: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: id }] } }, attributes: ["name"] });
    if (taken.length) throw badRequest(`Already in another product: ${taken.map((t) => t.name).join(", ")}`);
    await Project.update({ productId: id }, { where: { id: projectIds } });
    await touch(id);
    return this.byId(id);
  },

  async unlinkProject(id: string, projectId: string, auth: Auth): Promise<PublicProduct> {
    await assertCanManage(id, auth);
    await Project.update({ productId: null }, { where: { id: projectId, productId: id } });
    await touch(id);
    return this.byId(id);
  },

  async addMembers(id: string, members: { userId: string; title?: string }[], auth: Auth): Promise<PublicProduct> {
    await assertCanManage(id, auth);
    for (const m of members) {
      const [row, created] = await ProductMember.findOrCreate({
        where: { productId: id, userId: m.userId },
        defaults: { productId: id, userId: m.userId, title: m.title ?? null },
      });
      if (!created && m.title !== undefined) await row.update({ title: m.title });
    }
    await touch(id);
    return this.byId(id);
  },

  async removeMember(id: string, userId: string, auth: Auth): Promise<PublicProduct> {
    await assertCanManage(id, auth);
    const p = await Product.findByPk(id, { attributes: ["ownerId"] });
    if (p?.ownerId === userId) throw badRequest("Choose a new owner before removing this person");
    await ProductMember.destroy({ where: { productId: id, userId } });
    await touch(id);
    return this.byId(id);
  },

  // Work in this product, for the product overview (PRD-02).
  async summary(id: string): Promise<{ openTasks: number; overdue: number; openIssues: number }> {
    const projectIds = (await Project.findAll({ where: { productId: id }, attributes: ["id"] })).map((p) => p.id);
    if (!projectIds.length) return { openTasks: 0, overdue: 0, openIssues: 0 };
    const [openTasks, overdue, openIssues] = await Promise.all([
      Task.count({ where: { projectId: projectIds, status: { [Op.ne]: "done" } } }),
      Task.count({ where: { projectId: projectIds, status: { [Op.ne]: "done" }, dueDate: { [Op.lt]: new Date() } } }),
      Issue.count({ where: { projectId: projectIds, status: { [Op.ne]: "done" } } }),
    ]);
    return { openTasks, overdue, openIssues };
  },
};
