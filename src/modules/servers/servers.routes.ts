import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { SERVER_JOB_KINDS, SERVER_MODES } from "../../models";
import { serversService } from "./servers.service";

// The server console. Every route checks canManageServers (admins, chiefs,
// executive admins, DevOps) in the service, since that rule needs a DB lookup.
export const serversRouter = Router();

// Fetched by curl on the server being set up, so no bearer token: the
// unguessable, 30-minute link from POST /:id/bootstrap-link is the credential.
serversRouter.get(
  "/bootstrap/:token",
  asyncHandler(async (req, res) => {
    const script = await serversService.bootstrapByToken(req.params.token!);
    res.type("text/x-shellscript").send(script);
  }),
);

serversRouter.use(requireAuth);

// Origin of this API as the outside world sees it (behind the TLS proxy).
function apiOrigin(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? req.protocol;
  return `${proto}://${req.get("host")}`;
}

// A hostname or an IPv4/IPv6 literal. Nothing that could smuggle ssh options.
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.:-]+$/, "Enter a hostname or IP address");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour, UTC)");

const baseSchema = {
  name: z.string().trim().min(1).max(120),
  host,
  port: z.number().int().min(1).max(65535).optional(),
  mode: z.enum(SERVER_MODES).optional(),
  provider: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(4000).optional(),
  maintenanceStart: hhmm.nullable().optional(),
  maintenanceMinutes: z.number().int().min(15).max(360).optional(),
  autoUpgrade: z.boolean().optional(),
  autoUpgradeDay: z.number().int().min(0).max(6).optional(),
  autoUpgradeHour: z.number().int().min(0).max(23).optional(),
  projectIds: z.array(z.string().uuid()).max(100).optional(),
};
const createSchema = z.object(baseSchema);
const updateSchema = z.object(baseSchema).partial();
const jobSchema = z.object({ kind: z.enum(SERVER_JOB_KINDS) });

serversRouter.get(
  "/config",
  asyncHandler(async (req, res) => {
    res.json(await serversService.config(req.auth!));
  }),
);

serversRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ servers: await serversService.list(req.auth!) });
  }),
);

serversRouter.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ server: await serversService.create(req.body, req.auth!) });
  }),
);

serversRouter.get(
  "/jobs/:jobId",
  asyncHandler(async (req, res) => {
    res.json({ job: await serversService.job(req.params.jobId!, req.auth!) });
  }),
);

serversRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ server: await serversService.get(req.params.id!, req.auth!) });
  }),
);

serversRouter.patch(
  "/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    res.json({ server: await serversService.update(req.params.id!, req.body, req.auth!) });
  }),
);

serversRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await serversService.remove(req.params.id!, req.auth!);
    res.status(204).end();
  }),
);

serversRouter.get(
  "/:id/bootstrap",
  asyncHandler(async (req, res) => {
    res.json(await serversService.bootstrap(req.params.id!, req.auth!));
  }),
);

serversRouter.post(
  "/:id/bootstrap-link",
  asyncHandler(async (req, res) => {
    res.json(await serversService.bootstrapLink(req.params.id!, req.auth!, apiOrigin(req)));
  }),
);

serversRouter.post(
  "/:id/refresh",
  asyncHandler(async (req, res) => {
    res.json({ server: await serversService.refresh(req.params.id!, req.auth!) });
  }),
);

serversRouter.post(
  "/:id/retrust",
  asyncHandler(async (req, res) => {
    res.json({ server: await serversService.retrust(req.params.id!, req.auth!) });
  }),
);

serversRouter.post(
  "/:id/jobs",
  validateBody(jobSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ job: await serversService.runJob(req.params.id!, req.body.kind, req.auth!) });
  }),
);

serversRouter.get(
  "/:id/jobs",
  asyncHandler(async (req, res) => {
    res.json({ jobs: await serversService.jobs(req.params.id!, req.auth!) });
  }),
);

serversRouter.get(
  "/:id/history",
  asyncHandler(async (req, res) => {
    const hours = Math.min(Math.max(Number(req.query.hours) || 48, 1), 24 * 30);
    res.json({ points: await serversService.history(req.params.id!, req.auth!, hours) });
  }),
);
