import { Op, type WhereOptions } from "sequelize";
import { Issue, Task, User } from "../../models";
import { serializeWorkItem, workItemInclude } from "../shared/serializers";

// Find ids of tasks/issues assigned to a user (via the M2M join), without
// disturbing the full assignee list we later serialize.
async function assignedIds(userId: string) {
  const filter = {
    attributes: ["id"],
    include: [{ model: User, as: "assignees", attributes: [], where: { id: userId }, through: { attributes: [] } }],
  };
  const [tasks, issues] = await Promise.all([Task.findAll(filter), Issue.findAll(filter)]);
  return { taskIds: tasks.map((t) => t.id), issueIds: issues.map((i) => i.id) };
}

async function loadAndSerialize(taskWhere: WhereOptions, issueWhere: WhereOptions) {
  const [tasks, issues] = await Promise.all([
    Task.findAll({ where: taskWhere, include: workItemInclude, order: [["updatedAt", "DESC"]] }),
    Issue.findAll({ where: issueWhere, include: workItemInclude, order: [["updatedAt", "DESC"]] }),
  ]);
  return [
    ...tasks.map((t) => serializeWorkItem(t, "task")),
    ...issues.map((i) => serializeWorkItem(i, "issue")),
  ];
}

export const meService = {
  // Active items assigned to me (across all projects).
  async assigned(userId: string) {
    const { taskIds, issueIds } = await assignedIds(userId);
    return loadAndSerialize(
      { id: { [Op.in]: taskIds }, status: { [Op.ne]: "done" } },
      { id: { [Op.in]: issueIds }, status: { [Op.ne]: "done" } },
    );
  },

  // Items where someone is waiting on my feedback.
  awaitingFeedback(userId: string) {
    return loadAndSerialize({ feedbackAwaitingFrom: userId }, { feedbackAwaitingFrom: userId });
  },

  // Active items assigned to me with a due date inside the window.
  async dueSoon(userId: string, withinDays = 7) {
    const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);
    const { taskIds, issueIds } = await assignedIds(userId);
    const due = { [Op.ne]: null, [Op.lt]: cutoff };
    return loadAndSerialize(
      { id: { [Op.in]: taskIds }, status: { [Op.ne]: "done" }, dueDate: due },
      { id: { [Op.in]: issueIds }, status: { [Op.ne]: "done" }, dueDate: due },
    );
  },

  // Items I reported.
  reported(userId: string) {
    return loadAndSerialize({ reporterId: userId }, { reporterId: userId });
  },
};
