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

// Without this the model fills the stack gap from the project name alone and
// consistently guesses PHP/Laravel. Every prompt carries it; briefs additionally
// carry the project's own declared stack, which always wins over this default.
const STACK_GUARDRAIL =
  "Tech stack rules — follow these exactly. Every MyBizPush project is Node.js with " +
  "TypeScript (Express, Sequelize, Postgres on the API; React/Vite or Next.js on the " +
  "frontend), with one exception: the Hyparrow API is written in Go (Gin + GORM). " +
  "Never assume PHP/Laravel, Ruby on Rails, Django, or Spring, and never emit commands " +
  "or file paths from those ecosystems (no `artisan`, `composer`, `rails`, `manage.py`, " +
  "no `app/Http/Controllers`). If a project states its own stack, that statement wins. " +
  "If you genuinely cannot tell which stack applies, say so instead of guessing.";

const SYSTEM_PROMPT =
  "You are the MyBizPush Dev Space assistant — a concise, practical copilot inside an internal " +
  "work-management tool organized as Departments → Projects → Tasks & Issues. Help the team " +
  "summarize issues, draft replies, break work into steps, and surface blockers. Keep answers " +
  "brief and actionable; use short bullet lists when helpful.\n\n" +
  STACK_GUARDRAIL;

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

    // The project's declared stack, or the org default. Stated explicitly so the
    // brief targets the real toolchain instead of one inferred from the name.
    const techStack =
      project?.techStack?.trim() ||
      "Node.js + TypeScript (Express, Sequelize, Postgres) unless the repository " +
        "clearly shows otherwise";

    const prompt =
      `Write a clear, self-contained brief instructing an autonomous coding agent (such as ` +
      `Claude Code) to resolve the following ${itemType}. Assume the agent already has the ` +
      `repository checked out locally and can read/edit files and run commands. Structure it ` +
      `with: a one-line Goal; Context; concrete Acceptance criteria; a suggested step-by-step ` +
      `Plan; and any relevant links. Be specific and actionable; do not invent details that ` +
      `aren't provided. Use Markdown.\n\n` +
      `Do NOT instruct the agent to perform any git actions — no creating branches, committing, ` +
      `pushing, or opening/creating pull requests. All git operations are left for the user to ` +
      `perform manually. The brief must stop at making the code changes and writing the ` +
      `reference docs below.\n\n` +
      `Also instruct the agent that, once the work is done, it must produce reference ` +
      `documentation as Markdown files in the repo, named after this ${itemType}: ` +
      `"[TASK/ISSUE_NAME]_Backend_Reference.md" and "[TASK/ISSUE_NAME]_Frontend_Reference.md", ` +
      `where [TASK/ISSUE_NAME] is a slug of the ${itemType} title. ` +
      `The Backend reference documents the details of the files that were actually changed for ` +
      `this ${itemType}: each file touched and what changed in it, plus the relevant endpoints, ` +
      `models/migrations, services, validation, and data flow. ` +
      `The Frontend reference is the API reference the frontend needs to integrate this feature — ` +
      `the endpoints the UI should call (HTTP method and path), request and response payload ` +
      `shapes, auth requirements, and error responses. It documents the API contract consumable ` +
      `by the frontend, NOT frontend code changes, so never leave it empty or write "No changes"; ` +
      `if this ${itemType} exposes or affects no API, omit the Frontend reference file entirely ` +
      `rather than emitting an empty one.\n\n` +
      `${STACK_GUARDRAIL}\n\n` +
      `Project: ${project?.name ?? "(unknown)"}\n` +
      `Tech stack: ${techStack}\n` +
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
