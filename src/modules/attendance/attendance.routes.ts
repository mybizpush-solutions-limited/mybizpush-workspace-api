import { Router } from "express";
import { z } from "zod";
import { audit } from "../../lib/audit";
import { asyncHandler } from "../../lib/errors";
import { requireAuth, requirePermission } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rateLimit";
import { validateBody } from "../../middleware/validate";
import { can } from "../access/engine";
import { attendanceService } from "./attendance.service";

// Office attendance by rotating QR code. Onsite and hybrid staff scan the code
// shown on the office screen; people with attendance.view see everyone.
export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm");
const officeFields = { name: z.string().trim().min(1).max(120), address: z.string().trim().max(300).nullable().optional(), lateAfter: hhmm.optional() };
const codeSchema = z.object({ code: z.string().trim().min(1).max(200) });
const rangeSchema = z.object({ from: day, to: day });
const scanLimiter = rateLimit({ windowSec: 60, max: 10, keyPrefix: "attendance-scan", key: (req) => req.auth?.sub ?? req.ip ?? "unknown" });

attendanceRouter.get("/offices", asyncHandler(async (req, res) => {
  const includeInactive = req.query.all === "true" && (await can(req.auth!, "attendance.manage"));
  res.json({ offices: await attendanceService.offices(includeInactive) });
}));

attendanceRouter.post("/offices", requirePermission("attendance.manage"), validateBody(z.object(officeFields)), asyncHandler(async (req, res) => {
  const office = await attendanceService.createOffice(req.body, req.auth!.sub);
  await audit({ req, action: "attendance.office.create", target: { type: "office", id: office.id }, after: office });
  res.status(201).json({ office });
}));

attendanceRouter.patch(
  "/offices/:id",
  requirePermission("attendance.manage"),
  validateBody(z.object({ ...officeFields, active: z.boolean() }).partial()),
  asyncHandler(async (req, res) => {
    const office = await attendanceService.updateOffice(req.params.id!, req.body);
    await audit({ req, action: "attendance.office.update", target: { type: "office", id: office.id }, after: req.body });
    res.json({ office });
  }),
);

attendanceRouter.post("/offices/:id/rotate-secret", requirePermission("attendance.manage"), asyncHandler(async (req, res) => {
  const office = await attendanceService.rotateSecret(req.params.id!);
  await audit({ req, action: "attendance.office.rotate_code", target: { type: "office", id: office.id } });
  res.json({ office });
}));

// Polled by the office screen; each code is valid for about a minute.
attendanceRouter.get("/offices/:id/code", requirePermission("attendance.manage"), asyncHandler(async (req, res) => {
  res.json(await attendanceService.currentCode(req.params.id!));
}));

attendanceRouter.post("/check-in", scanLimiter, validateBody(codeSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ record: await attendanceService.checkIn(req.auth!.sub, req.body.code) });
}));

attendanceRouter.post("/check-out", scanLimiter, validateBody(codeSchema), asyncHandler(async (req, res) => {
  res.json({ record: await attendanceService.checkOut(req.auth!.sub, req.body.code) });
}));

attendanceRouter.get("/me", asyncHandler(async (req, res) => {
  res.json(await attendanceService.mine(req.auth!.sub, rangeSchema.parse(req.query)));
}));

attendanceRouter.get("/day", requirePermission("attendance.view"), asyncHandler(async (req, res) => {
  const q = z.object({ date: day.optional(), officeId: z.string().uuid().optional() }).parse(req.query);
  res.json(await attendanceService.day(q.date, q.officeId));
}));

attendanceRouter.get("/report", requirePermission("attendance.view"), asyncHandler(async (req, res) => {
  res.json(await attendanceService.report(rangeSchema.parse(req.query)));
}));

attendanceRouter.get("/report/export", requirePermission("attendance.view"), asyncHandler(async (req, res) => {
  const range = rangeSchema.parse(req.query);
  const csv = attendanceService.toCsv(await attendanceService.report(range));
  await audit({ req, action: "attendance.export", target: { type: "attendance", id: `${range.from}..${range.to}` } });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="attendance-${range.from}-to-${range.to}.csv"`);
  res.send(csv);
}));
