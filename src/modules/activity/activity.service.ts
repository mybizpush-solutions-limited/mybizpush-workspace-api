import { Op } from "sequelize";
import { Activity, Issue, Project, Task } from "../../models";
import { serializeActivity } from "../shared/serializers";

export const activityService = {
  async forItem(itemId: string) {
    const rows = await Activity.findAll({ where: { itemId }, order: [["createdAt", "DESC"]] });
    return rows.map(serializeActivity);
  },

  async recent(limit = 20) {
    const rows = await Activity.findAll({ order: [["createdAt", "DESC"]], limit });
    return rows.map(serializeActivity);
  },

  // Audit trail for a whole department: every event on items in its projects.
  async forDepartment(departmentId: string, limit = 50) {
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
      where: { itemId: { [Op.in]: itemIds } },
      order: [["createdAt", "DESC"]],
      limit,
    });
    return rows.map(serializeActivity);
  },
};
