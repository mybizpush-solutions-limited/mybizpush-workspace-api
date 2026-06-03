import { PullRequest } from "../../models";
import { parsePrUrl, statusFromWebhook } from "../../lib/github";
import { getPrChecks, getPrReviews } from "../../lib/github.features";

interface PullRequestEvent {
  action?: string;
  pull_request?: {
    html_url?: string;
    title?: string;
    state?: string;
    draft?: boolean;
    merged?: boolean;
    number?: number;
  };
}

interface ReviewEvent {
  pull_request?: { html_url?: string };
}

interface CheckEvent {
  check_run?: { head_sha?: string };
  check_suite?: { head_sha?: string };
  sha?: string; // `status` event
}

// Refresh cached CI + review state for one linked PR row from its URL.
async function enrich(pr: PullRequest): Promise<void> {
  const parsed = parsePrUrl(pr.url);
  if (!parsed) return;
  const [checks, reviews] = await Promise.all([
    getPrChecks(parsed.owner, parsed.repo, parsed.number),
    getPrReviews(parsed.owner, parsed.repo, parsed.number),
  ]);
  pr.checkState = checks.state;
  pr.reviewDecision = reviews.decision;
  if (checks.headSha) pr.headSha = checks.headSha;
  await pr.save();
}

export const githubService = {
  enrich,

  // Refresh every locally-linked row that points at a PR URL.
  async enrichByUrl(url: string): Promise<number> {
    const rows = await PullRequest.findAll({ where: { url } });
    await Promise.all(rows.map(enrich));
    return rows.length;
  },

  // pull_request: update status/title, then refresh CI + reviews + head sha.
  async handlePullRequestEvent(payload: PullRequestEvent): Promise<number> {
    const pr = payload.pull_request;
    if (!pr?.html_url) return 0;
    const status = statusFromWebhook({ state: pr.state ?? "open", draft: pr.draft, merged: pr.merged });
    const rows = await PullRequest.findAll({ where: { url: pr.html_url } });
    await Promise.all(
      rows.map(async (row) => {
        row.status = status;
        if (pr.title) row.title = pr.title;
        await row.save();
        await enrich(row);
      }),
    );
    return rows.length;
  },

  // pull_request_review: refresh the review decision on linked rows.
  async handleReviewEvent(payload: ReviewEvent): Promise<number> {
    const url = payload.pull_request?.html_url;
    if (!url) return 0;
    return this.enrichByUrl(url);
  },

  // check_run / check_suite / status: refresh CI state for rows on that head sha.
  async handleCheckEvent(payload: CheckEvent): Promise<number> {
    const sha = payload.check_run?.head_sha ?? payload.check_suite?.head_sha ?? payload.sha;
    if (!sha) return 0;
    const rows = await PullRequest.findAll({ where: { headSha: sha } });
    await Promise.all(rows.map(enrich));
    return rows.length;
  },
};
