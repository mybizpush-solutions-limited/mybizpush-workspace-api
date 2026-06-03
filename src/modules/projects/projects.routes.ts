import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler, badRequest, forbidden, notFound } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { Department, Project } from "../../models";
import { projectsService } from "./projects.service";
import { projectReposService } from "./repos.service";
import { githubSyncService } from "../github/github.sync.service";

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Editing a project: its manager, the head of any involved department, or an exec.
async function assertCanManageProject(
  projectId: string,
  auth: { sub: string; accessLevel: string },
): Promise<void> {
  if (auth.accessLevel === "executive_admin") return;
  const project = await Project.findByPk(projectId, {
    include: [{ model: Department, as: "departments", attributes: ["headId"], through: { attributes: [] } }],
  });
  if (!project) throw notFound("Project not found");
  if (project.managerId === auth.sub) return;
  const depts = (project.get("departments") as Department[] | undefined) ?? [];
  if (depts.some((d) => d.headId === auth.sub)) return;
  throw forbidden("Only the project manager, a department head, or an executive admin can do this");
}

const importIssueSchema = z.object({
  repoFullName: z.string().trim().min(3),
  number: z.number().int().positive(),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).optional(),
  managerId: z.string().uuid().optional(),
  departmentIds: z.array(z.string().uuid()).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(4000).optional(),
  managerId: z.string().uuid().optional(),
  progress: z.number().int().min(0).max(100).optional(),
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

// Projects are top-level — only executive admins create them (and assign a PM).
projectsRouter.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    if (req.auth!.accessLevel !== "executive_admin") {
      throw forbidden("Only an executive admin can create a project");
    }
    res.status(201).json({ project: await projectsService.create(req.body) });
  }),
);

projectsRouter.patch(
  "/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    await assertCanManageProject(req.params.id!, req.auth!);
    res.json({ project: await projectsService.update(req.params.id!, req.body) });
  }),
);

// Add / remove a department "lane" on a project (PM / head / exec).
projectsRouter.post(
  "/:id/departments",
  validateBody(z.object({ departmentId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    await assertCanManageProject(req.params.id!, req.auth!);
    res.json({ project: await projectsService.addDepartment(req.params.id!, req.body.departmentId) });
  }),
);

projectsRouter.delete(
  "/:id/departments/:deptId",
  asyncHandler(async (req, res) => {
    await assertCanManageProject(req.params.id!, req.auth!);
    res.json({ project: await projectsService.removeDepartment(req.params.id!, req.params.deptId!) });
  }),
);

projectsRouter.post(
  "/:id/avatar",
  avatarUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("An image is required (multipart field 'file')");
    await assertCanManageProject(req.params.id!, req.auth!);
    res.json({
      project: await projectsService.setAvatar(req.params.id!, {
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      }),
    });
  }),
);

// ---- Linked GitHub repositories -------------------------------------------
const addRepoSchema = z.object({
  repo: z.string().trim().min(1).max(300),
  departmentId: z.string().uuid().nullable().optional(),
});

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
    res.status(201).json({
      repo: await projectReposService.add(req.params.id!, req.body.repo, req.auth!.sub, req.body.departmentId),
    });
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

projectsRouter.get(
  "/:id/commits",
  asyncHandler(async (req, res) => {
    res.json({ commits: await projectReposService.commits(req.params.id!) });
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
