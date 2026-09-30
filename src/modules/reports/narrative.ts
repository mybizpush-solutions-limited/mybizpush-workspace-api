import { env } from "../../config/env";
import { chatCompletion } from "../../lib/openrouter";
import type { StaffReportPayload } from "./staffReport.service";

// The house style forbids em/en dashes in generated prose. Enforce it in the
// prompt and strip any the model emits anyway. Exported for reuse by the
// meeting report generator.
export function stripDashes(text: string): string {
  return text
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .replace(/,\s*,+/g, ",")
    .replace(/,\s*\./g, ".")
    .replace(/ {2,}/g, " ")
    .trim();
}

const SYSTEM = `You write monthly staff performance reports for MyBizPush Solutions Limited, an Abuja-based software company. You are writing the narrative overview section of a report about one staff member's work on one project in one month, for a manager audience.

Rules:
- Ground every claim strictly in the data provided. Do not invent facts, numbers or names.
- If the data is sparse or empty, say plainly that the recorded activity was light, and what that means, without padding.
- Commits and merged pull requests are the primary record of engineering work. When the task tracker looks quiet but the commit record is substantial, describe the person as clearly working and treat the task-tracking gap as a process observation, never as inactivity or a contradiction to investigate.
- Write 2 to 3 short paragraphs of plain professional prose.
- Use no em dashes and no en dashes anywhere. Use commas, colons or full stops instead.
- No markdown, no headings, no bullet lists. Return plain paragraphs separated by blank lines.`;

// Produce the human-readable overview for a staff report. Returns null (never
// throws) when OpenRouter is unconfigured or the call fails, so a report is
// still generated without the narrative.
export async function generateStaffNarrative(p: StaffReportPayload): Promise<string | null> {
  if (!env.OPENROUTER_API_KEY) return null;
  try {
    const data = {
      staff: p.staff.name,
      roles: p.staff.roles,
      departments: p.staffDepartments,
      project: p.project.name,
      projectProgress: `${p.project.progress}%`,
      period: p.period.label,
      summary: p.summary,
      tasks: p.tasks.slice(0, 60).map((t) => `${t.title} (${t.status}${t.overdue ? ", overdue" : ""})`),
      issues: p.issues.slice(0, 40).map((t) => `${t.title} (${t.status})`),
      workDelivered: p.workDelivered ?? [],
      commits: p.commits.slice(0, 80).map((c) => `${(c.date ?? "").slice(0, 10)} [${c.repo}] ${c.message}`),
      mergedPullRequests: (p.pulls ?? []).slice(0, 40).map((pr) => `${(pr.mergedAt ?? "").slice(0, 10)} [${pr.repo}] ${pr.title}`),
      activity: p.timeline.slice(0, 40).map((e) => `${(e.at ?? "").slice(0, 10)} ${e.actor ?? "System"} ${e.kind} on "${e.itemTitle}"`),
    };
    const text = await chatCompletion(
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Write the narrative overview for this staff monthly report.\n\n${JSON.stringify(data)}`,
        },
      ],
      { model: env.OPENROUTER_REPORT_MODEL, temperature: 0.4, reasoningEffort: "high" },
    );
    return stripDashes(text) || null;
  } catch (err) {
    console.error("[reports] narrative generation failed:", err);
    return null;
  }
}

// Turns raw commit messages + merged PR titles/descriptions into a readable
// list of the work the person actually delivered: related commits are grouped
// into the feature/fix they represent. Empty list when OpenRouter is missing
// or the call fails; the report then falls back to raw commit titles.
const WORK_SYSTEM = `You are a senior engineer at MyBizPush Solutions Limited preparing a monthly report section listing the work one engineer delivered.

You will be given their git commits (titles and descriptions) and merged pull requests (titles and descriptions) for one month, across the project's repositories. Group related commits into the actual pieces of work delivered; a merged pull request counts as one piece of work. Write for a manager who is not reading the diffs.

Return STRICT JSON only: {"items": ["..."]} with between 3 and 25 items. Each item is one or two plain sentences naming the feature, fix or system, and what it does for the product. Order by importance, not chronology.

Rules:
- Use only the commits and pull requests provided; do not invent work.
- Keep product names, dollar terms, module names and figures exactly as they appear.
- Use no em dashes and no en dashes anywhere. Use commas, colons or full stops instead.
- No markdown or bullets in the items. Plain sentences only.`;

export async function generateWorkDelivered(
  commits: { message: string; body?: string; repo: string; date: string | null }[],
  pulls: { title: string; body: string; repo: string; mergedAt: string | null }[],
): Promise<string[]> {
  if (!env.OPENROUTER_API_KEY) return [];
  if (!commits.length && !pulls.length) return [];
  try {
    const input = {
      commits: commits.slice(0, 300).map((c) => ({
        repo: c.repo,
        date: (c.date ?? "").slice(0, 10),
        title: c.message,
        description: (c.body ?? "").slice(0, 600),
      })),
      mergedPullRequests: pulls.slice(0, 100).map((p) => ({
        repo: p.repo,
        mergedAt: (p.mergedAt ?? "").slice(0, 10),
        title: p.title,
        description: p.body.slice(0, 1500),
      })),
    };
    const raw = await chatCompletion(
      [
        { role: "system", content: WORK_SYSTEM },
        { role: "user", content: `List the work delivered this month.\n\n${JSON.stringify(input)}` },
      ],
      { model: env.OPENROUTER_REPORT_MODEL, temperature: 0.3, reasoningEffort: "high" },
    );
    const parsed = parseJsonLoose(raw) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items
      .filter((i): i is string => typeof i === "string" && i.trim().length > 0)
      .slice(0, 25)
      .map(stripDashes);
  } catch (err) {
    console.error("[reports] work-delivered generation failed:", err);
    return [];
  }
}

// Dig the outermost JSON object out of a model reply (strips code fences and
// any prose around it).
function parseJsonLoose(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(text.slice(start, end + 1));
}