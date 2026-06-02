import { PullRequest } from "../../models";
import { statusFromWebhook } from "../../lib/github";

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

export const githubService = {
  // Update any linked PullRequest records (by URL) when GitHub reports a change.
  async handlePullRequestEvent(payload: PullRequestEvent): Promise<number> {
    const pr = payload.pull_request;
    if (!pr?.html_url) return 0;
    const status = statusFromWebhook({ state: pr.state ?? "open", draft: pr.draft, merged: pr.merged });
    const [count] = await PullRequest.update(
      { status, ...(pr.title ? { title: pr.title } : {}) },
      { where: { url: pr.html_url } },
    );
    return count;
  },
};
