import { createHmac, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
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

const BASE_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "mybizpush-dev-space",
} as const;

// ---- GitHub App authentication (org-wide installation token) ---------------
// The App proves its identity with a short-lived RS256 JWT, which it exchanges
// for an installation access token scoped to the org install. That token reads
// every repo the App can see — no personal access token required.

export function isAppConfigured(): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

// Accept a PEM with literal "\n" escapes (single-line .env) or a base64 blob.
function appPrivateKey(): string {
  const raw = env.GITHUB_APP_PRIVATE_KEY;
  if (raw.includes("BEGIN")) return raw.replace(/\\n/g, "\n");
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return raw;
  }
}

// Sign the App JWT (max 10 min; we use ~9 with a 60s backdated iat for clock skew).
function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }, appPrivateKey(), {
    algorithm: "RS256",
  });
}

let installationId: string | null = env.GITHUB_APP_INSTALLATION_ID || null;

// Resolve the installation id from the org (cached after first lookup).
async function resolveInstallationId(appToken: string): Promise<string> {
  if (installationId) return installationId;
  if (!env.GITHUB_ORG) {
    throw new AppError(503, "Set GITHUB_ORG or GITHUB_APP_INSTALLATION_ID for the GitHub App", "github_app_unconfigured");
  }
  const res = await fetch(`${env.GITHUB_API_URL}/orgs/${env.GITHUB_ORG}/installation`, {
    headers: { ...BASE_HEADERS, Authorization: `Bearer ${appToken}` },
  });
  if (!res.ok) {
    throw new AppError(502, "GitHub App is not installed on the org", "github_app_not_installed");
  }
  const data = (await res.json()) as { id?: number };
  installationId = String(data.id);
  return installationId;
}

let cachedToken: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;

// Mint (and cache) an installation access token. ~1h lifetime; refreshed with a
// 60s safety margin. A single in-flight promise prevents a request stampede.
async function getInstallationToken(): Promise<string | null> {
  if (!isAppConfigured()) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.token;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const appToken = appJwt();
    const id = await resolveInstallationId(appToken);
    const res = await fetch(`${env.GITHUB_API_URL}/app/installations/${id}/access_tokens`, {
      method: "POST",
      headers: { ...BASE_HEADERS, Authorization: `Bearer ${appToken}` },
    });
    if (!res.ok) {
      throw new AppError(502, "Failed to mint a GitHub App installation token", "github_app_token_failed");
    }
    const data = (await res.json()) as { token: string; expires_at: string };
    cachedToken = { token: data.token, expiresAt: Math.floor(Date.parse(data.expires_at) / 1000) };
    return data.token;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

// Headers for org-wide reads: authenticate with the App installation token when
// available, else go unauthenticated (public repos / low rate limit).
async function readHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = { ...BASE_HEADERS };
  let token: string | null = null;
  try {
    token = await getInstallationToken();
  } catch {
    token = null; // App not configured / unreachable — fall back to unauthenticated
  }
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Generic authed request against the GitHub REST API (installation token).
export async function ghFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = { ...(await readHeaders()), ...((init?.headers as Record<string, string>) ?? {}) };
  return fetch(`${env.GITHUB_API_URL}${path}`, { ...init, headers });
}

// GET + parse JSON, or null on any non-2xx / error (callers degrade gracefully).
export async function ghJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await ghFetch(path, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
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
      { headers: await readHeaders() },
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
    const res = await fetch(`${env.GITHUB_API_URL}/repos/${owner}/${repo}`, { headers: await readHeaders() });
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
      { headers: await readHeaders() },
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

// ---- User authorization (GitHub App "Connect GitHub") ----------------------
// The GitHub App also acts as the identity provider for the per-user connect
// flow. User-to-server tokens carry no classic scopes — access is governed by
// the App's configured user permissions — so the authorize URL omits `scope`.

export function isOAuthConfigured(): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

function assertOAuthConfigured(): void {
  if (!isOAuthConfigured()) {
    throw new AppError(503, "GitHub integration is not configured", "github_unconfigured");
  }
}

// Build the GitHub App user-authorization URL for the connect flow.
export function getOAuthUrl(state: string): string {
  assertOAuthConfigured();
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.GITHUB_OAUTH_REDIRECT_URI,
    state,
    allow_signup: "false",
  });
  return `${env.GITHUB_OAUTH_BASE_URL}/authorize?${params.toString()}`;
}

function userHeaders(token: string): Record<string, string> {
  return { ...BASE_HEADERS, Authorization: `Bearer ${token}` };
}

// Is `login` an active member of the configured org? With the App installed we
// check via the installation token (org Members: read) — independent of what
// the user granted. Falls back to the user token's own membership endpoint.
async function checkOrgMembership(login: string | null, userToken: string): Promise<boolean> {
  if (!env.GITHUB_ORG) return false;
  try {
    const appToken = await getInstallationToken();
    if (appToken && login) {
      const res = await fetch(`${env.GITHUB_API_URL}/orgs/${env.GITHUB_ORG}/members/${login}`, {
        headers: { ...BASE_HEADERS, Authorization: `Bearer ${appToken}` },
      });
      return res.status === 204; // 204 = member, 404 = not, 302 = requester not a member
    }
  } catch {
    /* fall through to the user-token check */
  }
  try {
    const res = await fetch(`${env.GITHUB_API_URL}/user/memberships/orgs/${env.GITHUB_ORG}`, {
      headers: userHeaders(userToken),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { state?: string };
    return data.state === "active";
  } catch {
    return false;
  }
}

// Exchange the auth code for a user token, resolve the GitHub identity +
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

  const orgMember = await checkOrgMembership(login, token.access_token);

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
