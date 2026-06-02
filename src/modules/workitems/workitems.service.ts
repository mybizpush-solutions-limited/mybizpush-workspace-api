import type { ModelStatic } from "sequelize";
import { Comment, Issue, PullRequest, Task, type ItemType } from "../../models";
import { notFound } from "../../lib/errors";
import { fetchPullRequest } from "../../lib/github";
import { serializeWorkItem, workItemInclude } from "../shared/serializers";
import { logActivity, notify } from "../shared/events";

export interface WorkItemCreateInput {
  projectId: string;
  title: string;
  description?: string;
  status?: "todo" | "in_progress" | "in_review" | "blocked" | "done";
  priority?: "low" | "medium" | "high" | "urgent";
  assigneeIds?: string[];
  labelIds?: string[];
  dueDate?: string;
  severity?: "minor" | "major" | "critical"; // issues only
}

export interface WorkItemUpdateInput {
  title?: string;
  description?: string;
  priority?: WorkItemCreateInput["priority"];
  assigneeIds?: string[];
  labelIds?: string[];
  dueDate?: string | null;
  severity?: WorkItemCreateInput["severity"];
}

// Builds an identical service for either tasks or issues. `model` is the
// Sequelize model class; `type` tags the polymorphic rows (comments, activity…).
export function makeWorkItemService(model: ModelStatic<Task> | ModelStatic<Issue>, type: ItemType) {
  // Loosely-typed handle for create/association mixins shared by both models.
  const M = model as any;

  async function reload(id: string) {
    const item = await M.findByPk(id, { include: workItemInclude });
    if (!item) throw notFound(`${type} not found`);
    return serializeWorkItem(item as Task | Issue, type);
  }

  return {
    async list(filter: { projectId?: string; assigneeId?: string } = {}) {
      const where: Record<string, unknown> = {};
      if (filter.projectId) where.projectId = filter.projectId;
      const rows = await M.findAll({
        where,
        include: workItemInclude,
        order: [["createdAt", "DESC"]],
      });
      return (rows as (Task | Issue)[]).map((r) => serializeWorkItem(r, type));
    },

    byId: (id: string) => reload(id),

    async create(input: WorkItemCreateInput, reporterId: string) {
      const item = await M.create({
        projectId: input.projectId,
        title: input.title.trim(),
        description: input.description?.trim() ?? "",
        status: input.status ?? "todo",
        priority: input.priority ?? "medium",
        reporterId,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        ...(type === "issue" ? { severity: input.severity ?? null } : {}),
      });
      if (input.assigneeIds?.length) await item.setAssignees(input.assigneeIds);
      if (input.labelIds?.length) await item.setLabels(input.labelIds);

      await logActivity({ itemId: item.id, itemType: type, actorId: reporterId, kind: "created" });
      for (const uid of input.assigneeIds ?? []) {
        await notify({ userId: uid, fromUserId: reporterId, kind: "assigned", itemId: item.id, itemType: type, message: `Assigned: ${item.title}` });
      }
      return reload(item.id);
    },

    async update(id: string, patch: WorkItemUpdateInput, actorId: string) {
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      await item.update({
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate ? new Date(patch.dueDate) : null } : {}),
        ...(type === "issue" && patch.severity !== undefined ? { severity: patch.severity } : {}),
      });
      if (patch.assigneeIds) {
        const before: string[] = (await item.getAssignees()).map((u: { id: string }) => u.id);
        await item.setAssignees(patch.assigneeIds);
        await logActivity({ itemId: id, itemType: type, actorId, kind: "assigned" });
        // Notify only the newly-added assignees.
        for (const uid of patch.assigneeIds.filter((u) => !before.includes(u))) {
          await notify({ userId: uid, fromUserId: actorId, kind: "assigned", itemId: id, itemType: type, message: `Assigned: ${item.title}` });
        }
      }
      if (patch.labelIds) await item.setLabels(patch.labelIds);
      return reload(id);
    },

    async setStatus(id: string, status: WorkItemCreateInput["status"], actorId: string) {
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      const from = item.status;
      if (from === status) return reload(id);
      await item.update({ status });
      await logActivity({ itemId: id, itemType: type, actorId, kind: "status_changed", data: { from, to: status } });
      if (item.reporterId) {
        await notify({ userId: item.reporterId, fromUserId: actorId, kind: "status_changed", itemId: id, itemType: type, message: `${item.title} moved to ${status}` });
      }
      return reload(id);
    },

    async requestFeedback(id: string, fromUserId: string, actorId: string) {
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      await item.update({ feedbackAwaitingFrom: fromUserId, feedbackRequestedBy: actorId, feedbackRequestedAt: new Date() });
      await logActivity({ itemId: id, itemType: type, actorId, kind: "feedback_requested", data: { from: fromUserId } });
      await notify({ userId: fromUserId, fromUserId: actorId, kind: "feedback_requested", itemId: id, itemType: type, message: `Feedback requested on ${item.title}` });
      return reload(id);
    },

    async provideFeedback(id: string, actorId: string, body: string) {
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      await item.update({ feedbackAwaitingFrom: null, feedbackRequestedBy: null, feedbackRequestedAt: null });
      await Comment.create({ itemId: id, itemType: type, authorId: actorId, body: `**Feedback:** ${body}` });
      await logActivity({ itemId: id, itemType: type, actorId, kind: "feedback_provided" });
      return reload(id);
    },

    async linkPullRequest(id: string, pr: { number: number; title: string; url: string; status?: "open" | "merged" | "closed" | "draft" }, actorId: string) {
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      // Enrich from GitHub when the URL is a real PR (falls back to provided data).
      const gh = await fetchPullRequest(pr.url);
      const created = await PullRequest.create({
        itemId: id,
        itemType: type,
        number: gh?.number ?? pr.number,
        title: gh?.title ?? pr.title,
        url: gh?.url ?? pr.url,
        status: gh?.status ?? pr.status ?? "open",
        authorId: actorId,
      });
      await logActivity({ itemId: id, itemType: type, actorId, kind: "pr_linked", data: { pr: created.id } });
      return reload(id);
    },
  };
}

export const tasksService = makeWorkItemService(Task, "task");
export const issuesService = makeWorkItemService(Issue, "issue");
