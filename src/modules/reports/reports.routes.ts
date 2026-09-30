import { Router } from "express";
import { z } from "zod";
import { badRequest, asyncHandler } from "../../lib/errors";
import { assertCanManageProject } from "../../lib/permissions";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { isMonth } from "./staffReport.service";
import { reportsService } from "./reports.service";

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

// Mounted under /projects (see app.ts) so the routes below read as
// /api/v1/projects/:id/report/... . There is no clash with projectsRouter:
// every path here is 4+ segments, and all of its GET routes are 2 segments.

// Required "month" query parameter, YYYY-MM (e.g. 2026-09).
function monthOf(req: { query: { month?: unknown } }): string {
  const m = req.query.month;
  if (!isMonth(m)) throw badRequest("month query parameter is required in YYYY-MM form, e.g. 2026-09");
  return m;
}

// JSON payload — lets the UI preview exactly what the PDF will say.
reportsRouter.get(
  "/:id/report/staff/:userId",
  asyncHandler(async (req, res) => {
    await assertCanManageProject(req.params.id!, req.auth!);
    const report = await reportsService.staff(req.params.id!, req.params.userId!, monthOf(req));
    res.json({ report });
  }),
);

// The letterheaded PDF itself, streamed as a download.
reportsRouter.get(
  "/:id/report/staff/:userId/pdf",
  asyncHandler(async (req, res) => {
    await assertCanManageProject(req.params.id!, req.auth!);
    const { buffer, filename } = await reportsService.staffPdf(
      req.params.id!,
      req.params.userId!,
      monthOf(req),
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  }),
);

// Generate + save a snapshot (uploaded to Cloudinary, recorded in `reports`).
reportsRouter.post(
  "/:id/report/staff/:userId/save",
  validateBody(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM") })),
  asyncHandler(async (req, res) => {
    await assertCanManageProject(req.params.id!, req.auth!);
    const report = await reportsService.saveStaff(
      req.params.id!,
      req.params.userId!,
      req.body.month,
      req.auth!.sub,
    );
    res.status(201).json({ report });
  }),
);

// Saved report snapshots for this project.
reportsRouter.get(
  "/:id/reports",
  asyncHandler(async (req, res) => {
    await assertCanManageProject(req.params.id!, req.auth!);
    res.json({ reports: await reportsService.listSaved(req.params.id!) });
  }),
);