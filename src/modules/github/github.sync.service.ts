import { Department, GithubAccount, GithubIssueLink, Issue, type WorkStatus } from "../../models";
import { parseRepoInput } from "../../lib/github";
import { getIssue, listTeams } from "../../lib/github.features";
import { issuesService } from "../workitems/workitems.service";
import { logActivity } from "../shared/events";

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Map GitHub issue state → app work status (and back). Only "closed"/"open"
// matter on GitHub; we mirror to done / todo without clobbering in-flight work.
const githubToStatus = (state: string): WorkStatus => (state === "closed" ? "done" : "todo");

export interface TeamSyncResult {
  departmentsCreated: number;
  membersAdded: number;
  unmatchedLogins: string[];
  teams: Array<{ team: string; department: string; members: number; added: number }>;
}

export const githubSyncService = {
  // ---- Teams → departments (non-destructive provisioning) ------------------
  // Each GitHub team becomes (or matches) a department; team members whose
  // connected GitHub login we recognise are added. Nothing is removed.
  async syncTeams(): Promise<TeamSyncResult> {
    const teams = await listTeams();
    const accounts = await GithubAccount.findAll();
    const loginToUser = new Map(
      accounts.filter((a) => a.login).map((a) => [a.login!.toLowerCase(), a.userId]),
    );

    let departmentsCreated = 0;
    let membersAdded = 0;
    const unmatched = new Set<string>();
    const summary: TeamSyncResult["teams"] = [];

    for (const team of teams) {
      const slug = slugify(team.slug || team.name);
      if (!slug) continue;
      let dept = await Department.findOne({ where: { slug } });
      if (!dept) {
        dept = await Department.create({ slug, name: team.name, description: team.description ?? "" });
        departmentsCreated += 1;
      }
      let added = 0;
      for (const login of team.memberLogins) {
        const userId = loginToUser.get(login.toLowerCase());
        if (!userId) {
          unmatched.add(login);
          continue;
        }
        const has = await (dept as unknown as { hasMember(id: string): Promise<boolean> }).hasMember(userId);
        if (!has) {
          await (dept as unknown as { addMember(id: string): Promise<void> }).addMember(userId);
          added += 1;
          membersAdded += 1;
        }
      }
      summary.push({ team: team.name, department: dept.name, members: team.memberLogins.length, added });
    }

    return { departmentsCreated, membersAdded, unmatchedLogins: [...unmatched], teams: summary };
  },

  // ---- Issue mirroring -----------------------------------------------------
  // Import a GitHub issue into a project as a synced app issue.
  async importIssue(projectId: string, repoFullName: string, number: number, actorId: string) {
    const parsed = parseRepoInput(repoFullName);
    if (!parsed) throw new Error("Invalid repo");
    const gh = await getIssue(parsed.owner, parsed.repo, number);
    if (!gh) throw new Error("GitHub issue not found");

    // Skip if this GitHub issue is already mirrored.
    const existing = await GithubIssueLink.findOne({ where: { url: gh.url } });
    if (existing) return issuesService.byId(existing.itemId);

    const created = await issuesService.create(
      { projectId, title: gh.title, description: gh.body ?? "", status: githubToStatus(gh.state) },
      actorId,
    );
    await GithubIssueLink.create({
      itemId: created.id,
      itemType: "issue",
      owner: parsed.owner,
      repo: parsed.repo,
      fullName: `${parsed.owner}/${parsed.repo}`,
      number: gh.number,
      url: gh.url,
      state: gh.state,
    });
    return issuesService.byId(created.id);
  },

  // GitHub → app: an `issues` webhook updates the mirrored app issue.
  async handleIssueWebhook(payload: {
    action?: string;
    issue?: { html_url?: string; title?: string; state?: string; number?: number };
  }): Promise<number> {
    const gh = payload.issue;
    if (!gh?.html_url) return 0;
    const link = await GithubIssueLink.findOne({ where: { url: gh.html_url } });
    if (!link) return 0;

    if (gh.state) link.state = gh.state;
    await link.save();

    const issue = await Issue.findByPk(link.itemId);
    if (!issue) return 0;
    const patch: Partial<{ title: string; status: WorkStatus }> = {};
    if (gh.title && gh.title !== issue.title) patch.title = gh.title;
    // Only flip status on a real open/closed transition.
    if (gh.state === "closed" && issue.status !== "done") patch.status = "done";
    if (gh.state === "open" && issue.status === "done") patch.status = "todo";
    if (Object.keys(patch).length) {
      await issue.update(patch);
      await logActivity({ itemId: issue.id, itemType: "issue", actorId: issue.reporterId ?? issue.id, kind: "status_changed", data: { source: "github" } });
    }
    return 1;
  },
};
