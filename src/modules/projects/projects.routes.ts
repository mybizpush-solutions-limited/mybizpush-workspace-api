import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { projectsService } from "./projects.service";
import { projectReposService } from "./repos.service";
import { githubSyncService } from "../github/github.sync.service";

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

const importIssueSchema = z.object({
  repoFullName: z.string().trim().min(3),
  number: z.number().int().positive(),
});

const createSchema = z.object({
  departmentId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).optional(),
  managerId: z.string().uuid().optional(),
  memberIds: z.array(z.string().uuid()).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(4000).optional(),
  managerId: z.string().uuid().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  memberIds: z.array(z.string().uuid()).optional(),
});

projectsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const departmentId = typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;
    res.json({ projects: await projectsService.list(departmentId) });
  }),
);

projectsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ project: await projectsService.byId(req.params.id!) });
  }),
);

projectsRouter.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ project: await projectsService.create(req.body) });
  }),
);

projectsRouter.patch(
  "/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    res.json({ project: await projectsService.update(req.params.id!, req.body) });
  }),
);

// ---- Linked GitHub repositories -------------------------------------------
const addRepoSchema = z.object({ repo: z.string().trim().min(1).max(300) });

projectsRouter.get(
  "/:id/repos",
  asyncHandler(async (req, res) => {
    res.json({ repos: await projectReposService.list(req.params.id!) });
  }),
);

projectsRouter.post(
  "/:id/repos",
  validateBody(addRepoSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ repo: await projectReposService.add(req.params.id!, req.body.repo, req.auth!.sub) });
  }),
);

projectsRouter.delete(
  "/:id/repos/:repoId",
  asyncHandler(async (req, res) => {
    await projectReposService.remove(req.params.id!, req.params.repoId!);
    res.status(204).end();
  }),
);

projectsRouter.get(
  "/:id/pull-requests",
  asyncHandler(async (req, res) => {
    res.json({ pullRequests: await projectReposService.pullRequests(req.params.id!) });
  }),
);

projectsRouter.get(
  "/:id/issues-github",
  asyncHandler(async (req, res) => {
    res.json({ issues: await projectReposService.issues(req.params.id!) });
  }),
);

projectsRouter.get(
  "/:id/releases",
  asyncHandler(async (req, res) => {
    res.json({ releases: await projectReposService.releases(req.params.id!) });
  }),
);

projectsRouter.get(
  "/:id/deployments",
  asyncHandler(async (req, res) => {
    res.json({ deployments: await projectReposService.deployments(req.params.id!) });
  }),
);

// Import a GitHub issue into this project as a synced app issue.
projectsRouter.post(
  "/:id/github-issues/import",
  validateBody(importIssueSchema),
  asyncHandler(async (req, res) => {
    const item = await githubSyncService.importIssue(
      req.params.id!,
      req.body.repoFullName,
      req.body.number,
      req.auth!.sub,
    );
    res.status(201).json({ item });
  }),
);
