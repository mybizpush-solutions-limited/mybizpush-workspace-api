// Scratch smoke test for the staff report PDF renderer.
import fs from "node:fs";
import { renderStaffReportPdf } from "/Users/samsonite/Documents/Sam/mybizpush/dev-team/api/src/modules/reports/staffReportPdf";
import type { StaffReportPayload } from "/Users/samsonite/Documents/Sam/mybizpush/dev-team/api/src/modules/reports/staffReport.service";
import { generateStaffNarrative } from "/Users/samsonite/Documents/Sam/mybizpush/dev-team/api/src/modules/reports/narrative";

const day = (n: number) => new Date(Date.UTC(2026, 8, n)).toISOString();

const tasks = Array.from({ length: 14 }, (_, i) => ({
  id: `t${i}`,
  type: "task" as const,
  title: `Task number ${i + 1} — a reasonably long task title to test wrapping`,
  status: (i < 6 ? "done" : i < 8 ? "in_progress" : i < 10 ? "blocked" : i < 12 ? "in_review" : "todo") as never,
  priority: (["low", "medium", "high", "urgent"] as const)[i % 4],
  severity: null,
  dueDate: i % 3 === 0 ? day(10 + i) : null,
  createdAt: day(2 + i),
  departmentId: null,
  overdue: i > 8,
  completedInMonth: i < 6,
}));

const issues = Array.from({ length: 4 }, (_, i) => ({
  id: `i${i}`,
  type: "issue" as const,
  title: `Issue ${i + 1} — reported defect needing attention`,
  status: (i < 2 ? "done" : "blocked") as never,
  priority: "high",
  severity: (["critical", "major", "minor", "major"] as const)[i],
  dueDate: null,
  createdAt: day(5),
  departmentId: null,
  overdue: i === 2,
  completedInMonth: i < 2,
}));

const byStatus = (rows: { status: string }[]) =>
  Object.fromEntries(
    ["todo", "in_progress", "in_review", "blocked", "done"].map((s) => [
      s,
      rows.filter((r) => r.status === s).length,
    ]),
  );

const payload: StaffReportPayload = {
  project: { id: "p1", name: "Hempay Mobile App", progress: 62 },
  staff: { id: "u1", name: "Samuel Adewale", email: "samuel@mybizpush.com.ng", roles: ["Frontend"], avatarUrl: null },
  staffDepartments: ["Frontend"],
  month: "2026-09",
  period: { start: day(1), end: day(30), label: "September 2026" },
  summary: {
    tasks: {
      currentlyAssigned: tasks.length,
      completedInMonth: 6,
      openTouchedInMonth: tasks.length - 6,
      overdue: tasks.filter((t) => t.overdue).length,
      byStatus: byStatus(tasks) as never,
    },
    issues: {
      currentlyAssigned: issues.length,
      completedInMonth: 2,
      openTouchedInMonth: 2,
      overdue: 1,
      byStatus: byStatus(issues) as never,
    },
    completionRate: 50,
    activityEvents: 9,
  },
  tasks,
  issues,
  pulls: [
    { number: 42, title: "feat(admin): role-based access control for admin permissions", body: "Adds an RBAC layer to the admin dashboard: permission matrix, invite roles and guards on admin routes.", repo: "mybizpush/hyparrow-admin", mergedAt: day(11), url: "https://github.com/x/pull/42" },
    { number: 43, title: "fix(wallet): deposit replay + notifications for unnotified transactions", body: "Replays missed deposit webhooks and emails users whose transactions settled without notification.", repo: "mybizpush/hyparrow-api", mergedAt: day(19), url: "https://github.com/x/pull/43" },
  ],
  workDelivered: [
    "Role-based access control for the admin dashboard: a permission matrix, role guards on admin routes and cleaner invite handling.",
    "Deposit replay and notification system for unnotified transactions, plus a DepositBackfill component that processes missed deposits.",
    "Channel profit projection reporting with tiered transfer fee schedules, and a fix to the 9,999 naira tier logic.",
  ],
  commits: [
    { sha: "a1b2c3d", message: "Fix wallet balance flicker on refresh", repo: "mybizpush/hempay-app", date: day(9), url: "https://github.com/x/commit/a1b2c3d" },
    { sha: "e4f5a6b", message: "Add CSV export to the reports page", repo: "mybizpush/hempay-app", date: day(14), url: "https://github.com/x/commit/e4f5a6b" },
    { sha: "b7c8d9e", message: "Onboarding flow: step indicator polish", repo: "mybizpush/hempay-web", date: day(21), url: "https://github.com/x/commit/b7c8d9e" },
  ],
  commitRepos: [
    { repo: "mybizpush/hempay-app", count: 2 },
    { repo: "mybizpush/hempay-web", count: 1 },
  ],
  timeline: [
    { at: day(3), kind: "assigned", itemType: "task", itemTitle: "Implement task Kanban board", actor: "Amaka Obi", from: null, to: null },
    { at: day(7), kind: "status_changed", itemType: "task", itemTitle: "Implement task Kanban board", actor: "Samuel Adewale", from: "todo", to: "in_progress" },
    { at: day(12), kind: "commented", itemType: "issue", itemTitle: "Wallet balance flickers on refresh", actor: "Samuel Adewale", from: null, to: null },
    { at: day(18), kind: "status_changed", itemType: "task", itemTitle: "Onboarding flow redesign", actor: "Amaka Obi", from: "in_progress", to: "done" },
    { at: day(24), kind: "pr_linked", itemType: "task", itemTitle: "Add CSV export", actor: "Samuel Adewale", from: null, to: null },
  ],
  generatedAt: new Date().toISOString(),
};

(async () => {
  // Generate the narrative first so the PDF includes the Overview section.
  payload.narrative = await generateStaffNarrative(payload);
  console.log("NARRATIVE:", payload.narrative ? payload.narrative.slice(0, 300) : "(unavailable)");
  if (payload.narrative) console.log("HAS_EM_DASH:", /[\u2013\u2014]/.test(payload.narrative));

  const { buffer, filename } = await renderStaffReportPdf(payload);
  fs.writeFileSync("/tmp/staff-report-test.pdf", buffer);
  console.log("OK", filename, `${(buffer.length / 1024).toFixed(0)} KB`);
})();