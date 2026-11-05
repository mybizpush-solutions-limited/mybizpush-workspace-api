import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler, badRequest } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { requireAuth, requirePermission } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { rateLimit } from "../../middleware/rateLimit";
import { EMPLOYMENT_STATUSES } from "../../models";
import { serializeInvitation, staffService } from "./staff.service";
import { fixRow, getImport, preview, saveImport, summarize } from "./staff.import";
import { EXPORT_GROUPS, buildRows, toCsv, toXlsx, type ExportGroup } from "./staff.export";

// Staff administration (API-CHANGES A106): /staff for admins, and the public
// invitation endpoints the accept screen (AUTH-03) uses.
export const staffRouter = Router();
export const invitationsPublicRouter = Router();

const profileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  employeeId: z.string().trim().max(40).nullable().optional(),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  dateJoined: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  reportsToId: z.string().uuid().nullable().optional(),
});

const inviteOne = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(120).optional(),
  departmentId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  productTitle: z.string().trim().max(80).optional(),
  roleId: z.string().uuid().optional(),
  jobTitles: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
});
const inviteSchema = z.object({ invites: z.array(inviteOne).min(1).max(50), send: z.boolean().default(true) });

staffRouter.use(requireAuth);

staffRouter.patch(
  "/:id",
  requirePermission("staff.edit"),
  validateBody(profileSchema),
  asyncHandler(async (req, res) => {
    const { before, after } = await staffService.updateProfile(req.params.id!, req.body);
    const changed = Object.keys(req.body);
    const pick = (u: Record<string, unknown>) => Object.fromEntries(changed.map((k) => [k, u[k]]));
    await audit({ req, action: "staff.update", target: { type: "user", id: after.id }, before: pick(before as never), after: pick(after as never) });
    res.json({ user: after });
  }),
);

staffRouter.post(
  "/:id/suspend",
  requirePermission("staff.suspend"),
  validateBody(z.object({ reason: z.string().trim().max(240).optional() })),
  asyncHandler(async (req, res) => {
    const user = await staffService.suspend(req.auth!.sub, req.params.id!, req.body.reason);
    await audit({ req, action: "staff.suspend", target: { type: "user", id: user.id }, after: { reason: req.body.reason ?? null } });
    res.json({ user });
  }),
);

staffRouter.post(
  "/:id/activate",
  requirePermission("staff.suspend"),
  asyncHandler(async (req, res) => {
    const user = await staffService.activate(req.params.id!);
    await audit({ req, action: "staff.activate", target: { type: "user", id: user.id } });
    res.json({ user });
  }),
);

staffRouter.get(
  "/invitations",
  requirePermission("staff.view"),
  asyncHandler(async (_req, res) => {
    res.json({ invitations: await staffService.listInvitations() });
  }),
);

// Invite one or many. Each invite stands alone: one bad email doesn't stop the rest.
staffRouter.post(
  "/invitations",
  requirePermission("staff.create"),
  validateBody(inviteSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof inviteSchema>;
    const results = [];
    for (const input of body.invites) {
      try {
        const { invitation } = await staffService.invite(req.auth!.sub, input, { send: body.send });
        await audit({ req, action: "staff.invite", target: { type: "invitation", id: invitation.id }, after: { email: invitation.email } });
        results.push({ email: input.email, ok: true, invitation: serializeInvitation(invitation) });
      } catch (err) {
        results.push({ email: input.email, ok: false, error: (err as Error).message });
      }
    }
    res.status(201).json({ results });
  }),
);

staffRouter.post(
  "/invitations/:id/resend",
  requirePermission("staff.create"),
  asyncHandler(async (req, res) => {
    const inv = await staffService.resend(req.params.id!);
    await audit({ req, action: "staff.invite.resend", target: { type: "invitation", id: inv.id } });
    res.json({ invitation: serializeInvitation(inv) });
  }),
);

staffRouter.delete(
  "/invitations/:id",
  requirePermission("staff.create"),
  asyncHandler(async (req, res) => {
    await staffService.revoke(req.params.id!);
    await audit({ req, action: "staff.invite.revoke", target: { type: "invitation", id: req.params.id! } });
    res.status(204).end();
  }),
);

// ---- Import (A107, ORG-05) ----------------------------------------------------

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

staffRouter.post(
  "/import",
  requirePermission("staff.import"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("Attach a .csv or .xlsx file as 'file'");
    const state = await preview(req.auth!.sub, req.file);
    res.status(201).json({ import: summarize(state) });
  }),
);

staffRouter.get(
  "/import/:id",
  requirePermission("staff.import"),
  asyncHandler(async (req, res) => {
    res.json({ import: summarize(await getImport(req.params.id!)) });
  }),
);

staffRouter.patch(
  "/import/:id/rows/:row",
  requirePermission("staff.import"),
  validateBody(
    z.object({
      email: z.string().trim().email().optional(),
      name: z.string().trim().max(120).optional(),
      departmentId: z.string().uuid().nullable().optional(),
      productId: z.string().uuid().nullable().optional(),
      teamId: z.string().uuid().nullable().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const state = await fixRow(req.params.id!, Number(req.params.row), req.body);
    res.json({ import: summarize(state) });
  }),
);

// Sends the invitations for every ready row. Runs after the response; the
// screen polls GET /staff/import/:id. Moves to the BullMQ imports queue once
// A005 is merged.
staffRouter.post(
  "/import/:id/commit",
  requirePermission("staff.import"),
  validateBody(z.object({ send: z.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const state = await getImport(req.params.id!);
    if (state.status !== "preview") throw badRequest("This import already ran");
    state.status = "running";
    await saveImport(state);
    const actorId = req.auth!.sub;
    const send = req.body.send as boolean;
    await audit({ req, action: "staff.import", target: { type: "import", id: state.id }, after: { file: state.fileName, ready: state.rows.filter((r) => r.status === "ready").length } });
    void (async () => {
      const failed: { email: string; error: string }[] = [];
      let invited = 0;
      for (const r of state.rows.filter((x) => x.status === "ready")) {
        try {
          await staffService.invite(
            actorId,
            { email: r.email, name: r.name || undefined, departmentId: r.departmentId ?? undefined, productId: r.productId ?? undefined, teamId: r.teamId ?? undefined, jobTitles: r.jobTitles },
            { send, source: "import" },
          );
          invited++;
        } catch (err) {
          failed.push({ email: r.email, error: (err as Error).message });
        }
      }
      state.status = "done";
      state.result = { invited, failed };
      await saveImport(state);
    })().catch(async (err) => {
      state.status = "failed";
      state.result = { invited: 0, failed: [{ email: "", error: (err as Error).message }] };
      await saveImport(state).catch(() => undefined);
    });
    res.status(202).json({ import: summarize(state) });
  }),
);

// ---- Export (A107, ORG-06) ----------------------------------------------------

staffRouter.get(
  "/export",
  requirePermission("staff.export"),
  asyncHandler(async (req, res) => {
    const format = req.query.format === "csv" ? "csv" : "xlsx";
    const requested = String(req.query.include ?? "contact,departments,products,roles").split(",").map((g) => g.trim());
    const groups = requested.filter((g): g is ExportGroup => (EXPORT_GROUPS as readonly string[]).includes(g));
    const status = req.query.status === "all" || req.query.status === "suspended" ? req.query.status : "active";
    const { columns, rows } = await buildRows(groups, { status });
    const stamp = new Date().toISOString().slice(0, 10);
    await audit({ req, action: "staff.export", target: { type: "export", id: null }, after: { format, groups, status, rows: rows.length } });
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="staff-${stamp}.csv"`);
      res.send(toCsv(columns, rows));
      return;
    }
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="staff-${stamp}.xlsx"`);
    res.send(await toXlsx(columns, rows, { generatedBy: req.auth!.email }));
  }),
);

// ---- Public (no auth): accept an invitation ----------------------------------

const inviteLimiter = rateLimit({ windowSec: 600, max: 20, keyPrefix: "invite" });

invitationsPublicRouter.get(
  "/:token",
  inviteLimiter,
  asyncHandler(async (req, res) => {
    res.json({ invitation: await staffService.lookup(req.params.token!) });
  }),
);

// Creates the account; the client then signs in with the new password.
invitationsPublicRouter.post(
  "/:token/accept",
  inviteLimiter,
  validateBody(z.object({ name: z.string().trim().min(1).max(120).optional(), password: z.string().min(8).max(200) })),
  asyncHandler(async (req, res) => {
    const user = await staffService.accept(req.params.token!, req.body);
    await audit({ actorId: user.id, req, action: "staff.invite.accept", target: { type: "user", id: user.id } });
    res.status(201).json({ ok: true, email: user.email });
  }),
);
