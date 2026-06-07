// Extended GitHub App capabilities: org repo discovery, branches/commits, CI
// checks, PR reviews, issues, releases, deployments, cross-org PR search, org
// members/teams, and bot write actions. All authenticate with the org
// installation token via ghFetch/ghJson and degrade gracefully (null/[]).
import { env } from "../config/env";
import { ghFetch, ghJson, listInstalledOrgs } from "./github";

const ORG = () => env.GITHUB_ORG;

// ---- Repository discovery --------------------------------------------------
export interface OrgRepo {
  owner: string;
  repo: string;
  fullName: string;
  htmlUrl: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  pushedAt: string | null;
}

interface RawRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  language: string | null;
  pushed_at: string | null;
  owner: { login: string };
}

function mapRepo(r: RawRepo): OrgRepo {
  return {
    owner: r.owner.login,
    repo: r.name,
    fullName: r.full_name,
    htmlUrl: r.html_url,
    description: r.description,
    private: r.private,
    defaultBranch: r.default_branch,
    language: r.language,
    pushedAt: r.pushed_at,
  };
}

// Every repo the App can see across all installed orgs (for the link picker).
export async function listOrgRepos(): Promise<OrgRepo[]> {
  const orgs = await listInstalledOrgs();
  const lists = await Promise.all(
    orgs.map((org) => ghJson<RawRepo[]>(`/orgs/${org}/repos?per_page=100&sort=pushed&direction=desc`)),
  );
  return lists.flatMap((arr) => arr ?? []).map(mapRepo);
}

// ---- Branches & commits ----------------------------------------------------
export interface Branch {
  name: string;
  sha: string;
  protected: boolean;
}

export async function listBranches(owner: string, repo: string): Promise<Branch[]> {
  const arr = await ghJson<Array<{ name: string; commit: { sha: string }; protected: boolean }>>(
    `/repos/${owner}/${repo}/branches?per_page=100`,
  );
  return (arr ?? []).map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected }));
}

export interface Commit {
  sha: string;
  message: string;
  url: string;
  authorName: string | null;
  authorLogin: string | null;
  date: string | null;
}

export async function listCommits(
  owner: string,
  repo: string,
  opts: { sha?: string; perPage?: number } = {},
): Promise<Commit[]> {
  const params = new URLSearchParams({ per_page: String(opts.perPage ?? 20) });
  if (opts.sha) params.set("sha", opts.sha);
  const arr = await ghJson<
    Array<{
      sha: string;
      html_url: string;
      commit: { message: string; author?: { name?: string; date?: string } };
      author?: { login?: string } | null;
    }>
  >(`/repos/${owner}/${repo}/commits?${params.toString()}`);
  return (arr ?? []).map((c) => ({
    sha: c.sha,
    message: c.commit.message.split("\n")[0] ?? c.commit.message,
    url: c.html_url,
    authorName: c.commit.author?.name ?? null,
    authorLogin: c.author?.login ?? null,
    date: c.commit.author?.date ?? null,
  }));
}

// ---- CI / checks -----------------------------------------------------------
export type CheckState = "success" | "failure" | "pending" | "neutral" | "none";
export interface ChecksSummary {
  state: CheckState;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  headSha: string | null;
}

const FAIL_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);

// Aggregate check-runs + the legacy combined commit status for a PR's head.
export async function getPrChecks(owner: string, repo: string, number: number): Promise<ChecksSummary> {
  const empty: ChecksSummary = { state: "none", total: 0, passed: 0, failed: 0, pending: 0, headSha: null };
  const pr = await ghJson<{ head?: { sha?: string } }>(`/repos/${owner}/${repo}/pulls/${number}`);
  const sha = pr?.head?.sha;
  if (!sha) return empty;

  const runs = await ghJson<{
    total_count: number;
    check_runs: Array<{ status: string; conclusion: string | null }>;
  }>(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`);
  const combined = await ghJson<{ state: string; total_count: number }>(
    `/repos/${owner}/${repo}/commits/${sha}/status`,
  );

  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const r of runs?.check_runs ?? []) {
    if (r.status !== "completed") pending += 1;
    else if (r.conclusion && FAIL_CONCLUSIONS.has(r.conclusion)) failed += 1;
    else passed += 1;
  }
  // Fold in the legacy combined commit-status — but ONLY when it actually has
  // statuses. GitHub returns state:"pending" for a commit with zero statuses,
  // which is the norm for repos that use the Checks API (GitHub Actions) and no
  // legacy commit statuses. Counting that would pin every PR to "pending"
  // forever even after all check-runs complete.
  if ((combined?.total_count ?? 0) > 0) {
    if (combined!.state === "failure" || combined!.state === "error") failed += 1;
    else if (combined!.state === "pending") pending += 1;
    else if (combined!.state === "success") passed += 1;
  }

  const total = passed + failed + pending;
  const state: CheckState =
    total === 0 ? "none" : failed > 0 ? "failure" : pending > 0 ? "pending" : "success";
  return { state, total, passed, failed, pending, headSha: sha };
}

// ---- PR reviews ------------------------------------------------------------
export type ReviewDecision = "approved" | "changes_requested" | "commented" | "none";
export interface ReviewsSummary {
  decision: ReviewDecision;
  approved: number;
  changesRequested: number;
  reviewers: Array<{ login: string; state: string }>;
}

// Latest review state per reviewer → an overall decision.
export async function getPrReviews(owner: string, repo: string, number: number): Promise<ReviewsSummary> {
  const arr = await ghJson<Array<{ user?: { login?: string }; state: string; submitted_at?: string }>>(
    `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
  );
  const latest = new Map<string, string>();
  for (const r of arr ?? []) {
    const login = r.user?.login;
    if (!login) continue;
    if (r.state === "COMMENTED") continue; // comments don't override approval state
    latest.set(login, r.state);
  }
  const reviewers = [...latest.entries()].map(([login, state]) => ({ login, state }));
  const approved = reviewers.filter((r) => r.state === "APPROVED").length;
  const changesRequested = reviewers.filter((r) => r.state === "CHANGES_REQUESTED").length;
  const decision: ReviewDecision =
    changesRequested > 0 ? "changes_requested" : approved > 0 ? "approved" : reviewers.length ? "commented" : "none";
  return { decision, approved, changesRequested, reviewers };
}

// ---- Issues ----------------------------------------------------------------
export interface GithubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  authorLogin: string | null;
  labels: string[];
  body: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  user?: { login?: string };
  labels?: Array<{ name?: string } | string>;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
  pull_request?: unknown; // present when the "issue" is actually a PR
}

function mapIssue(i: RawIssue): GithubIssue {
  return {
    number: i.number,
    title: i.title,
    url: i.html_url,
    state: i.state,
    authorLogin: i.user?.login ?? null,
    labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    body: i.body ?? null,
    createdAt: i.created_at ?? null,
    updatedAt: i.updated_at ?? null,
  };
}

export async function listIssues(
  owner: string,
  repo: string,
  opts: { state?: "open" | "closed" | "all" } = {},
): Promise<GithubIssue[]> {
  const arr = await ghJson<RawIssue[]>(
    `/repos/${owner}/${repo}/issues?state=${opts.state ?? "open"}&per_page=50&sort=updated`,
  );
  return (arr ?? []).filter((i) => !i.pull_request).map(mapIssue); // exclude PRs
}

export async function getIssue(owner: string, repo: string, number: number): Promise<GithubIssue | null> {
  const i = await ghJson<RawIssue>(`/repos/${owner}/${repo}/issues/${number}`);
  return i ? mapIssue(i) : null;
}

// ---- Releases & deployments ------------------------------------------------
export interface Release {
  id: number;
  name: string;
  tag: string;
  url: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  authorLogin: string | null;
}

export async function listReleases(owner: string, repo: string): Promise<Release[]> {
  const arr = await ghJson<
    Array<{
      id: number;
      name: string | null;
      tag_name: string;
      html_url: string;
      draft: boolean;
      prerelease: boolean;
      published_at: string | null;
      author?: { login?: string };
    }>
  >(`/repos/${owner}/${repo}/releases?per_page=20`);
  return (arr ?? []).map((r) => ({
    id: r.id,
    name: r.name || r.tag_name,
    tag: r.tag_name,
    url: r.html_url,
    draft: r.draft,
    prerelease: r.prerelease,
    publishedAt: r.published_at,
    authorLogin: r.author?.login ?? null,
  }));
}

export interface Deployment {
  id: number;
  environment: string;
  ref: string;
  url: string;
  state: string | null;
  createdAt: string | null;
  creatorLogin: string | null;
}

export async function listDeployments(owner: string, repo: string): Promise<Deployment[]> {
  const arr = await ghJson<
    Array<{
      id: number;
      environment: string;
      ref: string;
      statuses_url: string;
      created_at: string;
      creator?: { login?: string };
    }>
  >(`/repos/${owner}/${repo}/deployments?per_page=20`);
  // Resolve each deployment's latest status (best-effort, in parallel).
  return Promise.all(
    (arr ?? []).map(async (d) => {
      const statuses = await ghJson<Array<{ state: string }>>(
        `/repos/${owner}/${repo}/deployments/${d.id}/statuses?per_page=1`,
      );
      return {
        id: d.id,
        environment: d.environment,
        ref: d.ref,
        url: `https://github.com/${owner}/${repo}/deployments`,
        state: statuses?.[0]?.state ?? null,
        createdAt: d.created_at,
        creatorLogin: d.creator?.login ?? null,
      };
    }),
  );
}

// ---- Cross-org PR search ("my open PRs") -----------------------------------
export interface SearchPr {
  number: number;
  title: string;
  url: string;
  repoFullName: string;
  draft: boolean;
  updatedAt: string | null;
}

interface RawSearchPr {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  draft?: boolean;
  updated_at?: string;
}

export async function searchUserOpenPrs(login: string): Promise<SearchPr[]> {
  if (!login) return [];
  // Search each installed org with that org's installation token, then merge —
  // the Search API is scoped to repos the token can see, so one token won't span
  // multiple orgs.
  const orgs = await listInstalledOrgs();
  const targets = orgs.length ? orgs : ORG() ? [ORG()] : [];
  const lists = await Promise.all(
    targets.map((org) =>
      ghJson<{ items: RawSearchPr[] }>(
        `/search/issues?q=is:pr+is:open+author:${encodeURIComponent(login)}+org:${org}&per_page=30&sort=updated`,
        undefined,
        org,
      ),
    ),
  );
  const seen = new Set<string>();
  const out: SearchPr[] = [];
  for (const data of lists) {
    for (const i of data?.items ?? []) {
      if (seen.has(i.html_url)) continue;
      seen.add(i.html_url);
      out.push({
        number: i.number,
        title: i.title,
        url: i.html_url,
        repoFullName: i.repository_url.replace(/^.*\/repos\//, ""),
        draft: Boolean(i.draft),
        updatedAt: i.updated_at ?? null,
      });
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

// ---- Org members & teams ---------------------------------------------------
export interface OrgMember {
  login: string;
  id: number;
  avatarUrl: string;
}

export async function listOrgMembers(): Promise<OrgMember[]> {
  if (!ORG()) return [];
  const arr = await ghJson<Array<{ login: string; id: number; avatar_url: string }>>(
    `/orgs/${ORG()}/members?per_page=100`,
  );
  return (arr ?? []).map((m) => ({ login: m.login, id: m.id, avatarUrl: m.avatar_url }));
}

export interface Team {
  slug: string;
  name: string;
  description: string | null;
  memberLogins: string[];
}

export async function listTeams(): Promise<Team[]> {
  if (!ORG()) return [];
  const teams = await ghJson<Array<{ slug: string; name: string; description: string | null }>>(
    `/orgs/${ORG()}/teams?per_page=100`,
  );
  return Promise.all(
    (teams ?? []).map(async (t) => {
      const members = await ghJson<Array<{ login: string }>>(
        `/orgs/${ORG()}/teams/${t.slug}/members?per_page=100`,
      );
      return {
        slug: t.slug,
        name: t.name,
        description: t.description,
        memberLogins: (members ?? []).map((m) => m.login),
      };
    }),
  );
}

// ---- Bot write actions (need Pull requests / Issues: Read & write) ----------
// Posts a comment; returns the new GitHub comment id (or null on failure).
export async function createIssueComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<number | null> {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id?: number };
  return data.id ?? null;
}

export async function addLabels(
  owner: string,
  repo: string,
  number: number,
  labels: string[],
): Promise<boolean> {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels }),
  });
  return res.ok;
}

export async function createIssue(
  owner: string,
  repo: string,
  input: { title: string; body?: string; labels?: string[] },
): Promise<GithubIssue | null> {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  return mapIssue((await res.json()) as RawIssue);
}

// Open or close a GitHub issue (used to push app-issue status back to GitHub).
export async function setIssueState(
  owner: string,
  repo: string,
  number: number,
  state: "open" | "closed",
): Promise<boolean> {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  return res.ok;
}
