import { env } from "../config/env";

export interface GithubPr {
  number: number;
  title: string;
  url: string;
  status: "open" | "merged" | "closed" | "draft";
  authorLogin: string | null;
}

const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(PR_URL_RE);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

// Fetch real PR metadata from GitHub. Returns null if the URL isn't a PR URL or
// the request fails (so linking still works with the caller-provided data).
export async function fetchPullRequest(url: string): Promise<GithubPr | null> {
  const parsed = parsePrUrl(url);
  if (!parsed) return null;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mybizpush-dev-space",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  try {
    const res = await fetch(
      `${env.GITHUB_API_URL}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
      { headers },
    );
    if (!res.ok) return null;
    const pr = (await res.json()) as {
      number: number;
      title: string;
      html_url: string;
      state: string;
      draft?: boolean;
      merged_at?: string | null;
      user?: { login?: string };
    };

    let status: GithubPr["status"] = "open";
    if (pr.merged_at) status = "merged";
    else if (pr.state === "closed") status = "closed";
    else if (pr.draft) status = "draft";

    return {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      status,
      authorLogin: pr.user?.login ?? null,
    };
  } catch {
    return null;
  }
}
