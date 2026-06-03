import { ProjectRepo } from "../../models";
import { badRequest, notFound } from "../../lib/errors";
import { getRepo, listOpenPullRequests, parseRepoInput } from "../../lib/github";

function serialize(r: ProjectRepo) {
  return {
    id: r.id,
    owner: r.owner,
    repo: r.repo,
    fullName: r.fullName,
    htmlUrl: r.htmlUrl ?? null,
    description: r.description ?? null,
    isPrivate: r.isPrivate,
    createdAt: r.createdAt.toISOString(),
  };
}

export const projectReposService = {
  async list(projectId: string) {
    const rows = await ProjectRepo.findAll({ where: { projectId }, order: [["fullName", "ASC"]] });
    return rows.map(serialize);
  },

  // Link a repo (by URL or "owner/repo"). Validated against GitHub before saving.
  async add(projectId: string, input: string, userId: string) {
    const parsed = parseRepoInput(input);
    if (!parsed) throw badRequest("Enter a GitHub repo URL or owner/repo");

    const meta = await getRepo(parsed.owner, parsed.repo);
    if (!meta) {
      throw badRequest("Repo not found or not accessible (install the GitHub App on this repo)");
    }

    const existing = await ProjectRepo.findOne({ where: { projectId, fullName: meta.fullName } });
    if (existing) return serialize(existing);

    const created = await ProjectRepo.create({
      projectId,
      owner: meta.owner,
      repo: meta.repo,
      fullName: meta.fullName,
      htmlUrl: meta.htmlUrl,
      description: meta.description,
      isPrivate: meta.private,
      addedBy: userId,
    });
    return serialize(created);
  },

  async remove(projectId: string, repoId: string) {
    const row = await ProjectRepo.findOne({ where: { id: repoId, projectId } });
    if (!row) throw notFound("Repo not linked to this project");
    await row.destroy();
  },

  // Open PRs across all of the project's linked repos (live from GitHub).
  async pullRequests(projectId: string) {
    const repos = await ProjectRepo.findAll({ where: { projectId } });
    const lists = await Promise.all(
      repos.map(async (r) => {
        const prs = await listOpenPullRequests(r.owner, r.repo);
        return prs.map((pr) => ({ ...pr, repoFullName: r.fullName }));
      }),
    );
    return lists.flat().sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  },
};
