import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { issuesService, tasksService, type makeWorkItemService } from "./workitems.service";

const STATUS = z.enum(["todo", "in_progress", "in_review", "blocked", "done"]);
const PRIORITY = z.enum(["low", "medium", "high", "urgent"]);
const SEVERITY = z.enum(["minor", "major", "critical"]);

function buildSchemas(withSeverity: boolean) {
  const create = z.object({
    projectId: z.string().uuid(),
    departmentId: z.string().uuid().nullable().optional(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(8000).optional(),
    status: STATUS.optional(),
    priority: PRIORITY.optional(),
    assigneeIds: z.array(z.string().uuid()).optional(),
    labelIds: z.array(z.string().uuid()).optional(),
    dueDate: z.string().datetime().optional(),
    ...(withSeverity ? { severity: SEVERITY.optional() } : {}),
  });
  const update = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(8000).optional(),
    departmentId: z.string().uuid().nullable().optional(),
    priority: PRIORITY.optional(),
    assigneeIds: z.array(z.string().uuid()).optional(),
    labelIds: z.array(z.string().uuid()).optional(),
    dueDate: z.string().datetime().nullable().optional(),
    ...(withSeverity ? { severity: SEVERITY.optional() } : {}),
  });
  return { create, update };
}

const statusSchema = z.object({ status: STATUS });
const feedbackRequestSchema = z.object({ fromUserId: z.string().uuid() });
const feedbackProvideSchema = z.object({ body: z.string().trim().min(1).max(8000) });
const prSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().trim().min(1).max(300),
  url: z.string().url(),
  status: z.enum(["open", "merged", "closed", "draft"]).optional(),
});

// One router shape for both tasks and issues.
function makeWorkItemRouter(service: ReturnType<typeof makeWorkItemService>, withSeverity: boolean) {
  const router = Router();
  const { create, update } = buildSchemas(withSeverity);
  router.use(requireAuth);

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      const departmentId = typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;
      res.json({ items: await service.list({ projectId, departmentId }) });
    }),
  );

  router.get("/:id", asyncHandler(async (req, res) => {
    res.json({ item: await service.byId(req.params.id!) });
  }));

  router.post("/", validateBody(create), asyncHandler(async (req, res) => {
    res.status(201).json({ item: await service.create(req.body, req.auth!.sub) });
  }));

  router.patch("/:id", validateBody(update), asyncHandler(async (req, res) => {
    res.json({ item: await service.update(req.params.id!, req.body, req.auth!.sub) });
  }));

  router.post("/:id/status", validateBody(statusSchema), asyncHandler(async (req, res) => {
    res.json({ item: await service.setStatus(req.params.id!, req.body.status, req.auth!.sub) });
  }));

  router.post("/:id/feedback/request", validateBody(feedbackRequestSchema), asyncHandler(async (req, res) => {
    res.json({ item: await service.requestFeedback(req.params.id!, req.body.fromUserId, req.auth!.sub) });
  }));

  router.post("/:id/feedback/provide", validateBody(feedbackProvideSchema), asyncHandler(async (req, res) => {
    res.json({ item: await service.provideFeedback(req.params.id!, req.auth!.sub, req.body.body) });
  }));

  router.post("/:id/pull-requests", validateBody(prSchema), asyncHandler(async (req, res) => {
    res.json({ item: await service.linkPullRequest(req.params.id!, req.body, req.auth!.sub) });
  }));

  // Re-fetch live CI/review state for the item's linked PRs (manual/auto refresh).
  router.post("/:id/pull-requests/refresh", asyncHandler(async (req, res) => {
    res.json({ item: await service.refreshPullRequests(req.params.id!) });
  }));

  return router;
}

export const tasksRouter = makeWorkItemRouter(tasksService, false);
export const issuesRouter = makeWorkItemRouter(issuesService, true);
