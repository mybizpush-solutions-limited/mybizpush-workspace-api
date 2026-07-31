import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { BACKUP_FORMATS } from "../../lib/pgdump";
import {
  BACKUP_FREQUENCIES,
  BACKUP_STORAGES,
  DB_ENVIRONMENTS,
} from "../../models";
import { backupsService } from "./backups.service";
import { databasesService } from "./databases.service";
import { schedulesService } from "./schedules.service";

export const databasesRouter = Router();

// ---- Public-ish: token-gated artifact download -----------------------------
// Mounted before requireAuth because a browser <a download> can't send a bearer
// header. The single-use token issued by /download-url is the credential here.
databasesRouter.get(
  "/backups/file",
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const backup = await backupsService.redeemDownloadToken(token);
    res.download(backup.localPath, backup.fileName);
  }),
);

// Everything else needs a session — and, per-route, the right to manage the
// owning project. Connection strings are production credentials; there is no
// read-only view of this console.
databasesRouter.use(requireAuth);

const connectionField = z.string().trim().min(12).max(2000);

const createSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  connectionString: connectionField,
  // Off for servers with no TLS ("the server does not support SSL connections").
  ssl: z.boolean().optional(),
  environment: z.enum(DB_ENVIRONMENTS).optional(),
  provider: z.string().trim().max(40).optional(),
  retentionCount: z.number().int().min(1).max(90).optional(),
  notes: z.string().trim().max(2000).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  // Omit to keep the stored credential — the UI never receives it to send back.
  connectionString: connectionField.optional(),
  // Sendable on its own — flipping SSL is the usual fix after a failed probe.
  ssl: z.boolean().optional(),
  environment: z.enum(DB_ENVIRONMENTS).optional(),
  provider: z.string().trim().max(40).optional(),
  retentionCount: z.number().int().min(1).max(90).optional(),
  notes: z.string().trim().max(2000).optional(),
});

const triggerSchema = z.object({
  format: z.enum(BACKUP_FORMATS).optional(),
  storageTarget: z.enum(BACKUP_STORAGES).optional(),
});

const scheduleSchema = z.object({
  enabled: z.boolean().optional(),
  frequency: z.enum(BACKUP_FREQUENCIES).optional(),
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  format: z.enum(BACKUP_FORMATS).optional(),
  storageTarget: z.enum(BACKUP_STORAGES).optional(),
});

// Origin of this API as the browser sees it, for building download links.
function apiOrigin(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? req.protocol;
  return `${proto}://${req.get("host")}`;
}

// ---- Host capabilities -----------------------------------------------------
// Registered before /:id so "capabilities" isn't read as a database id.
databasesRouter.get(
  "/capabilities",
  asyncHandler(async (_req, res) => {
    res.json(await databasesService.capabilities());
  }),
);

// ---- Individual backups ----------------------------------------------------
databasesRouter.post(
  "/backups/:backupId/download-url",
  asyncHandler(async (req, res) => {
    res.json(await backupsService.downloadUrl(req.params.backupId!, req.auth!, apiOrigin(req)));
  }),
);

databasesRouter.delete(
  "/backups/:backupId",
  asyncHandler(async (req, res) => {
    await backupsService.remove(req.params.backupId!, req.auth!);
    res.status(204).end();
  }),
);

// ---- Databases -------------------------------------------------------------
databasesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    res.json({ databases: await databasesService.list(req.auth!, projectId) });
  }),
);

databasesRouter.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ database: await databasesService.create(req.body, req.auth!) });
  }),
);

databasesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ database: await databasesService.byId(req.params.id!, req.auth!) });
  }),
);

databasesRouter.patch(
  "/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    res.json({ database: await databasesService.update(req.params.id!, req.body, req.auth!) });
  }),
);

databasesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await databasesService.remove(req.params.id!, req.auth!);
    res.status(204).end();
  }),
);

// Re-probe the connection and refresh size / table count.
databasesRouter.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    res.json({ database: await databasesService.test(req.params.id!, req.auth!) });
  }),
);

// ---- Backups for a database ------------------------------------------------
databasesRouter.get(
  "/:id/backups",
  asyncHandler(async (req, res) => {
    res.json({ backups: await backupsService.list(req.params.id!, req.auth!) });
  }),
);

// 202: the dump runs in the background and the returned row is "running".
databasesRouter.post(
  "/:id/backups",
  validateBody(triggerSchema),
  asyncHandler(async (req, res) => {
    const backup = await backupsService.trigger(req.params.id!, req.auth!, req.body);
    res.status(202).json({ backup });
  }),
);

// ---- Schedule --------------------------------------------------------------
databasesRouter.get(
  "/:id/schedule",
  asyncHandler(async (req, res) => {
    res.json({ schedule: await schedulesService.get(req.params.id!, req.auth!) });
  }),
);

// Upsert — a database has at most one schedule.
databasesRouter.put(
  "/:id/schedule",
  validateBody(scheduleSchema),
  asyncHandler(async (req, res) => {
    res.json({ schedule: await schedulesService.save(req.params.id!, req.body, req.auth!) });
  }),
);

databasesRouter.delete(
  "/:id/schedule",
  asyncHandler(async (req, res) => {
    await schedulesService.remove(req.params.id!, req.auth!);
    res.status(204).end();
  }),
);
