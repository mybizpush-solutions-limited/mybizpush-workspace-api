import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Op, QueryTypes, type WhereOptions } from "sequelize";
import { env } from "../../config/env";
import { sequelize } from "../../db/sequelize";
import { audit } from "../../lib/audit";
import { campaignTransport } from "../../lib/campaignMail";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors";
import { enqueue } from "../../jobs/queues";
import { Campaign, CampaignLink, CampaignRecipient, Lead, LeadSegment, type CampaignAudience, type CampaignStatus } from "../../models";
import { can } from "../access/engine";
import { notify } from "../shared/events";
import { canMoveCampaign, domainOf, extractLinks, isEmail, isFreshTimestamp, normalizeEmail, renderForRecipient, resolveSender, svixSignedContent } from "./campaign.render";
import { addSuppression, requireOnProduct, segmentWhere, serializeLead, suppressedSet } from "./leads.service";

// Campaigns: approval, throttled sending, tracking and reports (API-CHANGES A602).

type Req = Parameters<typeof audit>[0]["req"];
const productScope = (id: string) => ({ type: "product" as const, id });
const EMPTY_STATS = { total: 0, sent: 0, delivered: 0, bounced: 0, failed: 0, skipped: 0, opened: 0, clicked: 0, unsubscribed: 0, complained: 0 };

export function serializeCampaign(c: Campaign, withBody = true) {
  return {
    id: c.id,
    productId: c.productId,
    name: c.name,
    subject: c.subject,
    previewText: c.previewText,
    fromName: c.fromName,
    fromEmail: c.fromEmail,
    replyTo: c.replyTo ?? null,
    ...(withBody ? { bodyHtml: c.bodyHtml, bodyText: c.bodyText } : {}),
    audience: c.audience,
    status: c.status,
    scheduledAt: c.scheduledAt?.toISOString() ?? null,
    throttlePerMinute: c.throttlePerMinute,
    submittedBy: c.submittedBy ?? null,
    submittedAt: c.submittedAt?.toISOString() ?? null,
    reviewedBy: c.reviewedBy ?? null,
    reviewedAt: c.reviewedAt?.toISOString() ?? null,
    reviewNote: c.reviewNote ?? null,
    startedAt: c.startedAt?.toISOString() ?? null,
    finishedAt: c.finishedAt?.toISOString() ?? null,
    stats: { ...EMPTY_STATS, ...c.stats },
    createdBy: c.createdBy ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

async function load(id: string): Promise<Campaign> {
  const c = await Campaign.findByPk(id);
  if (!c) throw notFound("Campaign not found");
  return c;
}

function assertMove(c: Campaign, to: CampaignStatus): void {
  if (!canMoveCampaign(c.status, to)) throw new AppError(409, `A campaign can't move from ${c.status} to ${to}`, to === "scheduled" || to === "sending" ? "not_approved" : "invalid_transition");
}

const auditCampaign = (req: Req, actorId: string, c: Campaign, action: string, after?: Record<string, unknown>) =>
  audit({ req, actorId, action: `campaign.${action}`, target: { type: "campaign", id: c.id }, scope: productScope(c.productId), after: { status: c.status, ...after } });

const tell = (userId: string | null | undefined, from: string | null, c: Campaign, message: string) =>
  userId ? notify({ userId, fromUserId: from, kind: "campaign", itemId: c.id, itemType: "campaign", message }) : Promise.resolve();

function publicBase(): string {
  return env.PUBLIC_API_URL.replace(/\/$/, "");
}
const trackingUrls = (token: string) => ({
  unsubscribe: `${publicBase()}/api/v1/t/u/${token}`,
  open: `${publicBase()}/api/v1/t/o/${token}.gif`,
  click: (linkId: string) => `${publicBase()}/api/v1/t/c/${token}/${linkId}`,
});

function senderOf(c: Campaign): string {
  const out = resolveSender({ fromName: c.fromName, fromEmail: c.fromEmail, defaultFrom: env.MARKETING_EMAIL_FROM, allowedDomains: env.MARKETING_ALLOWED_FROM_DOMAINS });
  if (typeof out !== "string") throw badRequest(out.error);
  return out;
}

// ---- Audience --------------------------------------------------------------
async function audienceLeads(c: Campaign): Promise<Lead[]> {
  const a: CampaignAudience = c.audience ?? {};
  const ors: WhereOptions[] = [];
  if (a.leadIds?.length) ors.push({ id: a.leadIds });
  if (a.listIds?.length) {
    const ids = a.listIds.map((x) => sequelize.escape(x)).join(",");
    ors.push({ id: { [Op.in]: sequelize.literal(`(SELECT lead_id FROM lead_list_members WHERE list_id IN (${ids}))`) } });
  }
  if (a.segmentIds?.length) {
    const segments = await LeadSegment.findAll({ where: { id: a.segmentIds, productId: c.productId } });
    for (const s of segments) ors.push(segmentWhere(c.productId, s.rules));
  }
  if (!ors.length) return [];
  return Lead.findAll({ where: { productId: c.productId, [Op.or]: ors } as WhereOptions });
}

export type SkipReason = "suppressed" | "unsubscribed" | "bounced" | "no_consent";

function skipReason(lead: Pick<Lead, "email" | "status" | "consent">, suppressed: ReadonlySet<string>, includeUnknown: boolean): SkipReason | null {
  if (lead.status === "unsubscribed") return "unsubscribed";
  if (lead.status === "bounced") return "bounced";
  if (suppressed.has(lead.email)) return "suppressed";
  if (lead.consent === "withdrawn") return "no_consent";
  if (lead.consent === "unknown" && !includeUnknown) return "no_consent";
  return null;
}

async function recomputeStats(campaignId: string): Promise<Record<string, number>> {
  const [row] = await sequelize.query<Record<string, string>>(
    `SELECT COUNT(*) FILTER (WHERE status <> 'skipped') AS total,
            COUNT(*) FILTER (WHERE status IN ('sent','delivered','bounced')) AS sent,
            COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
            COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
            COUNT(*) FILTER (WHERE status = 'failed') AS failed,
            COUNT(*) FILTER (WHERE status = 'skipped') AS skipped,
            COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS opened,
            COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked,
            COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL) AS unsubscribed,
            COUNT(*) FILTER (WHERE complained_at IS NOT NULL) AS complained
       FROM campaign_recipients WHERE campaign_id = :campaignId`,
    { replacements: { campaignId }, type: QueryTypes.SELECT },
  );
  const stats = Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]));
  await Campaign.update({ stats }, { where: { id: campaignId } });
  return stats;
}

export interface CampaignInput {
  id?: string;
  name: string;
  subject?: string;
  previewText?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string | null;
  bodyHtml?: string;
  bodyText?: string;
  audience?: CampaignAudience;
  throttlePerMinute?: number;
}

export const campaignsService = {
  async list(productId: string, userId: string, status?: string) {
    await requireOnProduct(userId, "campaign.view", productId);
    const rows = await Campaign.findAll({ where: { productId, ...(status ? { status } : {}) }, order: [["updatedAt", "DESC"]], limit: 200 });
    return rows.map((c) => serializeCampaign(c, false));
  },

  async create(productId: string, input: CampaignInput, userId: string) {
    await requireOnProduct(userId, "campaign.create", productId);
    const c = await Campaign.create({ ...input, productId, createdBy: userId, replyTo: input.replyTo ?? null, audience: input.audience ?? {}, throttlePerMinute: input.throttlePerMinute ?? 60 });
    return serializeCampaign(c);
  },

  async get(id: string, userId: string) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.view", c.productId);
    return serializeCampaign(c);
  },

  async update(id: string, patch: Partial<CampaignInput>, userId: string) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.create", c.productId);
    if (!["draft", "rejected", "approved"].includes(c.status)) throw new AppError(409, "This campaign can't be changed now", "not_editable");
    // What was approved is what gets sent: any change needs approving again.
    const wasApproved = c.status === "approved";
    await c.update({ ...patch, ...(wasApproved ? { status: "draft" as const, reviewedBy: null, reviewedAt: null, reviewNote: null } : {}) });
    return serializeCampaign(c);
  },

  async audiencePreview(id: string, userId: string) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.view", c.productId);
    const leads = await audienceLeads(c);
    const suppressed = await suppressedSet(c.productId);
    const excluded = { suppressed: 0, unsubscribed: 0, bounced: 0, noConsent: 0 };
    const eligible: Lead[] = [];
    for (const l of leads) {
      const r = skipReason(l, suppressed, !!c.audience?.includeUnknownConsent);
      if (!r) eligible.push(l);
      else if (r === "no_consent") excluded.noConsent++;
      else excluded[r]++;
    }
    return { eligible: eligible.length, excluded, sample: eligible.slice(0, 10).map((l) => serializeLead(l)) };
  },

  // Test sends only go to staff, so a draft can't reach a customer.
  async test(id: string, emails: string[], userId: string) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.create", c.productId);
    const domain = env.ALLOWED_EMAIL_DOMAIN.toLowerCase();
    const list = emails.map(normalizeEmail);
    if (list.some((e) => !isEmail(e) || domainOf(e) !== domain)) throw badRequest(`Test sends go to @${domain} addresses only`);
    for (const email of list) {
      const out = renderForRecipient({
        subject: `[Test] ${c.subject}`,
        bodyHtml: c.bodyHtml,
        bodyText: c.bodyText,
        values: { name: "Test Recipient", email, company: "Test Company" },
        unsubscribeUrl: `${publicBase()}/api/v1/t/u/test`,
        openPixelUrl: `${publicBase()}/api/v1/t/o/test.gif`,
        linkIds: new Map(),
        clickUrl: () => "",
      });
      await campaignTransport().send({ from: senderOf(c), to: email, replyTo: c.replyTo, subject: out.subject, html: out.html, text: out.text, headers: {} });
    }
    return list.length;
  },

  async submit(id: string, userId: string, req?: Req) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.create", c.productId);
    assertMove(c, "pending_approval");
    if (!c.subject.trim() || !c.bodyHtml.trim() || !c.name.trim()) throw badRequest("A campaign needs a subject and content first");
    senderOf(c);
    if (!(await audienceLeads(c)).length) throw badRequest("Pick who this campaign goes to");
    await c.update({ status: "pending_approval", submittedBy: userId, submittedAt: new Date(), reviewNote: null });
    await auditCampaign(req, userId, c, "submit");
    await notifyApprovers(c, userId);
    return serializeCampaign(c);
  },

  async approve(id: string, note: string | undefined, userId: string, req?: Req) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.approve", c.productId);
    assertMove(c, "approved");
    if (c.createdBy === userId || c.submittedBy === userId) throw new AppError(403, "Someone else has to approve your campaign", "self_approval");
    await c.update({ status: "approved", reviewedBy: userId, reviewedAt: new Date(), reviewNote: note ?? null });
    await auditCampaign(req, userId, c, "approve");
    await tell(c.createdBy, userId, c, `Approved: ${c.name}`);
    return serializeCampaign(c);
  },

  async reject(id: string, note: string, userId: string, req?: Req) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.approve", c.productId);
    assertMove(c, "rejected");
    await c.update({ status: "rejected", reviewedBy: userId, reviewedAt: new Date(), reviewNote: note });
    await auditCampaign(req, userId, c, "reject");
    await tell(c.createdBy, userId, c, `Returned: ${c.name}. ${note}`);
    return serializeCampaign(c);
  },

  async schedule(id: string, scheduledAt: string | undefined, userId: string, req?: Req) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.send", c.productId);
    if (c.status !== "approved") throw new AppError(409, "This campaign needs approval first", "not_approved");
    senderOf(c);
    const when = scheduledAt ? new Date(scheduledAt) : null;
    if (when && when <= new Date()) throw badRequest("Pick a time in the future");
    await c.update({ status: "scheduled", scheduledAt: when ?? new Date() });
    await auditCampaign(req, userId, c, "schedule", { scheduledAt: c.scheduledAt?.toISOString() });
    if (!when) await enqueue("campaigns", "start", { campaignId: id }, { jobId: `campaign-start-${id}-${Date.now()}` });
    return serializeCampaign(c);
  },

  async pause(id: string, userId: string, req?: Req) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.send", c.productId);
    assertMove(c, "paused");
    await c.update({ status: "paused" });
    await auditCampaign(req, userId, c, "pause");
    return serializeCampaign(c);
  },

  async resume(id: string, userId: string, req?: Req) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.send", c.productId);
    if (c.status !== "paused") throw new AppError(409, "This campaign isn't paused", "invalid_transition");
    // Paused before it began: go back to waiting for its time.
    if (!c.startedAt) {
      await c.update({ status: "scheduled" });
      await enqueue("campaigns", "start", { campaignId: id }, { jobId: `campaign-start-${id}-${Date.now()}` });
    } else {
      await c.update({ status: "sending" });
      await enqueue("campaigns", "batch", { campaignId: id }, { jobId: `campaign-batch-${id}-${Date.now()}` });
    }
    await auditCampaign(req, userId, c, "resume");
    return serializeCampaign(c);
  },

  async cancel(id: string, userId: string, req?: Req) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.send", c.productId);
    assertMove(c, "cancelled");
    await c.update({ status: "cancelled", finishedAt: new Date() });
    await CampaignRecipient.update({ status: "skipped", skipReason: "cancelled" }, { where: { campaignId: id, status: "queued" } });
    await recomputeStats(id);
    await auditCampaign(req, userId, c, "cancel");
    return serializeCampaign(await load(id));
  },

  async report(id: string, userId: string) {
    const c = await load(id);
    await requireOnProduct(userId, "campaign.view", c.productId);
    await recomputeStats(id);
    await c.reload();
    const [timeline, links] = await Promise.all([
      sequelize.query<{ hour: string; opened: string; clicked: string }>(
        `SELECT to_char(h, 'YYYY-MM-DD"T"HH24:00:00"Z"') AS hour, SUM(o) AS opened, SUM(cl) AS clicked FROM (
           SELECT date_trunc('hour', opened_at AT TIME ZONE 'UTC') AS h, 1 AS o, 0 AS cl FROM campaign_recipients WHERE campaign_id = :id AND opened_at IS NOT NULL
           UNION ALL SELECT date_trunc('hour', clicked_at AT TIME ZONE 'UTC'), 0, 1 FROM campaign_recipients WHERE campaign_id = :id AND clicked_at IS NOT NULL
         ) x GROUP BY h ORDER BY h`,
        { replacements: { id }, type: QueryTypes.SELECT },
      ),
      CampaignLink.findAll({ where: { campaignId: id }, order: [["clicks", "DESC"]] }),
    ]);
    return {
      campaign: serializeCampaign(c),
      timeline: timeline.map((t) => ({ hour: t.hour, opened: Number(t.opened), clicked: Number(t.clicked) })),
      links: links.map((l) => ({ id: l.id, url: l.url, clicks: l.clicks, uniqueClicks: l.uniqueClicks })),
    };
  },

  async recipients(id: string, userId: string, q: { status?: string; q?: string; limit?: number; offset?: number; unlimited?: boolean }, permission = "campaign.view") {
    const c = await load(id);
    if (permission === "report.export") {
      if (!(await can({ sub: userId }, "report.export", productScope(c.productId)))) throw forbidden("You don't have permission to export this");
    } else {
      await requireOnProduct(userId, permission, c.productId);
    }
    const where: Record<string, unknown> = { campaignId: id };
    if (q.status) where.status = q.status;
    if (q.q) where.email = { [Op.iLike]: `%${q.q.replace(/[%_]/g, (x) => `\\${x}`)}%` };
    const { rows, count } = await CampaignRecipient.findAndCountAll({ where: where as WhereOptions, order: [["email", "ASC"]], ...(q.unlimited ? {} : { limit: q.limit ?? 50, offset: q.offset ?? 0 }) });
    return {
      total: count,
      recipients: rows.map((r) => ({
        id: r.id,
        leadId: r.leadId ?? null,
        email: r.email,
        status: r.status,
        skipReason: r.skipReason ?? null,
        sentAt: r.sentAt?.toISOString() ?? null,
        deliveredAt: r.deliveredAt?.toISOString() ?? null,
        openedAt: r.openedAt?.toISOString() ?? null,
        openCount: r.openCount,
        clickedAt: r.clickedAt?.toISOString() ?? null,
        clickCount: r.clickCount,
        unsubscribedAt: r.unsubscribedAt?.toISOString() ?? null,
        error: r.error ?? null,
      })),
    };
  },

  // ---- Worker --------------------------------------------------------------

  // Every minute: anything scheduled that has come due.
  async dispatchDue(): Promise<void> {
    const due = await Campaign.findAll({ where: { status: "scheduled", scheduledAt: { [Op.lte]: new Date() } }, attributes: ["id"], limit: 20 });
    for (const { id } of due) await this.start(id);
  },

  // Fixes the audience and begins. Only one worker can claim a campaign.
  async start(campaignId: string): Promise<void> {
    const [claimed] = await Campaign.update({ status: "sending", startedAt: new Date() }, { where: { id: campaignId, status: "scheduled" } });
    if (!claimed) return;
    const c = await load(campaignId);
    try {
      for (const url of extractLinks(c.bodyHtml)) await CampaignLink.create({ campaignId, url });
      const leads = await audienceLeads(c);
      const suppressed = await suppressedSet(c.productId);
      await CampaignRecipient.bulkCreate(
        leads.map((l) => {
          const skip = skipReason(l, suppressed, !!c.audience?.includeUnknownConsent);
          return { campaignId, leadId: l.id, email: l.email, token: randomBytes(24).toString("base64url"), status: skip ? ("skipped" as const) : ("queued" as const), skipReason: skip };
        }),
      );
      await recomputeStats(campaignId);
      await enqueue("campaigns", "batch", { campaignId }, { jobId: `campaign-batch-${campaignId}-${Date.now()}` });
    } catch (err) {
      await c.update({ status: "paused" });
      await tell(c.createdBy, null, c, `Couldn't start ${c.name}: ${(err as Error).message}`);
      throw err;
    }
  },

  // One minute's worth of sending, then it queues the next.
  async batch(campaignId: string): Promise<void> {
    const c = await Campaign.findByPk(campaignId);
    if (!c || c.status !== "sending") return; // paused or cancelled
    // Anything left mid-send by a crash is marked failed, never sent twice.
    await CampaignRecipient.update(
      { status: "failed", error: "Interrupted while sending" },
      { where: { campaignId, status: "sending", updatedAt: { [Op.lt]: new Date(Date.now() - 10 * 60_000) } } },
    );
    const rows = await CampaignRecipient.findAll({ where: { campaignId, status: "queued" }, limit: c.throttlePerMinute, order: [["createdAt", "ASC"]] });
    if (!rows.length) return this.finish(c);

    const sender = senderOf(c);
    const links = await CampaignLink.findAll({ where: { campaignId } });
    const linkIds = new Map(links.map((l) => [l.url, l.id]));
    const suppressed = await suppressedSet(c.productId, rows.map((r) => r.email));
    const leads = await Lead.findAll({ where: { id: rows.map((r) => r.leadId).filter((x): x is string => !!x) } });
    const byId = new Map(leads.map((l) => [l.id, l]));

    for (const r of rows) {
      const [mine] = await CampaignRecipient.update({ status: "sending" }, { where: { id: r.id, status: "queued" } });
      if (!mine) continue;
      const lead = r.leadId ? byId.get(r.leadId) : undefined;
      // They may have left since the audience was fixed.
      const skip = lead ? skipReason(lead, suppressed, !!c.audience?.includeUnknownConsent) : "suppressed";
      if (skip) {
        await r.update({ status: "skipped", skipReason: skip });
        continue;
      }
      const urls = trackingUrls(r.token);
      const out = renderForRecipient({
        subject: c.subject,
        bodyHtml: c.bodyHtml,
        bodyText: c.bodyText || c.previewText,
        values: { name: lead!.name, email: lead!.email, company: lead!.company },
        unsubscribeUrl: urls.unsubscribe,
        openPixelUrl: urls.open,
        linkIds,
        clickUrl: urls.click,
      });
      try {
        const { providerId } = await campaignTransport().send({
          from: sender,
          to: r.email,
          replyTo: c.replyTo,
          subject: out.subject,
          html: out.html,
          text: out.text,
          headers: { "List-Unsubscribe": `<${urls.unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        });
        await r.update({ status: "sent", sentAt: new Date(), providerId });
      } catch (err) {
        await r.update({ status: "failed", error: (err as Error).message.slice(0, 500) });
      }
    }
    await recomputeStats(campaignId);
    const remaining = await CampaignRecipient.count({ where: { campaignId, status: "queued" } });
    if (!remaining) return this.finish(c);
    await enqueue("campaigns", "batch", { campaignId }, { delay: 60_000, jobId: `campaign-batch-${campaignId}-${Date.now()}` });
  },

  async finish(c: Campaign): Promise<void> {
    const stats = await recomputeStats(c.id);
    await c.update({ status: "sent", finishedAt: new Date(), stats });
    await tell(c.createdBy, null, c, `Finished sending ${c.name}: ${stats.sent ?? 0} sent, ${stats.failed ?? 0} failed`);
  },
};

async function notifyApprovers(c: Campaign, fromUserId: string): Promise<void> {
  const rows = await sequelize.query<{ user_id: string }>(
    `SELECT DISTINCT aa.subject_id AS user_id
       FROM access_assignments aa JOIN access_roles r ON r.id = aa.role_id
      WHERE aa.subject_type = 'user'
        AND (r.permissions @> ARRAY['campaign.approve']::varchar[] OR r.permissions @> ARRAY['*']::varchar[])
        AND (aa.scope_type = 'organization' OR (aa.scope_type = 'product' AND aa.scope_id = :productId))
     UNION SELECT owner_id FROM products WHERE id = :productId AND owner_id IS NOT NULL`,
    { replacements: { productId: c.productId }, type: QueryTypes.SELECT },
  );
  for (const { user_id } of rows) await tell(user_id, fromUserId, c, `Needs approval: ${c.name}`);
}

// ---- Tracking (public, by unguessable token) -------------------------------

const findByToken = (token: string) => CampaignRecipient.findOne({ where: { token } });

export const tracking = {
  async open(token: string): Promise<void> {
    const r = await findByToken(token);
    if (!r) return;
    await r.update({ openCount: r.openCount + 1, openedAt: r.openedAt ?? new Date() });
  },

  // Only a link stored for this campaign can be a target, so this can't be used
  // as an open redirect. Null means there's nowhere to send them.
  async click(token: string, linkId: string): Promise<string | null> {
    const r = await findByToken(token);
    if (!r) return null;
    const link = await CampaignLink.findOne({ where: { id: linkId, campaignId: r.campaignId } });
    if (!link) return null;
    const first = !r.clickedAt;
    await r.update({ clickCount: r.clickCount + 1, clickedAt: r.clickedAt ?? new Date(), openedAt: r.openedAt ?? new Date() });
    await link.update({ clicks: link.clicks + 1, uniqueClicks: link.uniqueClicks + (first ? 1 : 0) });
    return link.url;
  },

  async unsubscribe(token: string): Promise<boolean> {
    const r = await findByToken(token);
    if (!r) return false;
    if (r.unsubscribedAt) return true;
    const c = await Campaign.findByPk(r.campaignId, { attributes: ["id", "productId"] });
    if (!c) return false;
    await r.update({ unsubscribedAt: new Date() });
    await addSuppression({ productId: c.productId, email: r.email, reason: "unsubscribed", note: `Campaign ${c.id}` });
    await Lead.update({ status: "unsubscribed", consent: "withdrawn" }, { where: { productId: c.productId, email: r.email } });
    await recomputeStats(c.id);
    return true;
  },

  // Resend signs webhooks the Svix way. Refused outright without a configured secret.
  verifyWebhook(rawBody: Buffer | undefined, headers: { id?: string; timestamp?: string; signature?: string }): boolean {
    const secret = env.RESEND_WEBHOOK_SECRET;
    if (!secret || !rawBody || !headers.id || !headers.timestamp || !headers.signature) return false;
    if (!isFreshTimestamp(headers.timestamp, Date.now())) return false;
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = createHmac("sha256", key).update(svixSignedContent(headers.id, headers.timestamp, rawBody.toString("utf8"))).digest();
    return headers.signature.split(" ").some((part) => {
      const [version, value] = part.split(",");
      if (version !== "v1" || !value) return false;
      const given = Buffer.from(value, "base64");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  },

  async webhook(event: { type?: string; data?: { email_id?: string } }): Promise<void> {
    const providerId = event.data?.email_id;
    if (!providerId) return;
    const r = await CampaignRecipient.findOne({ where: { providerId } });
    if (!r) return;
    const c = await Campaign.findByPk(r.campaignId, { attributes: ["id", "productId"] });
    if (!c) return;
    switch (event.type) {
      case "email.delivered":
        if (r.status === "sent") await r.update({ status: "delivered", deliveredAt: new Date() });
        break;
      case "email.bounced":
        await r.update({ status: "bounced" });
        await addSuppression({ productId: c.productId, email: r.email, reason: "bounced" });
        await Lead.update({ status: "bounced" }, { where: { productId: c.productId, email: r.email } });
        break;
      case "email.complained":
        await r.update({ complainedAt: new Date() });
        await addSuppression({ productId: c.productId, email: r.email, reason: "complained" });
        await Lead.update({ status: "unsubscribed", consent: "withdrawn" }, { where: { productId: c.productId, email: r.email } });
        break;
      default:
        return;
    }
    await recomputeStats(c.id);
  },
};
