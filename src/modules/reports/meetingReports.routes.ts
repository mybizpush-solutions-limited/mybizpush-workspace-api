import { Router } from "express";
import path from "node:path";
import multer from "multer";
import { forbidden, badRequest, asyncHandler } from "../../lib/errors";
import { isOrgManager } from "../../models";
import { requireAuth } from "../../middleware/auth";
import { meetingReportService } from "./meetingReport.service";

// Executive-admin feature: upload a meeting transcript, get a letterheaded,
// confidential meeting report PDF (GLM 5.3 flash, high reasoning). Chiefs and
// executive admins may generate and view.
export const meetingReportsRouter = Router();
meetingReportsRouter.use(requireAuth);

const transcriptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const TRANSCRIPT_EXTENSIONS = [".txt", ".md", ".text"];

meetingReportsRouter.post(
  "/",
  transcriptUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!isOrgManager(req.auth!.accessLevel)) {
      throw forbidden("Only a chief or executive admin can generate meeting reports");
    }
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
    res.status(201).json({ report });
  }),
);

meetingReportsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!isOrgManager(req.auth!.accessLevel)) {
      throw forbidden("Only a chief or executive admin can view meeting reports");
    }
    res.json({ reports: await meetingReportService.list() });
  }),
);