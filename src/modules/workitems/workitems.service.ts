import type { ModelStatic } from "sequelize";
import {
  Comment,
  DocumentationLink,
  GithubIssueLink,
  Issue,
  PullRequest,
  Task,
  type ItemType,
  type TaskStatus,
} from "../../models";
import { notFound } from "../../lib/errors";
import { fetchPullRequest } from "../../lib/github";
import { setIssueState } from "../../lib/github.features";
import { githubService } from "../github/github.service";
import { serializeWorkItem, taskInclude, workItemInclude } from "../shared/serializers";
import { taskHooks, type TaskCreateExtras } from "../tasks/tasks.service";
import { logActivity, notify } from "../shared/events";
import { assertCanSeeRecord, viewerFor, visibleIds } from "../access/visibility";

export interface WorkItemCreateInput extends TaskCreateExtras {
  // Client-generated id (offline-created items keep the id they were given on
  // the device). Omitted by the web app: the database generates one.
  id?: string;
  projectId: string;
  departmentId?: string | null; // the department "lane" within the project
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: "low" | "medium" | "high" | "urgent";
  assigneeIds?: string[];
  labelIds?: string[];
  dueDate?: string;
  severity?: "minor" | "major" | "critical"; // issues only
}

export interface WorkItemUpdateInput extends Omit<TaskCreateExtras, "templateId" | "sourceType" | "sourceId"> {
  title?: string;
  description?: string;
  departmentId?: string | null;
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
  const itemInclude = type === "task" ? taskInclude : workItemInclude;

  async function reload(id: string) {
    const item = await M.findByPk(id, { include: itemInclude });
    if (!item) throw notFound(`${type} not found`);
    return serializeWorkItem(item as Task | Issue, type);
  }

  return {
    // Every caller says who is asking. Only what concerns them comes back.
    async list(viewerId: string, filter: { projectId?: string; departmentId?: string; assigneeId?: string } = {}) {
      const where: Record<string, unknown> = { id: visibleIds(await viewerFor(viewerId), type) };
      if (filter.projectId) where.projectId = filter.projectId;
      if (filter.departmentId) where.departmentId = filter.departmentId;
      const rows = await M.findAll({
        where,
        include: itemInclude,
        order: [["createdAt", "DESC"]],
      });
      return (rows as (Task | Issue)[]).map((r) => serializeWorkItem(r, type));
    },

    // For internal use, such as the GitHub sync. People go through view().
    byId: (id: string) => reload(id),

    async view(id: string, viewerId: string) {
      await assertCanSeeRecord(viewerId, type, id);
      return reload(id);
    },

    // strict: enforce task.assign when assigning other people (mobile and sync).
    async create(input: WorkItemCreateInput, reporterId: string, opts: { strict?: boolean } = {}) {
      const prepared = type === "task" ? await taskHooks.prepareCreate(input, reporterId, !!opts.strict) : null;
      const assigneeIds = prepared?.assigneeIds ?? input.assigneeIds ?? [];
      const labelIds = prepared?.labelIds ?? input.labelIds ?? [];
      const item = await M.create({
        ...(input.id ? { id: input.id } : {}),
        projectId: input.projectId,
        departmentId: prepared?.departmentId ?? input.departmentId ?? null,
        title: input.title.trim(),
        description: (prepared?.description ?? input.description)?.trim() ?? "",
        status: input.status ?? "todo",
        priority: prepared?.priority ?? input.priority ?? "medium",
        reporterId,
        dueDate: prepared ? prepared.dueDate : input.dueDate ? new Date(input.dueDate) : null,
        ...(prepared?.columns ?? {}),
        ...(type === "issue" ? { severity: input.severity ?? null } : {}),
      });
      if (assigneeIds.length) await item.setAssignees(assigneeIds);
      if (labelIds.length) await item.setLabels(labelIds);

      await logActivity({ itemId: item.id, itemType: type, actorId: reporterId, kind: "created" });
      for (const uid of assigneeIds) {
        await notify({ userId: uid, fromUserId: reporterId, kind: "assigned", itemId: item.id, itemType: type, message: `Assigned: ${item.title}` });
      }
      if (type === "task") await taskHooks.afterCreate(item, input, assigneeIds, reporterId);
      return reload(item.id);
    },

    async update(id: string, patch: WorkItemUpdateInput, actorId: string, opts: { strict?: boolean } = {}) {
      await assertCanSeeRecord(actorId, type, id);
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      const prepared = type === "task" ? await taskHooks.prepareUpdate(item, patch, actorId, !!opts.strict) : null;
      const assigneeIds = prepared ? prepared.assigneeIds : patch.assigneeIds;
      await item.update({
        ...(prepared?.columns ?? {}),
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
        ...(patch.departmentId !== undefined ? { departmentId: patch.departmentId } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate ? new Date(patch.dueDate) : null } : {}),
        ...(type === "issue" && patch.severity !== undefined ? { severity: patch.severity } : {}),
      });
      if (assigneeIds) {
        const before: string[] = (await item.getAssignees()).map((u: { id: string }) => u.id);
        await item.setAssignees(assigneeIds);
        await logActivity({ itemId: id, itemType: type, actorId, kind: "assigned" });
        // Notify only the newly-added assignees.
        for (const uid of assigneeIds.filter((u) => !before.includes(u))) {
          await notify({ userId: uid, fromUserId: actorId, kind: "assigned", itemId: id, itemType: type, message: `Assigned: ${item.title}` });
        }
      }
      if (patch.labelIds) await item.setLabels(patch.labelIds);
      // Assignees and labels live in join tables, which don't touch the item's
      // updated_at. Bump it so offline clients see the change on their next sync.
      if (assigneeIds || patch.labelIds || patch.dependsOnIds) {
        item.changed("updatedAt", true);
        await item.save();
      }
      if (prepared) await taskHooks.afterUpdate(item, patch, prepared.reviewerChanged, actorId);
      return reload(id);
    },

    async setStatus(id: string, status: WorkItemCreateInput["status"], actorId: string, opts: { note?: string; blockedReason?: string } = {}) {
      await assertCanSeeRecord(actorId, type, id);
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      if (type === "task") {
        // Rules, history and notifications all live in the task workflow.
        await taskHooks.setStatus(item, status!, actorId, opts);
        return reload(id);
      }
      const from = item.status;
      if (from === status) return reload(id);
      await item.update({ status });
      // Mirror to GitHub when this issue is linked to a GitHub issue.
      if (type === "issue") {
        const link = await GithubIssueLink.findOne({ where: { itemId: id } });
        if (link) {
          const desired = status === "done" ? "closed" : "open";
          if (link.state !== desired) {
            await setIssueState(link.owner, link.repo, link.number, desired).catch(() => false);
            link.state = desired;
            await link.save();
          }
        }
      }
      await logActivity({ itemId: id, itemType: type, actorId, kind: "status_changed", data: { from, to: status } });
      if (item.reporterId) {
        await notify({ userId: item.reporterId, fromUserId: actorId, kind: "status_changed", itemId: id, itemType: type, message: `${item.title} moved to ${status}` });
      }
      return reload(id);
    },

    async requestFeedback(id: string, fromUserId: string, actorId: string) {
      await assertCanSeeRecord(actorId, type, id);
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      await item.update({ feedbackAwaitingFrom: fromUserId, feedbackRequestedBy: actorId, feedbackRequestedAt: new Date() });
      await logActivity({ itemId: id, itemType: type, actorId, kind: "feedback_requested", data: { from: fromUserId } });
      await notify({ userId: fromUserId, fromUserId: actorId, kind: "feedback_requested", itemId: id, itemType: type, message: `Feedback requested on ${item.title}` });
      return reload(id);
    },

    async provideFeedback(id: string, actorId: string, body: string) {
      await assertCanSeeRecord(actorId, type, id);
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      await item.update({ feedbackAwaitingFrom: null, feedbackRequestedBy: null, feedbackRequestedAt: null });
      await Comment.create({ itemId: id, itemType: type, authorId: actorId, body: `**Feedback:** ${body}` });
      await logActivity({ itemId: id, itemType: type, actorId, kind: "feedback_provided" });
      return reload(id);
    },

    async linkPullRequest(id: string, pr: { number: number; title: string; url: string; status?: "open" | "merged" | "closed" | "draft" }, actorId: string) {
      await assertCanSeeRecord(actorId, type, id);
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
      // Best-effort CI + review enrichment (sets headSha so webhooks can match).
      await githubService.enrich(created).catch(() => undefined);
      await logActivity({ itemId: id, itemType: type, actorId, kind: "pr_linked", data: { pr: created.id } });
      return reload(id);
    },

    // Link a documentation/reference URL to the item (Google Doc, Notion, spec…).
    async linkDoc(id: string, doc: { title: string; url: string }, actorId: string) {
      await assertCanSeeRecord(actorId, type, id);
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      await DocumentationLink.create({
        itemId: id,
        itemType: type,
        title: doc.title,
        url: doc.url,
        addedBy: actorId,
      });
      return reload(id);
    },

    // Remove a linked documentation URL.
    async unlinkDoc(id: string, docId: string, actorId: string) {
      await assertCanSeeRecord(actorId, type, id);
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      await DocumentationLink.destroy({ where: { id: docId, itemId: id, itemType: type } });
      return reload(id);
    },

    // Re-fetch live CI/review state for every linked PR. Lets the UI self-heal
    // when GitHub webhooks aren't delivered, so check state can't get stuck.
    async refreshPullRequests(id: string, actorId: string) {
      await assertCanSeeRecord(actorId, type, id);
      const item = await M.findByPk(id);
      if (!item) throw notFound(`${type} not found`);
      const prs = await PullRequest.findAll({ where: { itemId: id, itemType: type } });
      await Promise.all(prs.map((pr) => githubService.enrich(pr).catch(() => undefined)));
      return reload(id);
    },
  };
}

export const tasksService = makeWorkItemService(Task, "task");
export const issuesService = makeWorkItemService(Issue, "issue");
