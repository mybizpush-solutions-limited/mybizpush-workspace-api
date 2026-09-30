import { Router } from "express";
import path from "node:path";
import multer from "multer";
import { forbidden, badRequest, asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { meetingReportService } from "./meetingReport.service";

// Executive-admin-only feature: upload a meeting transcript, get a letterheaded,
// confidential meeting report PDF (GLM 5.3 flash, high reasoning). Generation
// runs in the background: POST returns immediately with a pending row, the UI
// polls GET / and the finished report appears when it's done.
export const meetingReportsRouter = Router();
meetingReportsRouter.use(requireAuth);

const transcriptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const TRANSCRIPT_EXTENSIONS = [".txt", ".md", ".text"];

function assertExec(req: { auth?: { accessLevel?: string } | null }) {
  if (req.auth?.accessLevel !== "executive_admin") {
    throw forbidden("Only an executive admin can manage meeting reports");
  }
}

meetingReportsRouter.post(
  "/",
  transcriptUpload.single("file"),
  asyncHandler(async (req, res) => {
    assertExec(req);
    if (!req.file) throw badRequest("A transcript file is required (multipart field 'file')");
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!TRANSCRIPT_EXTENSIONS.includes(ext)) {
      throw badRequest("The transcript must be a .txt or .md file");
    }
    const report = await meetingReportService.create({
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      generatedById: req.auth!.sub,
    });
    res.status(202).json({ report });
  }),
);

meetingReportsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    assertExec(req);
    res.json({ reports: await meetingReportService.list() });
  }),
);

// Retry a failed report.
meetingReportsRouter.post(
  "/:id/retry",
  asyncHandler(async (req, res) => {
    assertExec(req);
    res.json({ report: await meetingReportService.retry(req.params.id!) });
  }),
);