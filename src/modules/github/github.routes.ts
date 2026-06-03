import { Router } from "express";
import { z } from "zod";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAuth, requireAccessLevel } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { env } from "../../config/env";
import { verifyWebhookSignature } from "../../lib/github";
import {
  addLabels,
  createIssue,
  createIssueComment,
  listBranches,
  listCommits,
  listOrgRepos,
  listOrgMembers,
  listTeams,
  searchUserOpenPrs,
} from "../../lib/github.features";
import { GithubAccount } from "../../models";
import { githubService } from "./github.service";
import { githubOauthService } from "./github.oauth.service";
import { githubSyncService } from "./github.sync.service";

export const githubRouter = Router();

// ---- Per-user OAuth (connect / status / disconnect) -----------------------
// Start the connect flow — returns the GitHub consent URL for the current user.
githubRouter.get(
  "/auth-url",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ url: await githubOauthService.createAuthUrl(req.auth!.sub) });
  }),
);

githubRouter.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await githubOauthService.status(req.auth!.sub));
  }),
);

githubRouter.post(
  "/disconnect",
  requireAuth,
  asyncHandler(async (req, res) => {
    await githubOauthService.disconnect(req.auth!.sub);
    res.status(204).end();
  }),
);

// ---- Org-wide reads (installation token) ----------------------------------
// Repo discovery for the "link a repo" picker.
githubRouter.get(
  "/repos",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ repos: await listOrgRepos() });
  }),
);

// The caller's own open PRs across the org (dashboard widget).
githubRouter.get(
  "/my-pull-requests",
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = await GithubAccount.findByPk(req.auth!.sub);
    if (!account?.login) return res.json({ pullRequests: [], connected: false });
    res.json({ pullRequests: await searchUserOpenPrs(account.login), connected: true });
  }),
);

githubRouter.get(
  "/members",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ members: await listOrgMembers() });
  }),
);

githubRouter.get(
  "/teams",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ teams: await listTeams() });
  }),
);

// Provision departments + members from org teams (executive admins only).
githubRouter.post(
  "/sync-teams",
  requireAuth,
  requireAccessLevel("executive_admin"),
  asyncHandler(async (_req, res) => {
    res.json(await githubSyncService.syncTeams());
  }),
);

githubRouter.get(
  "/repos/:owner/:repo/branches",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ branches: await listBranches(req.params.owner!, req.params.repo!) });
  }),
);

githubRouter.get(
  "/repos/:owner/:repo/commits",
  requireAuth,
  asyncHandler(async (req, res) => {
    const sha = typeof req.query.sha === "string" ? req.query.sha : undefined;
    res.json({ commits: await listCommits(req.params.owner!, req.params.repo!, { sha }) });
  }),
);

// ---- Bot write actions (need Pull requests / Issues: Read & write) ---------
const commentSchema = z.object({ body: z.string().trim().min(1).max(65536) });
const labelsSchema = z.object({ labels: z.array(z.string().trim().min(1)).min(1) });
const issueSchema = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(65536).optional(),
  labels: z.array(z.string().trim().min(1)).optional(),
});

githubRouter.post(
  "/repos/:owner/:repo/issues/:number/comment",
  requireAuth,
  validateBody(commentSchema),
  asyncHandler(async (req, res) => {
    const ok = await createIssueComment(req.params.owner!, req.params.repo!, Number(req.params.number), req.body.body);
    if (!ok) throw badRequest("Couldn't post the comment (check the App's write permission)");
    res.status(201).json({ ok: true });
  }),
);

githubRouter.post(
  "/repos/:owner/:repo/issues/:number/labels",
  requireAuth,
  validateBody(labelsSchema),
  asyncHandler(async (req, res) => {
    const ok = await addLabels(req.params.owner!, req.params.repo!, Number(req.params.number), req.body.labels);
    if (!ok) throw badRequest("Couldn't add labels (check the App's write permission)");
    res.status(201).json({ ok: true });
  }),
);

githubRouter.post(
  "/repos/:owner/:repo/issues",
  requireAuth,
  validateBody(issueSchema),
  asyncHandler(async (req, res) => {
    const issue = await createIssue(req.params.owner!, req.params.repo!, req.body);
    if (!issue) throw badRequest("Couldn't create the issue (check the App's write permission)");
    res.status(201).json({ issue });
  }),
);

// OAuth redirect target — hit by GitHub in the browser (no JWT); uses `state`.
githubRouter.get(
  "/callback",
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    try {
      await githubOauthService.handleCallback(code, state);
      res.redirect(`${env.APP_URL}/profile?github=connected`);
    } catch {
      res.redirect(`${env.APP_URL}/profile?github=error`);
    }
  }),
);

// ---- Inbound webhooks. No auth — verified by the HMAC signature instead. ----
githubRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.header("X-Hub-Signature-256");
    if (!raw || !verifyWebhookSignature(raw, signature)) {
      return res.status(401).json({ error: { code: "invalid_signature", message: "Invalid webhook signature" } });
    }

    const event = req.header("X-GitHub-Event");
    switch (event) {
      case "ping":
        return res.json({ ok: true });
      case "pull_request":
        return res.json({ ok: true, updated: await githubService.handlePullRequestEvent(req.body) });
      case "pull_request_review":
        return res.json({ ok: true, updated: await githubService.handleReviewEvent(req.body) });
      case "check_run":
      case "check_suite":
      case "status":
        return res.json({ ok: true, updated: await githubService.handleCheckEvent(req.body) });
      case "issues":
        return res.json({ ok: true, updated: await githubSyncService.handleIssueWebhook(req.body) });
      default:
        // push / issue_comment / release / deployment / member / team
        // are surfaced through live-read endpoints, so we just acknowledge them.
        return res.json({ ok: true, ignored: event });
    }
  }),
);
