import { Router } from "express";
import { z } from "zod";
import { asyncHandler, badRequest, forbidden, notFound } from "../../lib/errors";
import { calendarOps, isGoogleConfigured } from "../../lib/google";
import { getRepo, isOAuthConfigured, listOpenPullRequests, parseRepoInput } from "../../lib/github";
import { listCommits } from "../../lib/github.features";
import { requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";
import { validateBody } from "../../middleware/validate";
import { EmailThreadLink, Meeting, Project, ProductRepo, ProjectRepo, THREAD_RECORD_TYPES } from "../../models";
import { can } from "../access/engine";
import { googleService } from "../google/google.service";
import { githubOauthService } from "../github/github.oauth.service";
import { syncHint } from "../shared/live";
import { gmailService } from "./gmail.service";

export const integrationsRouter = Router();
export const gmailRouter = Router();
integrationsRouter.use(requireAuth);
gmailRouter.use(requireAuth);

// ---- Summary (INT-01) ---------------------------------------------------------
integrationsRouter.get("/", asyncHandler(async (req, res) => {
  const userId = req.auth!.sub;
  const [google, gmail, github, linkedThreads, conflicts] = await Promise.all([
    googleService.status(userId),
    gmailService.status(userId),
    githubOauthService.status(userId),
    EmailThreadLink.count({ where: { linkedBy: userId } }),
    Meeting.count({ where: { organizerId: userId, syncState: "conflict" } }),
  ]);
  res.json({
    google: { configured: isGoogleConfigured(), connected: google.connected, email: google.email },
    gmail: { configured: isGoogleConfigured(), connected: gmail.connected, email: gmail.email, canRead: gmail.canRead, canSend: gmail.canSend, linkedThreads },
    github: { configured: isOAuthConfigured(), connected: github.connected, login: github.login, orgMember: github.orgMember, org: github.org },
    calendar: { organizerConfigured: calendarOps.isConfigured(), conflicts },
  });
}));

// ---- Gmail --------------------------------------------------------------------
const addresses = z.array(z.string().trim().email()).max(50);
const recordRef = { recordType: z.enum(THREAD_RECORD_TYPES), recordId: z.string().uuid() };
const threadId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

gmailRouter.get("/status", asyncHandler(async (req, res) => {
  res.json(await gmailService.status(req.auth!.sub));
}));
gmailRouter.post("/disconnect", asyncHandler(async (req, res) => {
  await gmailService.disconnect(req.auth!.sub);
  res.status(204).end();
}));
gmailRouter.get("/threads", asyncHandler(async (req, res) => {
  const q = z.object({ q: z.string().max(500).optional(), pageToken: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).parse(req.query);
  res.json(await gmailService.threads(req.auth!.sub, q));
}));
gmailRouter.get("/threads/:id", asyncHandler(async (req, res) => {
  res.json(await gmailService.thread(req.auth!.sub, threadId.parse(req.params.id)));
}));
gmailRouter.post("/threads/:id/task-draft", asyncHandler(async (req, res) => {
  res.json(await gmailService.taskDraft(req.auth!.sub, threadId.parse(req.params.id)));
}));
gmailRouter.post(
  "/send",
  rateLimit({ windowSec: 60, max: 30, keyPrefix: "gmail-send" }),
  validateBody(
    z.object({
      to: addresses.min(1),
      cc: addresses.optional(),
      bcc: addresses.optional(),
      subject: z.string().trim().min(1).max(500),
      body: z.string().min(1).max(200_000),
      html: z.boolean().optional(),
      threadId: threadId.optional(),
      inReplyToMessageId: threadId.optional(),
      link: z.object(recordRef).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.status(201).json(await gmailService.send(req.auth!.sub, req.body, req));
  }),
);
gmailRouter.post("/links", validateBody(z.object({ threadId, ...recordRef })), asyncHandler(async (req, res) => {
  const out = await gmailService.link(req.auth!.sub, req.body);
  res.status(out!.created ? 201 : 200).json({ link: out!.link });
}));
gmailRouter.get("/links", asyncHandler(async (req, res) => {
  res.json({ links: await gmailService.links(z.object(recordRef).parse(req.query)) });
}));
gmailRouter.post("/links/:id/seen", asyncHandler(async (req, res) => {
  res.json({ link: await gmailService.seen(req.params.id!, req.auth!.sub) });
}));
gmailRouter.delete("/links/:id", asyncHandler(async (req, res) => {
  await gmailService.unlink(req.params.id!, req.auth!.sub);
  res.status(204).end();
}));

// ---- GitHub on products: mounted under /products, routes ask for auth themselves --
export const productGithubRouter = Router();

export function serializeProductRepo(r: ProductRepo) {
  return { id: r.id, productId: r.productId, owner: r.owner, repo: r.repo, fullName: r.fullName, htmlUrl: r.htmlUrl ?? null, description: r.description ?? null, isPrivate: r.isPrivate, addedBy: r.addedBy ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

async function requireProduct(userId: string, permission: string, productId: string): Promise<void> {
  if (!(await can({ sub: userId }, permission, { type: "product", id: productId }))) throw forbidden("You don't have permission to do this for this product");
}

async function projectReposOf(productId: string) {
  const projects = await Project.findAll({ where: { productId }, attributes: ["id", "name"] });
  if (!projects.length) return [];
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const rows = await ProjectRepo.findAll({ where: { projectId: projects.map((p) => p.id) } });
  return rows.map((r) => ({ projectId: r.projectId, projectName: names.get(r.projectId) ?? "", owner: r.owner, repo: r.repo, fullName: r.fullName, htmlUrl: r.htmlUrl ?? null }));
}

productGithubRouter.get("/:id/repos", requireAuth, asyncHandler(async (req, res) => {
  await requireProduct(req.auth!.sub, "product.view", req.params.id!);
  const [repos, projectRepos] = await Promise.all([ProductRepo.findAll({ where: { productId: req.params.id! }, order: [["fullName", "ASC"]] }), projectReposOf(req.params.id!)]);
  res.json({ repos: repos.map(serializeProductRepo), projectRepos: projectRepos.map(({ projectId, projectName, fullName, htmlUrl }) => ({ projectId, projectName, fullName, htmlUrl })) });
}));
productGithubRouter.post("/:id/repos", requireAuth, validateBody(z.object({ repo: z.string().trim().min(1).max(300) })), asyncHandler(async (req, res) => {
  await requireProduct(req.auth!.sub, "product.edit", req.params.id!);
  const parsed = parseRepoInput(req.body.repo);
  if (!parsed) throw badRequest("Enter a GitHub repo URL or owner/repo");
  const meta = await getRepo(parsed.owner, parsed.repo);
  if (!meta) throw badRequest("Repo not found or not accessible (install the GitHub App on this repo)");
  const [row] = await ProductRepo.findOrCreate({
    where: { productId: req.params.id!, fullName: meta.fullName },
    defaults: { productId: req.params.id!, owner: meta.owner, repo: meta.repo, fullName: meta.fullName, htmlUrl: meta.htmlUrl ?? null, description: meta.description ?? null, isPrivate: !!meta.private, addedBy: req.auth!.sub },
  });
  syncHint([req.auth!.sub], ["productRepos"]);
  res.status(201).json({ repo: serializeProductRepo(row) });
}));
productGithubRouter.delete("/:id/repos/:repoId", requireAuth, asyncHandler(async (req, res) => {
  await requireProduct(req.auth!.sub, "product.edit", req.params.id!);
  const row = await ProductRepo.findOne({ where: { id: req.params.repoId!, productId: req.params.id! } });
  if (!row) throw notFound("Repo not found");
  await row.destroy();
  res.status(204).end();
}));
productGithubRouter.get("/:id/github/activity", requireAuth, asyncHandler(async (req, res) => {
  await requireProduct(req.auth!.sub, "product.view", req.params.id!);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const direct = await ProductRepo.findAll({ where: { productId: req.params.id! } });
  const seen = new Map<string, { owner: string; repo: string; fullName: string }>();
  for (const r of [...direct, ...(await projectReposOf(req.params.id!))]) seen.set(r.fullName, { owner: r.owner, repo: r.repo, fullName: r.fullName });
  const pullRequests: { repo: string; number: number; title: string; url: string; status: string; author: string | null; updatedAt: string | null }[] = [];
  const commits: { repo: string; sha: string; message: string; author: string | null; url: string; date: string | null }[] = [];
  const errors: { repo: string; error: string }[] = [];
  // One repo failing mustn't take the rest down.
  await Promise.all(
    [...seen.values()].map(async (r) => {
      try {
        const [prs, cs] = await Promise.all([listOpenPullRequests(r.owner, r.repo), listCommits(r.owner, r.repo, { perPage: limit })]);
        for (const p of prs) pullRequests.push({ repo: r.fullName, number: p.number, title: p.title, url: p.url, status: p.status, author: p.authorLogin ?? null, updatedAt: p.updatedAt ?? null });
        for (const c of cs) commits.push({ repo: r.fullName, sha: c.sha, message: c.message, author: c.authorLogin ?? c.authorName ?? null, url: c.url, date: c.date ?? null });
      } catch (err) {
        errors.push({ repo: r.fullName, error: (err as Error).message });
      }
    }),
  );
  const byDate = <T>(key: (x: T) => string | null) => (a: T, b: T) => (key(b) ?? "").localeCompare(key(a) ?? "");
  res.json({
    pullRequests: pullRequests.sort(byDate((x) => x.updatedAt)).slice(0, limit),
    commits: commits.sort(byDate((x) => x.date)).slice(0, limit),
    errors,
  });
}));
