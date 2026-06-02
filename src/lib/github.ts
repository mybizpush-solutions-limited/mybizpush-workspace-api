import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./errors";
import { GithubAccount } from "../models";

export type PrStatus = "open" | "merged" | "closed" | "draft";

export interface GithubPr {
  number: number;
  title: string;
  url: string;
  status: PrStatus;
  authorLogin: string | null;
  updatedAt?: string;
}

export interface GithubRepo {
  owner: string;
  repo: string;
  fullName: string;
  htmlUrl: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mybizpush-dev-space",
  };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;
const REPO_URL_RE = /github\.com\/([^/]+)\/([^/#?]+)/i;

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(PR_URL_RE);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

// Accept a full GitHub URL or a plain "owner/repo" slug.
export function parseRepoInput(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  const url = trimmed.match(REPO_URL_RE);
  if (url) return { owner: url[1]!, repo: url[2]! };
  const slug = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slug) return { owner: slug[1]!, repo: slug[2]! };
  return null;
}

function statusFromPr(pr: { state: string; draft?: boolean; merged_at?: string | null; merged?: boolean }): PrStatus {
  if (pr.merged || pr.merged_at) return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.draft) return "draft";
  return "open";
}

// Fetch a single PR's metadata (used when linking a PR to a work item).
export async function fetchPullRequest(url: string): Promise<GithubPr | null> {
  const parsed = parsePrUrl(url);
  if (!parsed) return null;
  try {
    const res = await fetch(
      `${env.GITHUB_API_URL}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
      { headers: headers() },
    );
    if (!res.ok) return null;
    const pr = (await res.json()) as {
      number: number; title: string; html_url: string; state: string;
      draft?: boolean; merged_at?: string | null; user?: { login?: string }; updated_at?: string;
    };
    return {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      status: statusFromPr(pr),
      authorLogin: pr.user?.login ?? null,
      updatedAt: pr.updated_at,
    };
  } catch {
    return null;
  }
}

// Look up repo metadata (used to validate a repo before linking it to a project).
export async function getRepo(owner: string, repo: string): Promise<GithubRepo | null> {
  try {
    const res = await fetch(`${env.GITHUB_API_URL}/repos/${owner}/${repo}`, { headers: headers() });
    if (!res.ok) return null;
    const r = (await res.json()) as {
      name: string; full_name: string; html_url: string; description: string | null;
      private: boolean; default_branch: string; owner: { login: string };
    };
    return {
      owner: r.owner.login,
      repo: r.name,
      fullName: r.full_name,
      htmlUrl: r.html_url,
      description: r.description,
      private: r.private,
      defaultBranch: r.default_branch,
    };
  } catch {
    return null;
  }
}

// List a repo's open PRs (used for the project's "open pull requests" view).
export async function listOpenPullRequests(owner: string, repo: string): Promise<GithubPr[]> {
  try {
    const res = await fetch(
      `${env.GITHUB_API_URL}/repos/${owner}/${repo}/pulls?state=open&per_page=30&sort=updated&direction=desc`,
      { headers: headers() },
    );
    if (!res.ok) return [];
    const arr = (await res.json()) as Array<{
      number: number; title: string; html_url: string; state: string;
      draft?: boolean; user?: { login?: string }; updated_at?: string;
    }>;
    return arr.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      status: statusFromPr(pr),
      authorLogin: pr.user?.login ?? null,
      updatedAt: pr.updated_at,
    }));
  } catch {
    return [];
  }
}

// Map a webhook pull_request payload to our status enum.
export function statusFromWebhook(pr: { state: string; draft?: boolean; merged?: boolean }): PrStatus {
  return statusFromPr(pr);
}

// Verify a GitHub webhook's HMAC-SHA256 signature (X-Hub-Signature-256).
export function verifyWebhookSignature(raw: Buffer, signature: string | undefined): boolean {
  if (!env.GITHUB_WEBHOOK_SECRET || !signature) return false;
  const digest = `sha256=${createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(raw).digest("hex")}`;
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Per-user OAuth --------------------------------------------------------
// read:user → profile; read:org → verify membership of the configured org.
export const GITHUB_OAUTH_SCOPES = ["read:user", "read:org"];

export function isOAuthConfigured(): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

function assertOAuthConfigured(): void {
  if (!isOAuthConfigured()) {
    throw new AppError(503, "GitHub integration is not configured", "github_unconfigured");
  }
}

// Build the GitHub consent URL for the connect flow.
export function getOAuthUrl(state: string): string {
  assertOAuthConfigured();
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.GITHUB_OAUTH_REDIRECT_URI,
    scope: GITHUB_OAUTH_SCOPES.join(" "),
    state,
    allow_signup: "false",
  });
  return `${env.GITHUB_OAUTH_BASE_URL}/authorize?${params.toString()}`;
}

function userHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mybizpush-dev-space",
    Authorization: `Bearer ${token}`,
  };
}

// Check whether the token's owner is an active member of the configured org.
// Returns false if no org is configured or the user isn't a member.
async function checkOrgMembership(token: string): Promise<boolean> {
  if (!env.GITHUB_ORG) return false;
  try {
    const res = await fetch(`${env.GITHUB_API_URL}/user/memberships/orgs/${env.GITHUB_ORG}`, {
      headers: userHeaders(token),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { state?: string };
    return data.state === "active";
  } catch {
    return false;
  }
}

// Exchange the auth code for an access token, resolve the GitHub identity +
// org membership, and persist it all for the user.
export async function exchangeOAuthCodeAndStore(userId: string, code: string): Promise<void> {
  assertOAuthConfigured();

  const tokenRes = await fetch(`${env.GITHUB_OAUTH_BASE_URL}/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.GITHUB_OAUTH_REDIRECT_URI,
    }),
  });
  const token = (await tokenRes.json()) as {
    access_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !token.access_token) {
    throw new AppError(502, token.error_description ?? "GitHub token exchange failed", "github_oauth_failed");
  }

  // Resolve the connected identity (login, id, name, avatar).
  let githubId: string | null = null;
  let login: string | null = null;
  let name: string | null = null;
  let avatarUrl: string | null = null;
  try {
    const meRes = await fetch(`${env.GITHUB_API_URL}/user`, { headers: userHeaders(token.access_token) });
    if (meRes.ok) {
      const me = (await meRes.json()) as { id?: number; login?: string; name?: string; avatar_url?: string };
      githubId = me.id != null ? String(me.id) : null;
      login = me.login ?? null;
      name = me.name ?? null;
      avatarUrl = me.avatar_url ?? null;
    }
  } catch {
    /* non-fatal — store the connection without identity details */
  }

  const orgMember = await checkOrgMembership(token.access_token);

  await GithubAccount.upsert({
    userId,
    githubId,
    login,
    name,
    avatarUrl,
    accessToken: token.access_token,
    scope: token.scope ?? null,
    tokenType: token.token_type ?? null,
    orgMember,
  });
}
