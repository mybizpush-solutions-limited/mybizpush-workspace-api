import { Op } from "sequelize";
import {
  Activity,
  GithubAccount,
  Issue,
  Project,
  ProjectCommit,
  ProjectRepo,
  Task,
  User,
} from "../../models";
import { notFound } from "../../lib/errors";
import type { WorkStatus } from "../../models";
import { listMergedPullRequests } from "../../lib/github.features";
import { commitsSyncService } from "../github/commits.sync.service";
import { generateStaffNarrative, generateWorkDelivered } from "./narrative";

// ------------------------------------------------------------------ helpers --
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_RE.test(value);
}

// A month window in UTC: [first day, first day of next month).
function monthRange(month: string): { start: Date; end: Date; label: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  const label = start.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return { start, end, label };
}

export const WORK_STATUSES: WorkStatus[] = ["todo", "in_progress", "in_review", "blocked", "done"];

const STATUS_CHANGED_TO_DONE = "done";

// -------------------------------------------------------------------- types --
export interface ReportRow {
  id: string;
  type: "task" | "issue";
  title: string;
  status: WorkStatus;
  priority: string;
  severity: string | null;
  dueDate: string | null;
  createdAt: string;
  departmentId: string | null;
  overdue: boolean;
  completedInMonth: boolean;
}

export interface TimelineEntry {
  at: string;
  kind: string;
  itemType: "task" | "issue";
  itemTitle: string;
  actor: string | null;
  from: string | null;
  to: string | null;
}

// A git commit by the staff member, from one of the project's linked repos.
export interface CommitRow {
  sha: string;
  message: string;
  body?: string; // commit description (remaining message lines), when stored
  repo: string;
  date: string | null;
  url: string;
}

// A merged PR authored by the staff member (attributed by GitHub login).
export interface PullRow {
  number: number;
  title: string;
  body: string;
  repo: string;
  mergedAt: string | null;
  url: string;
}

export interface StaffReportPayload {
  project: { id: string; name: string; progress: number };
  staff: { id: string; name: string; email: string; roles: string[]; avatarUrl: string | null };
  staffDepartments: string[];
  month: string;
  period: { start: string; end: string; label: string };
  summary: {
    tasks: {
      currentlyAssigned: number;
      completedInMonth: number;
      openTouchedInMonth: number;
      overdue: number;
      byStatus: Record<WorkStatus, number>;
    };
    issues: {
      currentlyAssigned: number;
      completedInMonth: number;
      openTouchedInMonth: number;
      overdue: number;
      byStatus: Record<WorkStatus, number>;
    };
    completionRate: number; // percent, 0–100
    activityEvents: number;
  };
  tasks: ReportRow[];
  issues: ReportRow[];
  timeline: TimelineEntry[];
  // Git activity: the staff member's commits across every repo linked to the
  // project in the month, newest first (capped at 200).
  commits: CommitRow[];
  commitRepos: { repo: string; count: number }[];
  // Merged PRs authored by the staff member in the month (by GitHub login).
  pulls: PullRow[];
  // Human-readable list of the work actually delivered, generated from commit
  // messages + merged PR descriptions by the report model (GLM 5.3 flash,
  // high reasoning). Empty when unavailable; the PDF falls back to raw titles.
  workDelivered: string[];
  // Human-readable overview written by the report model (GLM 5.3 flash, high
  // reasoning). Null when OpenRouter is unconfigured or the call failed.
  narrative?: string | null;
  generatedAt: string;
}

// ------------------------------------------------------------- item helpers --
interface WorkItemLike {
  id: string;
  projectId: string;
  departmentId: string | null;
  title: string;
  status: WorkStatus;
  priority: string;
  severity?: string | null;
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Items of the model's type on `projectId` the staff member is an assignee of.
async function assignedItems(
  model: typeof Task | typeof Issue,
  projectId: string,
  userId: string,
): Promise<WorkItemLike[]> {
  const rows = (await model.findAll({
    where: { projectId },
    include: [{ model: User, as: "assignees", through: { attributes: [] }, attributes: ["id"] }],
  })) as unknown as (WorkItemLike & { assignees?: { id: string }[] })[];
  return rows.filter((r) => r.assignees?.some((a) => a.id === userId));
}

// Row/summary helpers live inside `build` below, where the month window and
// completion markers are in scope.

// ----------------------------------------------------------------- service --
export const staffReportService = {
  // Build the per-staff monthly payload. Inclusion rules (per the agreed spec):
  //  - an item counts as "completed in month" when a status_changed → "done"
  //    activity event for it falls inside the month (fallback: a done item last
  //    touched inside the month, for items predating activity tracking);
  //  - open items are included when they were created in the month OR had any
  //    activity inside the month (they were on the staff member's desk);
  //  - the timeline is every activity event on the staff member's items in the
  //    month, oldest first.
  async build(projectId: string, userId: string, month: string): Promise<StaffReportPayload> {
    if (!isMonth(month)) throw notFound("Invalid month — expected YYYY-MM");

    const [project, staff] = await Promise.all([Project.findByPk(projectId), User.findByPk(userId)]);
    if (!project) throw notFound("Project not found");
    if (!staff) throw notFound("Staff member not found");

    const range = monthRange(month);

    const [tasks, issues] = await Promise.all([
      assignedItems(Task, projectId, userId),
      assignedItems(Issue, projectId, userId),
    ]);

    const itemIds = [...tasks, ...issues].map((i) => i.id);
    const itemTitle = new Map<string, string>();
    for (const i of [...tasks, ...issues]) itemTitle.set(i.id, i.title);

    // Activity inside the month for the staff member's items.
    const activities = itemIds.length
      ? await Activity.findAll({
          where: {
            itemId: { [Op.in]: itemIds },
            createdAt: { [Op.gte]: range.start, [Op.lt]: range.end },
          },
          order: [["createdAt", "ASC"]],
        })
      : [];

    // Actor names for the timeline.
    const actorIds = [...new Set(activities.map((a) => a.actorId).filter((v): v is string => !!v))];
    const actors = actorIds.length
      ? await User.findAll({ where: { id: { [Op.in]: actorIds } }, attributes: ["id", "name"] })
      : [];
    const actorName = new Map(actors.map((u) => [u.id, u.name]));

    // Departments the staff member belongs to (for the cover metadata).
    const staffDepts =
      (await (staff as unknown as { getDepartments?: () => Promise<{ name: string }[]> })
        .getDepartments?.()
        .catch(() => [])) ?? [];
    const staffDepartments = staffDepts.map((d) => d.name);

    // ---- Git activity: sync, then read the workspace's commit record ----------
    const [ghAccount, repos] = await Promise.all([
      GithubAccount.findOne({ where: { userId } }),
      ProjectRepo.findAll({ where: { projectId } }),
    ]);

    const since = range.start.toISOString();
    const until = range.end.toISOString();
    const login = (ghAccount?.login ?? "").toLowerCase() || null;
    const emailSet = new Set(
      [staff.email, staff.secondaryEmail]
        .filter((e): e is string => !!e)
        .map((e) => e.toLowerCase()),
    );
    const nameLc = staff.name.toLowerCase();

    // Make sure the reporting window is synced (no-op when already covered).
    await commitsSyncService
      .syncProject(projectId, range.start)
      .catch((err) =>
        console.error(`[reports] commit sync failed for project ${projectId}:`, err),
      );

    // The staff member's commits in the month: rows matched to them at sync
    // time, plus rows re-matched here on their identity (covers records synced
    // before their GitHub account was linked).
    const commitRows = repos.length
      ? await ProjectCommit.findAll({
          where: {
            projectId,
            committedAt: { [Op.gte]: range.start, [Op.lt]: range.end },
          },
          order: [["committedAt", "DESC"]],
        })
      : [];
    const commits: CommitRow[] = commitRows
      .filter((r) => {
        const lc = (r.authorLogin ?? "").toLowerCase();
        const mail = (r.authorEmail ?? "").toLowerCase();
        const nm = (r.authorName ?? "").toLowerCase();
        return (
          r.authorUserId === userId ||
          (login && lc && lc === login) ||
          (mail && emailSet.has(mail)) ||
          (nm && nm === nameLc)
        );
      })
      .map((r) => ({
        sha: r.sha.slice(0, 7),
        message: r.message,
        body: r.body || undefined,
        repo: r.repoFullName,
        date: r.committedAt ? r.committedAt.toISOString() : null,
        url: r.url,
      }));
    const commitRepos = [
      ...commits
        .reduce((m, c) => m.set(c.repo, (m.get(c.repo) ?? 0) + 1), new Map<string, number>())
        .entries(),
    ]
      .map(([repo, count]) => ({ repo, count }))
      .sort((a, b) => b.count - a.count);

    // Merged PRs are the meaningful unit of delivered work; fetch them live
    // and attribute by GitHub login (unreliable without a linked account, so
    // they are skipped entirely in that case).
    const pulls: PullRow[] = login
      ? (
          await Promise.all(
            repos.map(async (r) => {
              try {
                return (await listMergedPullRequests(r.owner, r.repo, { since, until }))
                  .filter((p) => (p.authorLogin ?? "").toLowerCase() === login)
                  .map((p) => ({
                    number: p.number,
                    title: p.title,
                    body: p.body,
                    repo: r.fullName,
                    mergedAt: p.mergedAt,
                    url: p.url,
                  }));
              } catch (err) {
                console.error(`[reports] PR fetch failed for ${r.fullName}:`, err);
                return [] as PullRow[];
              }
            }),
          )
        )
          .flat()
          .sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""))
          .slice(0, 100)
      : [];

    const inMonth = (d: Date | null | undefined) => !!d && d >= range.start && d < range.end;

    // Completed-in-month item ids from status_changed → done events.
    const completedIds = new Set<string>();
    for (const a of activities) {
      const to = (a.data as Record<string, unknown> | null)?.to;
      if (a.kind === "status_changed" && to === STATUS_CHANGED_TO_DONE) completedIds.add(a.itemId);
    }

    const touchedIds = new Set(activities.map((a) => a.itemId));

    function toRow(item: WorkItemLike, type: "task" | "issue"): ReportRow {
      const done = item.status === "done";
      // Fallback for done items with no status_changed event in range: a month-in
      // updatedAt stands in as the completion marker.
      const completed = completedIds.has(item.id) || (done && inMonth(item.updatedAt));
      return {
        id: item.id,
        type,
        title: item.title,
        status: item.status,
        priority: item.priority,
        severity: item.severity ?? null,
        dueDate: item.dueDate ? item.dueDate.toISOString() : null,
        createdAt: item.createdAt.toISOString(),
        departmentId: item.departmentId,
        overdue: !done && !!item.dueDate && item.dueDate < range.end,
        completedInMonth: completed,
      };
    }

    function included(items: WorkItemLike[], type: "task" | "issue"): ReportRow[] {
      return items
        .filter((item) => {
          if (completedIds.has(item.id)) return true; // completed in month
          if (item.status === "done") return inMonth(item.updatedAt); // history fallback
          // Still open: created in the month or touched during it.
          return inMonth(item.createdAt) || touchedIds.has(item.id);
        })
        .map((item) => toRow(item, type));
    }

    function counts(rows: ReportRow[]) {
      const byStatus = Object.fromEntries(WORK_STATUSES.map((s) => [s, 0])) as Record<
        WorkStatus,
        number
      >;
      for (const r of rows) byStatus[r.status] += 1;
      return {
        currentlyAssigned: rows.length,
        completedInMonth: rows.filter((r) => r.completedInMonth).length,
        openTouchedInMonth: rows.filter((r) => !r.completedInMonth).length,
        overdue: rows.filter((r) => r.overdue).length,
        byStatus,
      };
    }

    const taskRows = included(tasks, "task");
    const issueRows = included(issues, "issue");
    const taskCounts = counts(taskRows);
    const issueCounts = counts(issueRows);
    const completedTotal = taskCounts.completedInMonth + issueCounts.completedInMonth;
    const openTotal = taskCounts.openTouchedInMonth + issueCounts.openTouchedInMonth;
    const completionRate =
      completedTotal + openTotal === 0
        ? 0
        : Math.round((completedTotal / (completedTotal + openTotal)) * 100);

    const timeline: TimelineEntry[] = activities.map((a) => {
      const data = (a.data as Record<string, unknown> | null) ?? {};
      const str = (v: unknown) => (typeof v === "string" ? v : null);
      return {
        at: a.createdAt.toISOString(),
        kind: a.kind,
        itemType: (a.itemType as "task" | "issue") ?? "task",
        itemTitle: itemTitle.get(a.itemId) ?? "Unknown item",
        actor: a.actorId ? (actorName.get(a.actorId) ?? null) : null,
        from: str(data.from),
        to: str(data.to),
      };
    });

    const payload: StaffReportPayload = {
      project: { id: project.id, name: project.name, progress: project.progress },
      staff: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        roles: staff.roles ?? [],
        avatarUrl: staff.avatarUrl,
      },
      staffDepartments,
      month,
      period: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        label: range.label,
      },
      summary: {
        tasks: taskCounts,
        issues: issueCounts,
        completionRate,
        activityEvents: activities.length,
      },
      tasks: taskRows,
      issues: issueRows,
      timeline,
      commits,
      commitRepos,
      pulls,
      workDelivered: [],
      generatedAt: new Date().toISOString(),
    };

    // The work-delivered list and narrative come from the report model; both
    // degrade gracefully (empty list / null) when OpenRouter is unavailable.
    payload.workDelivered = await generateWorkDelivered(commits, pulls);
    payload.narrative = await generateStaffNarrative(payload);

    return payload;
  },
};