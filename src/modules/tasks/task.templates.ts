import { Op, type WhereOptions } from "sequelize";
import { forbidden, notFound } from "../../lib/errors";
import { TaskTemplate, type Priority } from "../../models";
import { can } from "../access/engine";
import { serializeTaskTemplate } from "../shared/serializers";

// Reusable task starting points (API-CHANGES A202, TASK-12).

const scopeOf = (productId: string | null | undefined) => (productId ? { type: "product" as const, id: productId } : { type: "organization" as const, id: null });

async function assertMayManage(userId: string, productId: string | null | undefined): Promise<void> {
  if (!(await can({ sub: userId }, "task.manage_templates", scopeOf(productId)))) {
    throw forbidden("You don't have permission to manage task templates here");
  }
}

interface TemplateInput {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  expectedDeliverable?: string;
  priority?: Priority | null;
  productId?: string | null;
  projectId?: string | null;
  departmentId?: string | null;
  reviewerId?: string | null;
  defaultDueDays?: number | null;
  checklist?: string[];
  labelIds?: string[];
}

export const taskTemplates = {
  async list(q: { productId?: string; projectId?: string; includeArchived?: boolean }) {
    const ands: WhereOptions[] = [];
    if (!q.includeArchived) ands.push({ archivedAt: null });
    // A filter means "for this place": that place, plus organization-wide ones.
    if (q.productId) ands.push({ [Op.or]: [{ productId: q.productId }, { productId: null, projectId: null }] } as WhereOptions);
    if (q.projectId) ands.push({ [Op.or]: [{ projectId: q.projectId }, { projectId: null }] } as WhereOptions);
    const rows = await TaskTemplate.findAll({ where: { [Op.and]: ands }, order: [["name", "ASC"]] });
    return rows.map(serializeTaskTemplate);
  },

  async create(input: TemplateInput & { name: string }, userId: string) {
    await assertMayManage(userId, input.productId);
    const row = await TaskTemplate.create({ ...input, createdBy: userId });
    return serializeTaskTemplate(row);
  },

  async update(id: string, patch: TemplateInput, userId: string) {
    const row = await TaskTemplate.findByPk(id);
    if (!row) throw notFound("Template not found");
    await assertMayManage(userId, row.productId);
    if (patch.productId !== undefined && patch.productId !== row.productId) await assertMayManage(userId, patch.productId);
    await row.update(patch);
    return serializeTaskTemplate(row);
  },

  async archive(id: string, userId: string): Promise<void> {
    const row = await TaskTemplate.findByPk(id);
    if (!row) throw notFound("Template not found");
    await assertMayManage(userId, row.productId);
    await row.update({ archivedAt: new Date() });
  },
};
