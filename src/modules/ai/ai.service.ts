import { chatCompletion, type ChatMessage } from "../../lib/openrouter";
import {
  Comment,
  GithubIssueLink,
  Issue,
  Project,
  ProjectRepo,
  PullRequest,
  Task,
  type ItemType,
} from "../../models";
import { notFound } from "../../lib/errors";

const SYSTEM_PROMPT =
  "You are the MyBizPush Dev Space assistant — a concise, practical copilot inside an internal " +
  "work-management tool organized as Departments → Projects → Tasks & Issues. Help the team " +
  "summarize issues, draft replies, break work into steps, and surface blockers. Keep answers " +
  "brief and actionable; use short bullet lists when helpful.";

export const aiService = {
  // Free-form chat. The system prompt is prepended server-side.
  chat: (messages: ChatMessage[]) =>
    chatCompletion([{ role: "system", content: SYSTEM_PROMPT }, ...messages]),

  // Summarize a specific task/issue using its description + recent comments.
  async summarizeItem(itemId: string, itemType: ItemType): Promise<string> {
    const item = itemType === "task" ? await Task.findByPk(itemId) : await Issue.findByPk(itemId);
    if (!item) throw notFound(`${itemType} not found`);
    const comments = await Comment.findAll({
      where: { itemId },
      order: [["createdAt", "ASC"]],
      limit: 30,
    });

    const transcript = comments.map((c) => `- ${c.body}`).join("\n") || "(no comments)";
    const prompt =
      `Summarize this ${itemType} for a teammate catching up. Give a one-line status, the key points, ` +
      `and any blockers or next steps.\n\n` +
      `Title: ${item.title}\nStatus: ${item.status}\nPriority: ${item.priority}\n\n` +
      `Description:\n${item.description || "(none)"}\n\nComments:\n${transcript}`;

    return chatCompletion([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ]);
  },

  // Produce a ready-to-paste brief for an external coding agent (e.g. Claude
  // Code) that already has the repo checked out. Pulls in the linked repo(s),
  // the item details, discussion, and any linked PRs / GitHub issue so the agent
  // has the full picture without needing the app.
  async agentBrief(itemId: string, itemType: ItemType): Promise<string> {
    const item = itemType === "task" ? await Task.findByPk(itemId) : await Issue.findByPk(itemId);
    if (!item) throw notFound(`${itemType} not found`);

    const [comments, project, repos, ghLink, prs] = await Promise.all([
      Comment.findAll({ where: { itemId }, order: [["createdAt", "ASC"]], limit: 30 }),
      Project.findByPk(item.projectId),
      ProjectRepo.findAll({ where: { projectId: item.projectId } }),
      GithubIssueLink.findOne({ where: { itemId, itemType } }),
      PullRequest.findAll({ where: { itemId, itemType } }),
    ]);

    const transcript = comments.map((c) => `- ${c.body}`).join("\n") || "(no comments)";
    const repoList = repos.length
      ? repos.map((r) => `- ${r.fullName}${r.htmlUrl ? ` (${r.htmlUrl})` : ""}`).join("\n")
      : "(no repositories linked to this project)";
    const prList = prs.length
      ? prs.map((p) => `- #${p.number} ${p.title} [${p.status}] ${p.url}`).join("\n")
      : "(none)";
    const ghIssue = ghLink
      ? `${ghLink.fullName} #${ghLink.number} (${ghLink.state}) — ${ghLink.url}`
      : "(not linked to a GitHub issue)";

    const prompt =
      `Write a clear, self-contained brief instructing an autonomous coding agent (such as ` +
      `Claude Code) to resolve the following ${itemType}. Assume the agent already has the ` +
      `repository checked out locally and can read/edit files, run commands, and open a pull ` +
      `request. Structure it with: a one-line Goal; Context; concrete Acceptance criteria; a ` +
      `suggested step-by-step Plan; and any relevant links. Be specific and actionable; do not ` +
      `invent details that aren't provided. Use Markdown.\n\n` +
      `Project: ${project?.name ?? "(unknown)"}\n` +
      `Linked repositories:\n${repoList}\n\n` +
      `${itemType} title: ${item.title}\n` +
      `Status: ${item.status}\nPriority: ${item.priority}\n` +
      `GitHub issue: ${ghIssue}\n\n` +
      `Description:\n${item.description || "(none)"}\n\n` +
      `Discussion:\n${transcript}\n\n` +
      `Linked pull requests:\n${prList}`;

    return chatCompletion([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ]);
  },
};
