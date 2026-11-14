import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { EXPORT_FORMATS, QUERY_CATEGORIES, QUERY_DECISIONS, QUERY_STATUSES, REPORT_TYPES, TARGET_OWNER_TYPES, TARGET_PERIODS, TARGET_SOURCES, TARGET_STATUSES, TARGET_UNITS } from "../../models";
import { GROUP_TYPES } from "../groups/groups.merge";
import { appraisalsService } from "./appraisals.service";
import { queriesService } from "./queries.service";
import { reportExports } from "./report.exports";
import { reportsService } from "./reports.service";
import { targetsService } from "./targets.service";

export const queriesRouter = Router();
export const targetsRouter = Router();
export const appraisalsRouter = Router();
export const reportsV2Router = Router();
for (const r of [queriesRouter, targetsRouter, appraisalsRouter, reportsV2Router]) r.use(requireAuth);

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const evidence = z.array(z.object({ title: z.string().trim().max(200).optional(), url: z.string().url().max(2000) })).max(20);
const ratings = z.record(z.number().int().min(1).max(5));

const pdf = (res: { setHeader: (k: string, v: string) => void; send: (b: Buffer) => unknown }, name: string, buffer: Buffer) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send(buffer);
};

// ---- Queries ------------------------------------------------------------------
const queryBody = z.object({
  id: uuid.optional(),
  staffId: uuid,
  category: z.enum(QUERY_CATEGORIES),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
  deadlineAt: z.string().datetime(),
});
export const respondSchema = z.object({ response: z.string().trim().min(1).max(20000), attachmentIds: z.array(uuid).max(10).optional() });

queriesRouter.get("/", asyncHandler(async (req, res) => {
  const q = z.object({ segment: z.enum(["received", "issued", "all"]).optional(), status: z.enum(QUERY_STATUSES).optional(), staffId: uuid.optional(), category: z.enum(QUERY_CATEGORIES).optional() }).parse(req.query);
  res.json({ queries: await queriesService.list(req.auth!.sub, q) });
}));
queriesRouter.post("/preview-letter", validateBody(queryBody), asyncHandler(async (req, res) => {
  pdf(res, "query-preview.pdf", await queriesService.previewLetter(req.body, req.auth!.sub));
}));
queriesRouter.post("/", validateBody(queryBody), asyncHandler(async (req, res) => {
  res.status(201).json({ query: await queriesService.issue(req.body, req.auth!.sub, req) });
}));
queriesRouter.get("/:id/letter.pdf", asyncHandler(async (req, res) => {
  const { buffer, fileName } = await queriesService.letter(req.params.id!, req.auth!.sub, req);
  pdf(res, fileName, buffer);
}));
queriesRouter.get("/:id", asyncHandler(async (req, res) => {
  res.json(await queriesService.get(req.params.id!, req.auth!.sub));
}));
queriesRouter.post("/:id/respond", validateBody(respondSchema), asyncHandler(async (req, res) => {
  res.json({ query: await queriesService.respond(req.params.id!, req.body, req.auth!.sub, req) });
}));
queriesRouter.post("/:id/review", validateBody(z.object({ note: z.string().trim().max(4000).optional() })), asyncHandler(async (req, res) => {
  res.json({ query: await queriesService.review(req.params.id!, req.body.note, req.auth!.sub, req) });
}));
queriesRouter.post("/:id/resolve", validateBody(z.object({ decision: z.enum(QUERY_DECISIONS), decisionNote: z.string().trim().max(4000).optional() })), asyncHandler(async (req, res) => {
  res.json({ query: await queriesService.resolve(req.params.id!, req.body, req.auth!.sub, req) });
}));
queriesRouter.post("/:id/withdraw", validateBody(z.object({ reason: z.string().trim().max(1000).optional() })), asyncHandler(async (req, res) => {
  res.json({ query: await queriesService.withdraw(req.params.id!, req.body.reason, req.auth!.sub, req) });
}));

// ---- Targets ------------------------------------------------------------------
const targetFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  ownerType: z.enum(TARGET_OWNER_TYPES),
  ownerId: uuid,
  period: z.enum(TARGET_PERIODS),
  startDate: day,
  endDate: day,
  unit: z.enum(TARGET_UNITS),
  unitLabel: z.string().trim().max(40).nullable().optional(),
  startValue: z.number().finite().optional(),
  targetValue: z.number().finite(),
  source: z.enum(TARGET_SOURCES).optional(),
  sourceConfig: z.object({ projectId: uuid.nullable().optional(), productId: uuid.nullable().optional() }).optional(),
  reviewerId: uuid.nullable().optional(),
};
export const progressSchema = z.object({
  id: uuid.optional(),
  value: z.number().finite(),
  note: z.string().trim().max(2000).optional(),
  evidence: evidence.optional(),
  assignmentId: uuid.optional(),
  source: z.enum(["manual", "imported"]).optional(),
});

targetsRouter.get("/", asyncHandler(async (req, res) => {
  const q = z.object({ segment: z.enum(["mine", "team", "all"]).optional(), status: z.enum(TARGET_STATUSES).optional(), from: z.string().optional(), to: z.string().optional(), ownerType: z.enum(TARGET_OWNER_TYPES).optional(), ownerId: uuid.optional(), productId: uuid.optional() }).parse(req.query);
  res.json({ targets: await targetsService.list(req.auth!.sub, q) });
}));
targetsRouter.post("/", validateBody(z.object({ id: uuid.optional(), ...targetFields })), asyncHandler(async (req, res) => {
  res.status(201).json({ target: await targetsService.create(req.body, req.auth!.sub) });
}));
targetsRouter.get("/:id", asyncHandler(async (req, res) => {
  res.json(await targetsService.get(req.params.id!, req.auth!.sub));
}));
targetsRouter.patch("/:id", validateBody(z.object(targetFields).partial()), asyncHandler(async (req, res) => {
  res.json({ target: await targetsService.update(req.params.id!, req.body, req.auth!.sub) });
}));
targetsRouter.delete("/:id", asyncHandler(async (req, res) => {
  res.json({ target: await targetsService.cancel(req.params.id!, req.auth!.sub) });
}));
targetsRouter.post("/:id/progress", validateBody(progressSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await targetsService.addProgress(req.params.id!, req.body, req.auth!.sub));
}));
targetsRouter.post(
  "/:id/progress/import",
  validateBody(z.object({ rows: z.array(z.object({ userId: uuid.optional(), value: z.number().finite(), note: z.string().trim().max(2000).optional() })).min(1).max(500) })),
  asyncHandler(async (req, res) => {
    res.json(await targetsService.importProgress(req.params.id!, req.body.rows, req.auth!.sub));
  }),
);
targetsRouter.post(
  "/:id/evaluate",
  validateBody(z.object({ rating: z.number().int().min(1).max(5), note: z.string().trim().max(2000).optional(), status: z.enum(["achieved", "missed"]).optional() })),
  asyncHandler(async (req, res) => {
    res.json({ target: await targetsService.evaluate(req.params.id!, req.body, req.auth!.sub, req) });
  }),
);

// ---- Appraisals ---------------------------------------------------------------
const cycleFields = {
  name: z.string().trim().min(1).max(120),
  startDate: day,
  endDate: day,
  selfDueAt: z.string().datetime().nullable().optional(),
  managerDueAt: z.string().datetime().nullable().optional(),
  areas: z.array(z.object({ key: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(80) })).max(30),
};
export const selfSchema = z.object({ ratings, comments: z.string().trim().max(8000).optional(), evidence: evidence.optional(), submit: z.boolean().optional() });
export const managerSchema = z.object({ ratings, feedback: z.string().trim().max(8000).optional(), overallRating: z.number().min(1).max(5).optional(), submit: z.boolean().optional() });

appraisalsRouter.get("/cycles", asyncHandler(async (req, res) => {
  res.json({ cycles: await appraisalsService.cycles(req.auth!.sub) });
}));
appraisalsRouter.post("/cycles", validateBody(z.object({ id: uuid.optional(), ...cycleFields })), asyncHandler(async (req, res) => {
  res.status(201).json({ cycle: await appraisalsService.createCycle(req.body, req.auth!.sub) });
}));
appraisalsRouter.patch("/cycles/:id", validateBody(z.object(cycleFields).partial()), asyncHandler(async (req, res) => {
  res.json({ cycle: await appraisalsService.updateCycle(req.params.id!, req.body, req.auth!.sub) });
}));
appraisalsRouter.post(
  "/cycles/:id/open",
  validateBody(z.object({ userIds: z.array(uuid).max(2000).optional(), groups: z.array(z.object({ type: z.enum(GROUP_TYPES), id: uuid })).max(20).optional() })),
  asyncHandler(async (req, res) => {
    res.json(await appraisalsService.openCycle(req.params.id!, req.body, req.auth!.sub, req));
  }),
);
appraisalsRouter.post("/cycles/:id/close", asyncHandler(async (req, res) => {
  res.json({ cycle: await appraisalsService.closeCycle(req.params.id!, req.auth!.sub, req) });
}));
appraisalsRouter.get("/", asyncHandler(async (req, res) => {
  const q = z.object({ segment: z.enum(["mine", "team", "all"]).optional(), cycleId: uuid.optional(), status: z.enum(["pending_self", "pending_manager", "completed"]).optional() }).parse(req.query);
  res.json({ appraisals: await appraisalsService.list(req.auth!.sub, q) });
}));
appraisalsRouter.get("/:id", asyncHandler(async (req, res) => {
  res.json({ appraisal: await appraisalsService.get(req.params.id!, req.auth!.sub) });
}));
appraisalsRouter.post("/:id/self", validateBody(selfSchema), asyncHandler(async (req, res) => {
  res.json({ appraisal: await appraisalsService.saveSelf(req.params.id!, req.body, req.auth!.sub) });
}));
appraisalsRouter.post("/:id/manager", validateBody(managerSchema), asyncHandler(async (req, res) => {
  res.json({ appraisal: await appraisalsService.saveManager(req.params.id!, req.body, req.auth!.sub, req) });
}));

// ---- Reports ------------------------------------------------------------------
const rangeSchema = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() });

reportsV2Router.get("/catalog", asyncHandler(async (req, res) => {
  res.json(await reportsService.catalog(req.auth!.sub));
}));
reportsV2Router.get("/executive", asyncHandler(async (req, res) => {
  res.json(await reportsService.executive(req.auth!.sub, rangeSchema.parse(req.query)));
}));
reportsV2Router.get("/department/:id", asyncHandler(async (req, res) => {
  res.json(await reportsService.department(req.params.id!, req.auth!.sub, rangeSchema.parse(req.query)));
}));
reportsV2Router.get("/product/:id", asyncHandler(async (req, res) => {
  res.json(await reportsService.product(req.params.id!, req.auth!.sub, rangeSchema.parse(req.query)));
}));
reportsV2Router.get("/project/:id", asyncHandler(async (req, res) => {
  res.json(await reportsService.project(req.params.id!, req.auth!.sub, rangeSchema.parse(req.query)));
}));
reportsV2Router.get("/staff/:userId/product/:productId", asyncHandler(async (req, res) => {
  res.json(await reportsService.staffProduct(req.params.userId!, req.params.productId!, req.auth!.sub, rangeSchema.parse(req.query)));
}));
reportsV2Router.get("/staff/:userId", asyncHandler(async (req, res) => {
  res.json(await reportsService.staff(req.params.userId!, req.auth!.sub, rangeSchema.parse(req.query)));
}));

const exportParams = z.object({
  id: uuid.optional(),
  userId: uuid.optional(),
  productId: uuid.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  projectId: uuid.optional(),
  departmentId: uuid.optional(),
  teamId: uuid.optional(),
  assigneeId: uuid.optional(),
});
reportsV2Router.post(
  "/exports",
  validateBody(z.object({ reportType: z.enum(REPORT_TYPES), params: exportParams.optional(), format: z.enum(EXPORT_FORMATS), sections: z.array(z.string().max(40)).max(20).optional() })),
  asyncHandler(async (req, res) => {
    res.status(202).json({ export: await reportExports.request(req.body, req.auth!.sub, req) });
  }),
);
reportsV2Router.get("/exports", asyncHandler(async (req, res) => {
  res.json({ exports: await reportExports.list(req.auth!.sub) });
}));
reportsV2Router.get("/exports/:id", asyncHandler(async (req, res) => {
  res.json({ export: await reportExports.get(req.params.id!, req.auth!.sub) });
}));
reportsV2Router.get("/exports/:id/download", asyncHandler(async (req, res) => {
  const f = await reportExports.download(req.params.id!, req.auth!.sub, req);
  const types = { pdf: "application/pdf", csv: "text/csv; charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  res.setHeader("Content-Type", types[f.format]);
  res.setHeader("Content-Disposition", `attachment; filename="${f.fileName}"`);
  res.send(f.data);
}));
