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
      commits: p.commits.slice(0, 80).map((c) => `${(c.date ?? "").slice(0, 10)} [${c.repo}] ${c.message}`),
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