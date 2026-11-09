import { Router, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { audit } from "../../lib/audit";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { CONTENT_PLATFORMS, CONTENT_TYPES, LEAD_CONSENT, LEAD_SOURCES, User } from "../../models";
import { contentService } from "../content/content.service";
import { CONTENT_STATUSES, contentWorkflow } from "../content/content.workflow";
import { toCsv, toXlsx } from "../staff/staff.export";
import { campaignsService, tracking } from "./campaigns.service";
import { leadsService, requireOnProduct } from "./leads.service";
import { marketingSummary } from "./marketing.summary";

// Mounted at the API root because the paths span /products/:id/..., /leads, /lists,
// /segments, /campaigns, /content and /social-accounts. Each route asks for auth
// itself: a blanket use() here would catch every other router's traffic.
export const marketingRouter = Router();
const auth = requireAuth;

const uuid = z.string().uuid();
const page = { limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() };

// ---- Leads --------------------------------------------------------------------
const leadFields = {
  email: z.string().trim().max(254),
  name: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  consent: z.enum(LEAD_CONSENT).optional(),
  consentSource: z.string().trim().max(200).nullable().optional(),
  ownerId: uuid.nullable().optional(),
  custom: z.record(z.unknown()).optional(),
  listIds: z.array(uuid).max(50).optional(),
};

marketingRouter.get("/products/:productId/leads", auth, asyncHandler(async (req, res) => {
  const q = z.object({ q: z.string().trim().max(120).optional(), tag: z.string().max(60).optional(), consent: z.enum(LEAD_CONSENT).optional(), status: z.string().max(14).optional(), listId: uuid.optional(), ...page }).parse(req.query);
  res.json(await leadsService.list(req.params.productId!, req.auth!.sub, q));
}));
marketingRouter.post("/products/:productId/leads", auth, validateBody(z.object({ id: uuid.optional(), ...leadFields })), asyncHandler(async (req, res) => {
  res.status(201).json({ lead: await leadsService.create(req.params.productId!, req.body, req.auth!.sub) });
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
marketingRouter.post("/products/:productId/leads/import", auth, upload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest("A file is required (multipart field 'file')");
  res.status(201).json({ import: await leadsService.startImport(req.params.productId!, req.file, req.auth!.sub) });
}));
marketingRouter.get("/leads/import/:id", auth, asyncHandler(async (req, res) => {
  const q = z.object({ rowStatus: z.string().max(12).optional(), limit: z.coerce.number().int().min(1).max(500).optional(), offset: page.offset }).parse(req.query);
  res.json({ import: await leadsService.getImport(req.params.id!, req.auth!.sub, q) });
}));
marketingRouter.patch("/leads/import/:id/mapping", auth, validateBody(z.object({ mapping: z.object({ email: z.string(), name: z.string().optional(), company: z.string().optional(), phone: z.string().optional(), tags: z.string().optional(), consent: z.string().optional() }) })), asyncHandler(async (req, res) => {
  res.json({ import: await leadsService.setMapping(req.params.id!, req.body.mapping, req.auth!.sub) });
}));
marketingRouter.patch("/leads/import/:id/rows/:row", auth, validateBody(z.object({ email: z.string().trim().max(254).optional(), name: z.string().trim().max(200).optional(), company: z.string().trim().max(200).optional(), phone: z.string().trim().max(40).optional(), skip: z.boolean().optional() })), asyncHandler(async (req, res) => {
  res.json({ import: await leadsService.fixRow(req.params.id!, Number(req.params.row), req.body, req.auth!.sub) });
}));
marketingRouter.post("/leads/import/:id/commit", auth, validateBody(z.object({ listId: uuid.optional(), newListName: z.string().trim().min(1).max(120).optional(), tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(), consent: z.enum(["unknown", "granted"]).optional(), consentSource: z.string().trim().max(200).optional() })), asyncHandler(async (req, res) => {
  res.status(202).json({ import: await leadsService.commitImport(req.params.id!, req.body, req.auth!.sub, req) });
}));

marketingRouter.get("/leads/:id", auth, asyncHandler(async (req, res) => {
  res.json(await leadsService.get(req.params.id!, req.auth!.sub));
}));
marketingRouter.patch("/leads/:id", auth, validateBody(z.object({ ...leadFields, email: leadFields.email.optional() })), asyncHandler(async (req, res) => {
  res.json({ lead: await leadsService.update(req.params.id!, req.body, req.auth!.sub) });
}));
marketingRouter.delete("/leads/:id", auth, asyncHandler(async (req, res) => {
  await leadsService.remove(req.params.id!, req.auth!.sub);
  res.status(204).end();
}));

// ---- Lists and segments ---------------------------------------------------------
const rule = z.object({ field: z.enum(["tag", "source", "consent", "status", "company", "email_domain", "list", "created_after", "created_before"]), value: z.string().trim().min(1).max(200) });
const rules = z.object({ all: z.array(rule).max(20).optional(), any: z.array(rule).max(20).optional() });
const listBody = { name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional() };

marketingRouter.get("/products/:productId/lists", auth, asyncHandler(async (req, res) => {
  res.json({ lists: await leadsService.lists(req.params.productId!, req.auth!.sub) });
}));
marketingRouter.post("/products/:productId/lists", auth, validateBody(z.object({ id: uuid.optional(), ...listBody })), asyncHandler(async (req, res) => {
  res.status(201).json({ list: await leadsService.createList(req.params.productId!, req.body, req.auth!.sub) });
}));
marketingRouter.patch("/lists/:id", auth, validateBody(z.object(listBody).partial()), asyncHandler(async (req, res) => {
  res.json({ list: await leadsService.updateList(req.params.id!, req.body, req.auth!.sub) });
}));
marketingRouter.delete("/lists/:id", auth, asyncHandler(async (req, res) => {
  await leadsService.removeList(req.params.id!, req.auth!.sub);
  res.status(204).end();
}));
const members = z.object({ leadIds: z.array(uuid).min(1).max(5000) });
marketingRouter.post("/lists/:id/members", auth, validateBody(members), asyncHandler(async (req, res) => {
  res.json({ list: await leadsService.setListMembers(req.params.id!, req.body.leadIds, true, req.auth!.sub) });
}));
marketingRouter.delete("/lists/:id/members", auth, validateBody(members), asyncHandler(async (req, res) => {
  res.json({ list: await leadsService.setListMembers(req.params.id!, req.body.leadIds, false, req.auth!.sub) });
}));

marketingRouter.get("/products/:productId/segments", auth, asyncHandler(async (req, res) => {
  res.json({ segments: await leadsService.segments(req.params.productId!, req.auth!.sub) });
}));
marketingRouter.post("/products/:productId/segments/preview", auth, validateBody(z.object({ rules })), asyncHandler(async (req, res) => {
  res.json(await leadsService.previewSegment(req.params.productId!, req.body.rules, req.auth!.sub));
}));
marketingRouter.post("/products/:productId/segments", auth, validateBody(z.object({ id: uuid.optional(), name: z.string().trim().min(1).max(120), rules })), asyncHandler(async (req, res) => {
  res.status(201).json({ segment: await leadsService.createSegment(req.params.productId!, req.body, req.auth!.sub) });
}));
marketingRouter.patch("/segments/:id", auth, validateBody(z.object({ name: z.string().trim().min(1).max(120).optional(), rules: rules.optional() })), asyncHandler(async (req, res) => {
  res.json({ segment: await leadsService.updateSegment(req.params.id!, req.body, req.auth!.sub) });
}));
marketingRouter.delete("/segments/:id", auth, asyncHandler(async (req, res) => {
  await leadsService.removeSegment(req.params.id!, req.auth!.sub);
  res.status(204).end();
}));

// ---- Suppression --------------------------------------------------------------
marketingRouter.get("/products/:productId/suppressions", auth, asyncHandler(async (req, res) => {
  const q = z.object({ q: z.string().trim().max(120).optional(), reason: z.string().max(14).optional(), ...page }).parse(req.query);
  res.json(await leadsService.suppressions(req.params.productId!, req.auth!.sub, q));
}));
marketingRouter.post("/products/:productId/suppressions", auth, validateBody(z.object({ email: z.string().trim().max(254), note: z.string().trim().max(500).optional(), allProducts: z.boolean().optional() })), asyncHandler(async (req, res) => {
  res.status(201).json({ suppression: await leadsService.suppress(req.params.productId!, req.body, req.auth!.sub, req) });
}));
marketingRouter.delete("/suppressions/:id", auth, asyncHandler(async (req, res) => {
  await leadsService.unsuppress(req.params.id!, req.auth!.sub, req);
  res.status(204).end();
}));

// ---- Campaigns ----------------------------------------------------------------
const audience = z.object({ listIds: z.array(uuid).max(50).optional(), segmentIds: z.array(uuid).max(50).optional(), leadIds: z.array(uuid).max(5000).optional(), includeUnknownConsent: z.boolean().optional() });
const campaignFields = {
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().max(300).optional(),
  previewText: z.string().trim().max(300).optional(),
  fromName: z.string().trim().max(120).optional(),
  fromEmail: z.string().trim().max(254).optional(),
  replyTo: z.string().trim().email().nullable().optional(),
  bodyHtml: z.string().max(500_000).optional(),
  bodyText: z.string().max(200_000).optional(),
  audience: audience.optional(),
  throttlePerMinute: z.number().int().min(1).max(600).optional(),
};

marketingRouter.get("/products/:productId/campaigns", auth, asyncHandler(async (req, res) => {
  res.json({ campaigns: await campaignsService.list(req.params.productId!, req.auth!.sub, typeof req.query.status === "string" ? req.query.status : undefined) });
}));
marketingRouter.post("/products/:productId/campaigns", auth, validateBody(z.object({ id: uuid.optional(), ...campaignFields })), asyncHandler(async (req, res) => {
  res.status(201).json({ campaign: await campaignsService.create(req.params.productId!, req.body, req.auth!.sub) });
}));
marketingRouter.get("/campaigns/:id", auth, asyncHandler(async (req, res) => {
  res.json({ campaign: await campaignsService.get(req.params.id!, req.auth!.sub) });
}));
marketingRouter.patch("/campaigns/:id", auth, validateBody(z.object(campaignFields).partial()), asyncHandler(async (req, res) => {
  res.json({ campaign: await campaignsService.update(req.params.id!, req.body, req.auth!.sub) });
}));
marketingRouter.post("/campaigns/:id/audience-preview", auth, asyncHandler(async (req, res) => {
  res.json(await campaignsService.audiencePreview(req.params.id!, req.auth!.sub));
}));
marketingRouter.post("/campaigns/:id/test", auth, validateBody(z.object({ emails: z.array(z.string().trim().max(254)).min(1).max(5) })), asyncHandler(async (req, res) => {
  res.json({ sent: await campaignsService.test(req.params.id!, req.body.emails, req.auth!.sub) });
}));
marketingRouter.post("/campaigns/:id/submit", auth, asyncHandler(async (req, res) => {
  res.json({ campaign: await campaignsService.submit(req.params.id!, req.auth!.sub, req) });
}));
marketingRouter.post("/campaigns/:id/approve", auth, validateBody(z.object({ note: z.string().trim().max(1000).optional() })), asyncHandler(async (req, res) => {
  res.json({ campaign: await campaignsService.approve(req.params.id!, req.body.note, req.auth!.sub, req) });
}));
marketingRouter.post("/campaigns/:id/reject", auth, validateBody(z.object({ note: z.string().trim().min(1).max(1000) })), asyncHandler(async (req, res) => {
  res.json({ campaign: await campaignsService.reject(req.params.id!, req.body.note, req.auth!.sub, req) });
}));
marketingRouter.post("/campaigns/:id/schedule", auth, validateBody(z.object({ scheduledAt: z.string().datetime().optional() })), asyncHandler(async (req, res) => {
  res.json({ campaign: await campaignsService.schedule(req.params.id!, req.body.scheduledAt, req.auth!.sub, req) });
}));
marketingRouter.post("/campaigns/:id/pause", auth, asyncHandler(async (req, res) => {
  res.json({ campaign: await campaignsService.pause(req.params.id!, req.auth!.sub, req) });
}));
marketingRouter.post("/campaigns/:id/resume", auth, asyncHandler(async (req, res) => {
  res.json({ campaign: await campaignsService.resume(req.params.id!, req.auth!.sub, req) });
}));
marketingRouter.post("/campaigns/:id/cancel", auth, asyncHandler(async (req, res) => {
  res.json({ campaign: await campaignsService.cancel(req.params.id!, req.auth!.sub, req) });
}));
marketingRouter.get("/campaigns/:id/report/export", auth, asyncHandler(async (req, res) => {
  const format = req.query.format === "xlsx" ? "xlsx" : "csv";
  const { recipients } = await campaignsService.recipients(req.params.id!, req.auth!.sub, { unlimited: true }, "report.export");
  const columns = ["Email", "Status", "Skipped because", "Sent", "Delivered", "Opened", "Opens", "Clicked", "Clicks", "Unsubscribed", "Error"];
  const rows = recipients.map((r) => ({ Email: r.email, Status: r.status, "Skipped because": r.skipReason ?? "", Sent: r.sentAt ?? "", Delivered: r.deliveredAt ?? "", Opened: r.openedAt ?? "", Opens: String(r.openCount), Clicked: r.clickedAt ?? "", Clicks: String(r.clickCount), Unsubscribed: r.unsubscribedAt ?? "", Error: r.error ?? "" }));
  await audit({ req, action: "report.export", target: { type: "campaign", id: req.params.id! }, after: { format, rows: rows.length } });
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="campaign-${req.params.id}.csv"`);
    return res.send(toCsv(columns, rows));
  }
  const me = await User.findByPk(req.auth!.sub, { attributes: ["name"] });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="campaign-${req.params.id}.xlsx"`);
  res.send(await toXlsx(columns, rows, { generatedBy: me?.name ?? "", sheet: "Recipients" }));
}));
marketingRouter.get("/campaigns/:id/report", auth, asyncHandler(async (req, res) => {
  res.json(await campaignsService.report(req.params.id!, req.auth!.sub));
}));
marketingRouter.get("/campaigns/:id/recipients", auth, asyncHandler(async (req, res) => {
  const q = z.object({ status: z.string().max(10).optional(), q: z.string().trim().max(120).optional(), ...page }).parse(req.query);
  res.json(await campaignsService.recipients(req.params.id!, req.auth!.sub, q));
}));

marketingRouter.get("/products/:productId/marketing/summary", auth, asyncHandler(async (req, res) => {
  await requireOnProduct(req.auth!.sub, "campaign.view", req.params.productId!);
  res.json(await marketingSummary(req.params.productId!));
}));

// ---- Content ------------------------------------------------------------------
const contentFields = {
  title: z.string().trim().min(1).max(300),
  type: z.enum(CONTENT_TYPES),
  platform: z.enum(CONTENT_PLATFORMS).nullable().optional(),
  brief: z.string().trim().max(20000).optional(),
  caption: z.string().trim().max(20000).optional(),
  writerId: uuid.nullable().optional(),
  designerId: uuid.nullable().optional(),
  reviewerId: uuid.nullable().optional(),
  publishAt: z.string().datetime().nullable().optional(),
  blogPostId: uuid.nullable().optional(),
  url: z.string().url().max(2000).nullable().optional(),
};
export const contentCreateSchema = z.object({ id: uuid.optional(), productId: uuid, ...contentFields });
export const contentUpdateSchema = z.object(contentFields).partial();
export const contentStatusSchema = z.object({ status: z.enum(CONTENT_STATUSES), note: z.string().trim().max(2000).optional() });
export const contentReviewSchema = z.object({ decision: z.enum(["approve", "request_revision"]), note: z.string().trim().max(2000).optional() });

marketingRouter.get("/content/workflow", auth, (_req, res) => {
  res.json(contentWorkflow());
});
marketingRouter.get("/content", auth, asyncHandler(async (req, res) => {
  const q = z.object({ productId: uuid.optional(), status: z.string().max(200).optional(), type: z.enum(CONTENT_TYPES).optional(), platform: z.enum(CONTENT_PLATFORMS).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), assigneeId: uuid.optional(), ...page }).parse(req.query);
  res.json(await contentService.list(req.auth!.sub, q));
}));
marketingRouter.post("/content", auth, validateBody(contentCreateSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ item: await contentService.create(req.body, req.auth!.sub) });
}));
marketingRouter.get("/content/:id", auth, asyncHandler(async (req, res) => {
  res.json(await contentService.get(req.params.id!, req.auth!.sub));
}));
marketingRouter.patch("/content/:id", auth, validateBody(contentUpdateSchema), asyncHandler(async (req, res) => {
  res.json({ item: await contentService.update(req.params.id!, req.body, req.auth!.sub) });
}));
marketingRouter.post("/content/:id/status", auth, validateBody(contentStatusSchema), asyncHandler(async (req, res) => {
  res.json({ item: await contentService.setStatus(req.params.id!, req.body.status, req.body.note, req.auth!.sub) });
}));
marketingRouter.post("/content/:id/review", auth, validateBody(contentReviewSchema), asyncHandler(async (req, res) => {
  res.json(await contentService.review(req.params.id!, req.body, req.auth!.sub, req));
}));
marketingRouter.post("/content/:id/publish", auth, validateBody(z.object({ url: z.string().url().max(2000).optional(), publishedAt: z.string().datetime().optional() })), asyncHandler(async (req, res) => {
  res.json({ item: await contentService.publish(req.params.id!, req.body, req.auth!.sub, req) });
}));
marketingRouter.delete("/content/:id", auth, asyncHandler(async (req, res) => {
  await contentService.remove(req.params.id!, req.auth!.sub);
  res.status(204).end();
}));

// ---- Social accounts ----------------------------------------------------------
const socialFields = {
  platform: z.enum(CONTENT_PLATFORMS.filter((p) => p !== "email" && p !== "website") as [string, ...string[]]),
  handle: z.string().trim().min(1).max(120),
  url: z.string().url().max(2000).nullable().optional(),
  ownerId: uuid.nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
};
marketingRouter.get("/products/:productId/social-accounts", auth, asyncHandler(async (req, res) => {
  res.json({ accounts: await contentService.socialAccounts(req.params.productId!, req.auth!.sub) });
}));
marketingRouter.post("/products/:productId/social-accounts", auth, validateBody(z.object({ id: uuid.optional(), ...socialFields })), asyncHandler(async (req, res) => {
  res.status(201).json({ account: await contentService.addSocial(req.params.productId!, req.body, req.auth!.sub) });
}));
marketingRouter.patch("/social-accounts/:id", auth, validateBody(z.object(socialFields).partial()), asyncHandler(async (req, res) => {
  res.json({ account: await contentService.updateSocial(req.params.id!, req.body, req.auth!.sub) });
}));
marketingRouter.delete("/social-accounts/:id", auth, asyncHandler(async (req, res) => {
  await contentService.removeSocial(req.params.id!, req.auth!.sub);
  res.status(204).end();
}));

// ---- Public: tracking and webhooks. No token: reached from people's mail apps. --
export const trackingRouter = Router();
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const page2 = (res: Response, status: number, title: string, body: string) =>
  res
    .status(status)
    .type("html")
    .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:Helvetica,Arial,sans-serif;max-width:420px;margin:15vh auto;padding:0 20px;color:#1f2430;text-align:center">${body}</body>`);

trackingRouter.get("/o/:file", asyncHandler(async (req, res) => {
  const token = req.params.file!.replace(/\.gif$/, "");
  // Tracking must never stop the image loading.
  await tracking.open(token).catch(() => undefined);
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" }).send(PIXEL);
}));

trackingRouter.get("/c/:token/:linkId", asyncHandler(async (req, res) => {
  const url = await tracking.click(req.params.token!, req.params.linkId!).catch(() => null);
  if (!url) return page2(res, 404, "Link not found", "<h2>That link doesn't work any more.</h2>");
  res.redirect(302, url);
}));

// A page, not an instant action: mail scanners follow links, and shouldn't be able
// to unsubscribe people. The button posts; so does one-click List-Unsubscribe.
trackingRouter.get("/u/:token", (req, res) => {
  const token = encodeURIComponent(req.params.token!);
  page2(res, 200, "Unsubscribe", `<h2>Stop these emails?</h2><form method="post" action="${token}"><button style="padding:12px 24px;border:0;border-radius:10px;background:#8E2C87;color:#fff;font-size:15px">Unsubscribe</button></form>`);
});
trackingRouter.post("/u/:token", asyncHandler(async (req, res) => {
  const ok = await tracking.unsubscribe(req.params.token!);
  if (!ok) return page2(res, 404, "Not found", "<h2>That link doesn't work any more.</h2>");
  page2(res, 200, "Unsubscribed", "<h2>You're unsubscribed.</h2><p>You won't get these emails again.</p>");
}));

export const emailWebhookRouter = Router();
emailWebhookRouter.post("/email", asyncHandler(async (req, res) => {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  const valid = tracking.verifyWebhook(raw, { id: req.get("svix-id"), timestamp: req.get("svix-timestamp"), signature: req.get("svix-signature") });
  if (!valid) return res.status(401).json({ error: { code: "bad_signature", message: "Signature check failed" } });
  await tracking.webhook(req.body as { type?: string; data?: { email_id?: string } });
  res.status(204).end();
}));
