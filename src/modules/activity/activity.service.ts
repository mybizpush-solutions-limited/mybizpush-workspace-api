import { Op, type WhereOptions } from "sequelize";
import { notFound } from "../../lib/errors";
import { Activity, Issue, Project, Task } from "../../models";
import { canSeeAnyRecord, viewerFor, visibleItemsWhere } from "../access/visibility";
import { serializeActivity } from "../shared/serializers";

// Activity follows the record it's about (API-CHANGES A1002).
const onVisibleRecords = async (viewerId: string): Promise<WhereOptions> => visibleItemsWhere(await viewerFor(viewerId), '"Activity"') as unknown as WhereOptions;

export const activityService = {
  async forItem(itemId: string, viewerId: string) {
    if (!(await canSeeAnyRecord(viewerId, itemId))) throw notFound("Not found");
    const rows = await Activity.findAll({ where: { itemId }, order: [["createdAt", "DESC"]] });
    return rows.map(serializeActivity);
  },

  async recent(viewerId: string, limit = 20) {
    const rows = await Activity.findAll({ where: await onVisibleRecords(viewerId), order: [["createdAt", "DESC"]], limit });
    return rows.map(serializeActivity);
  },

  // Audit trail for a whole department: every event on items in its projects.
  async forDepartment(departmentId: string, viewerId: string, limit = 50) {
    const projects = await Project.findAll({ where: { departmentId }, attributes: ["id"] });
    const projectIds = projects.map((p) => p.id);
    if (projectIds.length === 0) return [];

    const [tasks, issues] = await Promise.all([
      Task.findAll({ where: { projectId: { [Op.in]: projectIds } }, attributes: ["id"] }),
      Issue.findAll({ where: { projectId: { [Op.in]: projectIds } }, attributes: ["id"] }),
    ]);
    const itemIds = [...tasks.map((t) => t.id), ...issues.map((i) => i.id)];
    if (itemIds.length === 0) return [];

    const rows = await Activity.findAll({
      where: { [Op.and]: [{ itemId: { [Op.in]: itemIds } }, await onVisibleRecords(viewerId)] },
      order: [["createdAt", "DESC"]],
      limit,
    });
    return rows.map(serializeActivity);
  },
};
