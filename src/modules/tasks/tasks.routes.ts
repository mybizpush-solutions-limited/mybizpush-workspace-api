import { Router } from "express";
import { z } from "zod";
import { audit } from "../../lib/audit";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { toCsv, toXlsx } from "../staff/staff.export";
import { User } from "../../models";
import { taskReports } from "./task.reports";
import { taskTemplates } from "./task.templates";
import { workflowDescription } from "./task.workflow";
import {
  listQuerySchema,
  reportQuerySchema,
  reviewSchema,
  submitSchema,
  templateCreateSchema,
  templateUpdateSchema,
} from "./tasks.schemas";
import { tasksWorkflow } from "./tasks.service";

// Task workflow endpoints (API-CHANGES A201 to A205). Mounted ahead of the shared
// work item router: named paths must match before its /:id.
export const tasksExtRouter = Router();
tasksExtRouter.use(requireAuth);

const LIST_FILTERS = ["segment", "status", "priority", "assigneeId", "reviewerId", "productId", "teamId", "dueFrom", "dueTo", "overdue", "q", "limit", "offset"];

// Extended filters only. A plain GET /tasks stays with the shared router, so the
// web app's response is byte for byte what it was.
tasksExtRouter.get(
  "/",
  asyncHandler(async (req, res, next) => {
    if (!LIST_FILTERS.some((f) => f in req.query)) return next();
    res.json({ items: await tasksWorkflow.list(listQuerySchema.parse(req.query), req.auth!.sub) });
  }),
);

tasksExtRouter.get("/workflow", (_req, res) => {
  res.json(workflowDescription());
});

// ---- Templates --------------------------------------------------------------
tasksExtRouter.get(
  "/templates",
  asyncHandler(async (req, res) => {
    const q = z
      .object({ productId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), includeArchived: z.enum(["true", "false"]).optional() })
      .parse(req.query);
    res.json({ templates: await taskTemplates.list({ ...q, includeArchived: q.includeArchived === "true" }) });
  }),
);
tasksExtRouter.post(
  "/templates",
  validateBody(templateCreateSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ template: await taskTemplates.create(req.body, req.auth!.sub) });
  }),
);
tasksExtRouter.patch(
  "/templates/:id",
  validateBody(templateUpdateSchema),
  asyncHandler(async (req, res) => {
    res.json({ template: await taskTemplates.update(req.params.id!, req.body, req.auth!.sub) });
  }),
);
tasksExtRouter.delete(
  "/templates/:id",
  asyncHandler(async (req, res) => {
    await taskTemplates.archive(req.params.id!, req.auth!.sub);
    res.status(204).end();
  }),
);

// ---- Reports ----------------------------------------------------------------
tasksExtRouter.get(
  "/reports/summary",
  asyncHandler(async (req, res) => {
    res.json(await taskReports.summary(reportQuerySchema.parse(req.query), req.auth!.sub));
  }),
);
tasksExtRouter.get(
  "/reports/rows",
  asyncHandler(async (req, res) => {
    res.json(await taskReports.rows(reportQuerySchema.parse(req.query), req.auth!.sub));
  }),
);
tasksExtRouter.get(
  "/reports/export",
  asyncHandler(async (req, res) => {
    const q = reportQuerySchema.parse(req.query);
    const format = q.format ?? "xlsx";
    const { columns, rows } = await taskReports.exportRows(q, req.auth!.sub);
    await audit({ req, action: "report.export", target: { type: "task_report" }, after: { format, rows: rows.length, filters: { ...q } } });
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="tasks-${stamp}.csv"`);
      return res.send(toCsv(columns, rows));
    }
    const me = await User.findByPk(req.auth!.sub, { attributes: ["name"] });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="tasks-${stamp}.xlsx"`);
    res.send(await toXlsx(columns, rows, { generatedBy: me?.name ?? "", sheet: "Tasks" }));
  }),
);

// ---- One task ---------------------------------------------------------------
tasksExtRouter.get(
  "/:id/transitions",
  asyncHandler(async (req, res) => {
    res.json(await tasksWorkflow.transitions(req.params.id!, req.auth!.sub));
  }),
);
tasksExtRouter.post(
  "/:id/submit",
  validateBody(submitSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await tasksWorkflow.submit(req.params.id!, req.body, req.auth!.sub));
  }),
);
tasksExtRouter.post(
  "/:id/review",
  validateBody(reviewSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await tasksWorkflow.review(req.params.id!, req.body, req.auth!.sub, req));
  }),
);
tasksExtRouter.get(
  "/:id/submissions",
  asyncHandler(async (req, res) => {
    res.json({ submissions: await tasksWorkflow.submissions(req.params.id!, req.auth!.sub) });
  }),
);
tasksExtRouter.get(
  "/:id/reviews",
  asyncHandler(async (req, res) => {
    res.json({ reviews: await tasksWorkflow.reviews(req.params.id!, req.auth!.sub) });
  }),
);
tasksExtRouter.get(
  "/:id/history",
  asyncHandler(async (req, res) => {
    res.json({ entries: await tasksWorkflow.history(req.params.id!, req.auth!.sub) });
  }),
);
tasksExtRouter.get(
  "/:id/dependencies",
  asyncHandler(async (req, res) => {
    res.json(await tasksWorkflow.dependencies(req.params.id!, req.auth!.sub));
  }),
);
tasksExtRouter.post(
  "/:id/dependencies",
  validateBody(z.object({ dependsOnId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    res.json({ item: await tasksWorkflow.addDependency(req.params.id!, req.body.dependsOnId, req.auth!.sub) });
  }),
);
tasksExtRouter.delete(
  "/:id/dependencies/:dependsOnId",
  asyncHandler(async (req, res) => {
    res.json({ item: await tasksWorkflow.removeDependency(req.params.id!, req.params.dependsOnId!, req.auth!.sub) });
  }),
);

// The extended serializer: GET /tasks/:id includes dependencies and groups.
tasksExtRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ item: await tasksWorkflow.view(req.params.id!, req.auth!.sub) });
  }),
);
