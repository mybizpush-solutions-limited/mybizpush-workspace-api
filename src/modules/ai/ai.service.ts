import {
  chatCompletion,
  chatCompletionWithTools,
  type ChatMessage,
  type ToolCall,
} from "../../lib/openrouter";
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
import { AppError, notFound } from "../../lib/errors";
import type { Auth } from "../../lib/permissions";
import { describeActor, resolveActor, type ActorContext } from "./ai.context";
import { claimAction, stageAction, toView, type PendingActionView } from "./ai.actions";
import { getTool, parseToolArgs, toolDefinitions } from "./ai.tools";

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

// The agent variant. The rules here exist because of how the loop is wired:
// reads run immediately, writes are staged and confirmed by the person, so the
// model must not claim a write already happened.
const AGENT_PROMPT =
  SYSTEM_PROMPT +
  "\n\n" +
  "You have tools that read and change real workspace data. Rules:\n" +
  "- Look things up instead of asking. If someone asks what they have today, call " +
  "get_my_work rather than asking which project they mean.\n" +
  "- Never invent ids, names, statuses, or dates. If a tool returns nothing, say so.\n" +
  "- Tools that change data are not executed when you call them — they are queued for the " +
  "person to approve. So describe what you have queued in the future or conditional tense " +
  "('I've queued…', 'once you confirm…'). Never say a change has been made, and never " +
  "claim to have seen its result.\n" +
  "- Queue a write only when the person clearly asked for that change. When their request is " +
  "ambiguous, ask first.\n" +
  "- Everyone in the workspace can read all projects, tasks, and issues, so reading is not " +
  "sensitive. Approval on writes is what protects them; do not try to work around it.\n" +
  "- Be direct about what you cannot see. You have no access to source code, deployments, " +
  "or anything outside the tools listed.";

// Enough hops to look something up, follow it, and answer. Higher mostly buys
// runaway loops on a model that keeps re-reading the same rows.
const MAX_TURNS = 6;

export interface ChatContext {
  /** Where the person is in the UI, so "this task" resolves without them saying which. */
  itemId?: string;
  itemType?: ItemType;
  projectId?: string;
}

export interface ChatResult {
  reply: string;
  pendingActions: PendingActionView[];
}

export interface ChatInput {
  messages: { role: "user" | "assistant"; content: string }[];
  context?: ChatContext;
}

async function describeContext(context: ChatContext): Promise<string> {
  const parts: string[] = [];
  if (context.itemId && context.itemType) {
    const item =
      context.itemType === "task"
        ? await Task.findByPk(context.itemId)
        : await Issue.findByPk(context.itemId);
    if (item) {
      parts.push(
        `They are currently viewing ${context.itemType} "${item.title}" ` +
          `(id ${item.id}, status ${item.status}, project ${item.projectId}). ` +
          `Treat "this ${context.itemType}", "this item", or "it" as referring to it.`,
      );
    }
  }
  if (context.projectId) {
    const project = await Project.findByPk(context.projectId);
    if (project) {
      parts.push(
        `They are working in project "${project.name}" (id ${project.id}). ` +
          `Treat "this project" as referring to it.`,
      );
    }
  }
  return parts.join("\n");
}

// Run one tool call. Reads execute; writes are staged for confirmation and the
// model is told so, so it doesn't report the change as done.
async function handleToolCall(
  call: ToolCall,
  actor: ActorContext,
  staged: PendingActionView[],
): Promise<ChatMessage> {
  const respond = (payload: unknown): ChatMessage => ({
    role: "tool",
    tool_call_id: call.id,
    name: call.function.name,
    content: JSON.stringify(payload),
  });

  const tool = getTool(call.function.name);
  if (!tool) return respond({ error: `No tool named ${call.function.name}` });

  try {
    const args = parseToolArgs(tool, call.function.arguments);

    if (!tool.mutates) return respond({ ok: true, result: await tool.run(args, actor) });

    const action = await stageAction({
      tool: tool.name,
      args,
      preview: tool.preview ? await tool.preview(args, actor) : `Run ${tool.name}`,
      userId: actor.id,
    });
    staged.push(toView(action));
    return respond({
      ok: true,
      staged: true,
      preview: action.preview,
      note:
        "Queued for the person to approve. It has NOT run. Do not call this tool again for " +
        "the same change, and do not state that the change was made.",
    });
  } catch (err) {
    // Tool failures are the model's problem to recover from, not a 500 — it can
    // retry with different arguments or tell the person what went wrong.
    const message = err instanceof AppError ? err.message : "The tool failed unexpectedly";
    if (!(err instanceof AppError)) console.error(`[ai] tool ${call.function.name} failed`, err);
    return respond({ ok: false, error: message });
  }
}

const FINAL_ANSWER_NUDGE: ChatMessage = {
  role: "user",
  content:
    "Answer now using only what you have already gathered above. Do not ask for more tools. " +
    "If the answer is incomplete, say plainly what you couldn't find.",
};

// Rewrite a tool-calling transcript as ordinary chat turns, so it can be sent on
// a request with no `tools` declared.
function flatten(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap((m) => {
    if (m.role === "tool") {
      return [{ role: "user" as const, content: `Result of ${m.name ?? "a tool"}: ${m.content}` }];
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const names = m.tool_calls.map((c) => c.function.name).join(", ");
      return [{ role: "assistant" as const, content: m.content || `(looked up: ${names})` }];
    }
    return [m];
  });
}

export const aiService = {
  // Free-form chat, with tools. The system prompt and the person's identity are
  // built server-side; the client only ever sends the conversation.
  async chat(auth: Auth, input: ChatInput): Promise<ChatResult> {
    const actor = await resolveActor(auth);
    const contextNote = input.context ? await describeContext(input.context) : "";

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `${AGENT_PROMPT}\n\n${describeActor(actor, new Date())}${contextNote ? `\n${contextNote}` : ""}`,
      },
      ...input.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    ];

    const staged: PendingActionView[] = [];
    const tools = toolDefinitions();

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { content, toolCalls } = await chatCompletionWithTools(messages, tools);
      if (!toolCalls.length) return { reply: content, pendingActions: staged };

      messages.push({ role: "assistant", content, tool_calls: toolCalls });
      // Sequential, not parallel: two calls can touch the same row, and the
      // ordering the model asked for is the ordering it expects back.
      for (const call of toolCalls) {
        messages.push(await handleToolCall(call, actor, staged));
      }
    }

    // Out of hops. Answer from what's already gathered rather than returning
    // nothing. The tool-call scaffolding is flattened into plain text first —
    // an assistant turn carrying tool_calls is only valid on a request that also
    // declares tools, and this one deliberately doesn't.
    const reply = await chatCompletion([...flatten(messages), FINAL_ANSWER_NUDGE]);
    return { reply, pendingActions: staged };
  },

  // Approve a staged write and run it. Re-resolves the actor so a permission
  // change between staging and confirming is respected, and the underlying
  // service enforces its own rules exactly as it does for a normal request.
  async confirmAction(auth: Auth, actionId: string): Promise<{ preview: string; result: unknown }> {
    const action = await claimAction(actionId, auth.sub);
    const tool = getTool(action.tool);
    if (!tool?.mutates) throw notFound("That action is no longer available");
    const actor = await resolveActor(auth);
    return { preview: action.preview, result: await tool.run(action.args, actor) };
  },

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
