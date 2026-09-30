import { Op } from "sequelize";
import { GithubAccount, ProjectCommit, ProjectRepo, User } from "../../models";
import { listCommits, type Commit } from "../../lib/github.features";

// Syncs GitHub commits from every repo linked to a project into the
// `project_commits` table, matching authors to workspace users. Engineers
// routinely deliver through commits without logging workspace tasks; this is
// the workspace's record of that work (commit feed, per-member counts, staff
// reports).

interface AuthorIndex {
  byLogin: Map<string, string>; // github login -> userId
  byEmail: Map<string, string>; // git email -> userId
  byName: Map<string, string>; // lowercase user name -> userId
}

async function buildAuthorIndex(): Promise<AuthorIndex> {
  const [accounts, users] = await Promise.all([
    GithubAccount.findAll({ where: { login: { [Op.not]: null } }, attributes: ["userId", "login"] }),
    User.findAll({ attributes: ["id", "name", "email", "secondaryEmail"] }),
  ]);
  const index: AuthorIndex = { byLogin: new Map(), byEmail: new Map(), byName: new Map() };
  for (const a of accounts) {
    if (a.login) index.byLogin.set(a.login.toLowerCase(), a.userId);
  }
  for (const u of users) {
    index.byName.set(u.name.toLowerCase(), u.id);
    for (const e of [u.email, u.secondaryEmail]) {
      if (e) index.byEmail.set(e.toLowerCase(), u.id);
    }
  }
  return index;
}

function matchAuthor(c: Commit, index: AuthorIndex): string | null {
  const login = (c.authorLogin ?? "").toLowerCase();
  if (login && index.byLogin.has(login)) return index.byLogin.get(login)!;
  const email = (c.authorEmail ?? "").toLowerCase();
  if (email && index.byEmail.has(email)) return index.byEmail.get(email)!;
  const name = (c.authorName ?? "").toLowerCase();
  if (name && index.byName.has(name)) return index.byName.get(name)!;
  return null;
}

export const commitsSyncService = {
  // Sync one project's linked repos. `since` overrides the incremental cursor
  // (used to backfill a report window); by default the cursor is the newest
  // synced commit per repo (falling back to 90 days on first sync).
  async syncProject(projectId: string, since?: Date): Promise<number> {
    const repos = await ProjectRepo.findAll({ where: { projectId } });
    if (!repos.length) return 0;
    const index = await buildAuthorIndex();
    let saved = 0;

    for (const r of repos) {
      try {
        const lastRow = await ProjectCommit.findOne({
          where: { projectId, repoFullName: r.fullName },
          order: [["committedAt", "DESC"]],
        });
        const cursor =
          since ??
          (lastRow?.committedAt
            ? new Date(lastRow.committedAt.getTime() + 1000)
            : new Date(Date.now() - 90 * 86400_000));

        const commits = await listCommits(r.owner, r.repo, {
          perPage: 100,
          since: cursor.toISOString(),
        });
        if (!commits.length) continue;

        // Shas are immutable, so existing rows never need updating; only
        // insert shas we don't have yet.
        const existing = new Set(
          (
            await ProjectCommit.findAll({
              where: {
                projectId,
                repoFullName: r.fullName,
                sha: { [Op.in]: commits.map((c) => c.sha) },
              },
              attributes: ["sha"],
            })
          ).map((row) => row.sha),
        );
        const fresh = commits.filter((c) => !existing.has(c.sha));
        if (!fresh.length) continue;

        await ProjectCommit.bulkCreate(
          fresh.map((c) => ({
            projectId,
            repoFullName: r.fullName,
            sha: c.sha,
            message: c.message.slice(0, 500),
            body: c.body,
            url: c.url,
            authorName: c.authorName ?? "",
            authorLogin: c.authorLogin ?? "",
            authorEmail: c.authorEmail ?? "",
            authorUserId: matchAuthor(c, index),
            committedAt: c.date ? new Date(c.date) : null,
          })),
        );
        saved += fresh.length;
      } catch (err) {
        // One unreachable repo must not sink the sync.
        console.error(`[commits-sync] ${r.fullName} failed:`, err);
      }
    }
    return saved;
  },

  // Nightly job: every project that has linked repos.
  async syncAll(): Promise<void> {
    const rows = await ProjectRepo.findAll({ attributes: ["projectId"] });
    const ids = [...new Set(rows.map((r) => r.projectId))];
    for (const id of ids) {
      await this.syncProject(id).catch((err) =>
        console.error(`[commits-sync] project ${id}:`, err),
      );
    }
  },

  // Per-member commit activity on a project over the last `days` days —
  // powers the project page feed and the "this person is working" signal.
  async activity(projectId: string, days = 30) {
    const since = new Date(Date.now() - days * 86400_000);
    const rows = await ProjectCommit.findAll({
      where: { projectId, committedAt: { [Op.gte]: since } },
      order: [["committedAt", "DESC"]],
    });

    // Resolve names for matched authors.
    const userIds = [...new Set(rows.map((r) => r.authorUserId).filter((v): v is string => !!v))];
    const users = userIds.length
      ? await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ["id", "name"] })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    const counts = new Map<string, { commits: number; lastCommitAt: Date | null }>();
    for (const r of rows) {
      if (!r.authorUserId) continue;
      const cur = counts.get(r.authorUserId) ?? { commits: 0, lastCommitAt: null };
      cur.commits += 1;
      if (!cur.lastCommitAt || (r.committedAt && r.committedAt > cur.lastCommitAt)) {
        cur.lastCommitAt = r.committedAt;
      }
      counts.set(r.authorUserId, cur);
    }

    return {
      since: since.toISOString(),
      total: rows.length,
      members: [...counts.entries()]
        .map(([userId, c]) => ({
          userId,
          name: nameOf.get(userId) ?? "Unknown",
          commits: c.commits,
          lastCommitAt: c.lastCommitAt ? c.lastCommitAt.toISOString() : null,
        }))
        .sort((a, b) => b.commits - a.commits),
      recent: rows.slice(0, 30).map((r) => ({
        sha: r.sha.slice(0, 7),
        message: r.message,
        repo: r.repoFullName,
        authorUserId: r.authorUserId,
        authorName: r.authorUserId
          ? (nameOf.get(r.authorUserId) ?? null)
          : r.authorName || r.authorLogin || null,
        committedAt: r.committedAt ? r.committedAt.toISOString() : null,
        url: r.url,
      })),
    };
  },
};