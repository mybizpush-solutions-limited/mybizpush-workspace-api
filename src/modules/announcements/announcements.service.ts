import { Op, QueryTypes, type WhereOptions } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { audit } from "../../lib/audit";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors";
import { Announcement, AnnouncementReceipt, Attachment, User, type AudienceType } from "../../models";
import { emitToUser } from "../../realtime/events";
import { can } from "../access/engine";
import type { Scope } from "../access/catalog";
import { groupsService } from "../groups/groups.service";
import { notify } from "../shared/events";
import { refreshBadges, syncHint } from "../shared/live";
import { serializeAttachment } from "../shared/serializers";

// Announcements (API-CHANGES A303). Who receives one is fixed when it publishes,
// so acknowledgement counts can't shift as people join or leave a group.

const SYNC = ["announcements", "announcementReceipts"];
const REMIND_EVERY_MS = 60 * 60 * 1000;

export interface Audience {
  type: AudienceType;
  ids?: string[];
}

function scopesOf(type: AudienceType, ids: string[]): Scope[] {
  if (type === "organization" || type === "users") return [{ type: "organization", id: null }];
  return ids.map((id) => ({ type, id }));
}

async function canOnAudience(userId: string, permission: string, type: AudienceType, ids: string[]): Promise<boolean> {
  for (const scope of scopesOf(type, ids)) {
    if (!(await can({ sub: userId }, permission, scope))) return false;
  }
  return true;
}

function assertAudience(a: Audience): void {
  if (a.type !== "organization" && !a.ids?.length) throw badRequest("Pick who this announcement is for");
}

async function expandAudience(type: AudienceType, ids: string[]): Promise<string[]> {
  if (type === "organization") return (await User.findAll({ where: { status: "active" }, attributes: ["id"] })).map((u) => u.id);
  if (type === "users") return (await User.findAll({ where: { id: ids, status: "active" }, attributes: ["id"] })).map((u) => u.id);
  return groupsService.expandIds(ids.map((id) => ({ type, id })));
}

export function serializeAnnouncement(a: Announcement, attachments: Attachment[] = []) {
  const now = new Date();
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    audience: { type: a.audienceType, ids: a.audienceIds },
    status: a.status,
    requireAck: a.requireAck,
    pinned: a.pinned,
    publishAt: a.publishAt?.toISOString() ?? null,
    publishedAt: a.publishedAt?.toISOString() ?? null,
    expiresAt: a.expiresAt?.toISOString() ?? null,
    expired: !!a.expiresAt && a.expiresAt <= now,
    createdBy: a.createdBy ?? null,
    publishedBy: a.publishedBy ?? null,
    recipientCount: a.recipientCount,
    acknowledgedCount: a.acknowledgedCount,
    attachments: attachments.map(serializeAttachment),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function serializeReceipt(r: AnnouncementReceipt) {
  return {
    id: r.id,
    announcementId: r.announcementId,
    userId: r.userId,
    readAt: r.readAt?.toISOString() ?? null,
    acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    lastRemindedAt: r.lastRemindedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function attachmentsFor(ids: string[]): Promise<Map<string, Attachment[]>> {
  const map = new Map<string, Attachment[]>();
  if (!ids.length) return map;
  const rows = await Attachment.findAll({ where: { itemId: ids, itemType: "announcement" } });
  for (const r of rows) map.set(r.itemId, [...(map.get(r.itemId) ?? []), r]);
  return map;
}

async function full(a: Announcement) {
  return serializeAnnouncement(a, (await attachmentsFor([a.id])).get(a.id) ?? []);
}

async function load(id: string): Promise<Announcement> {
  const a = await Announcement.findByPk(id);
  if (!a) throw notFound("Announcement not found");
  return a;
}

const mayManage = async (a: Announcement, userId: string, permission: string) =>
  a.createdBy === userId || canOnAudience(userId, permission, a.audienceType, a.audienceIds);

async function receiptOf(announcementId: string, userId: string) {
  return AnnouncementReceipt.findOne({ where: { announcementId, userId } });
}

// The work of publishing, shared by "publish now" and the scheduler.
async function publishNow(a: Announcement, actorId: string | null): Promise<void> {
  const recipients = await expandAudience(a.audienceType, a.audienceIds);
  await sequelize.transaction(async (tx) => {
    // Rows that already exist are kept, so publishing twice can't lose a receipt.
    await AnnouncementReceipt.bulkCreate(recipients.map((userId) => ({ announcementId: a.id, userId })), { ignoreDuplicates: true, transaction: tx });
    await a.update({ status: "published", publishedAt: new Date(), publishedBy: actorId, recipientCount: recipients.length, publishAt: null }, { transaction: tx });
  });
  for (const userId of recipients) {
    emitToUser(userId, "announcement:new", { announcementId: a.id });
    await notify({
      userId,
      fromUserId: actorId,
      kind: "announcement",
      itemId: a.id,
      itemType: "announcement",
      message: a.requireAck ? `Please acknowledge: ${a.title}` : a.title,
    }).catch((err) => console.error("announcement notification failed", err));
  }
  syncHint(recipients, SYNC);
  refreshBadges(recipients);
}

export interface AnnouncementInput {
  id?: string;
  title: string;
  body: string;
  audience: Audience;
  requireAck?: boolean;
  pinned?: boolean;
  publishAt?: string | null;
  expiresAt?: string | null;
  publishNow?: boolean;
}

export const announcementsService = {
  async list(userId: string, q: { state?: string; unacknowledged?: boolean }) {
    const state = q.state ?? "active";
    const now = new Date();
    let rows: Announcement[];
    if (state === "drafts" || state === "scheduled" || state === "mine") {
      const status = state === "drafts" ? { status: "draft" } : state === "scheduled" ? { status: "scheduled" } : {};
      const sees = await can({ sub: userId }, "announcement.publish");
      const where: WhereOptions = state === "mine" || !sees ? { ...status, createdBy: userId } : status;
      rows = await Announcement.findAll({ where, order: [["updatedAt", "DESC"]], limit: 200 });
    } else {
      const expiry =
        state === "expired"
          ? { status: "published", expiresAt: { [Op.lte]: now } }
          : state === "archived"
            ? { status: "archived" }
            : { status: "published", [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: now } }] };
      const mine = sequelize.literal(`(SELECT announcement_id FROM announcement_receipts WHERE user_id = ${sequelize.escape(userId)})`);
      rows = await Announcement.findAll({ where: { ...expiry, id: { [Op.in]: mine } } as WhereOptions, order: [["pinned", "DESC"], ["publishedAt", "DESC"]], limit: 200 });
    }
    const receipts = rows.length ? await AnnouncementReceipt.findAll({ where: { userId, announcementId: rows.map((r) => r.id) } }) : [];
    const byAnn = new Map(receipts.map((r) => [r.announcementId, r]));
    const files = await attachmentsFor(rows.map((r) => r.id));
    const needsAck = (a: Announcement) => a.requireAck && !!byAnn.get(a.id) && !byAnn.get(a.id)!.acknowledgedAt;
    const out = (q.unacknowledged ? rows.filter(needsAck) : rows).map((a) => ({
      a,
      view: { ...serializeAnnouncement(a, files.get(a.id) ?? []), receipt: byAnn.has(a.id) ? serializeReceipt(byAnn.get(a.id)!) : null },
    }));
    // Stable: unacknowledged first, the query's order otherwise.
    return out.sort((x, y) => Number(needsAck(y.a)) - Number(needsAck(x.a))).map((x) => x.view);
  },

  async get(id: string, userId: string) {
    const a = await load(id);
    const receipt = await receiptOf(id, userId);
    if (!receipt && !(await mayManage(a, userId, "announcement.publish"))) throw notFound("Announcement not found");
    return { announcement: await full(a), receipt: receipt ? serializeReceipt(receipt) : null };
  },

  async create(input: AnnouncementInput, userId: string, req?: Parameters<typeof audit>[0]["req"]) {
    assertAudience(input.audience);
    const ids = input.audience.type === "organization" ? [] : (input.audience.ids ?? []);
    if (!(await canOnAudience(userId, "announcement.draft", input.audience.type, ids))) throw forbidden("You can't write announcements for this audience");
    const publishing = !!input.publishNow || !!input.publishAt;
    if (publishing && !(await canOnAudience(userId, "announcement.publish", input.audience.type, ids))) throw forbidden("You can't publish to this audience");
    if (input.publishAt && new Date(input.publishAt) <= new Date()) throw badRequest("Pick a publish time in the future");
    if (input.expiresAt && new Date(input.expiresAt) <= new Date()) throw badRequest("Pick an expiry in the future");

    const a = await Announcement.create({
      ...(input.id ? { id: input.id } : {}),
      title: input.title,
      body: input.body,
      audienceType: input.audience.type,
      audienceIds: ids,
      requireAck: input.requireAck ?? false,
      pinned: input.pinned ?? false,
      status: input.publishAt && !input.publishNow ? "scheduled" : "draft",
      publishAt: input.publishAt && !input.publishNow ? new Date(input.publishAt) : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdBy: userId,
    });
    if (input.publishNow) {
      await publishNow(a, userId);
      await audit({ req, actorId: userId, action: "announcement.publish", target: { type: "announcement", id: a.id }, after: { audience: input.audience } });
    }
    return full(a);
  },

  async update(id: string, patch: Partial<AnnouncementInput>, userId: string) {
    const a = await load(id);
    if (!(await mayManage(a, userId, "announcement.edit"))) throw forbidden("You can't edit this announcement");
    if (a.status === "archived") throw new AppError(409, "This announcement is archived", "archived");
    if (a.status === "published") {
      // What people were told, and who was told it, stay as they were.
      const blocked = (["title", "body", "audience", "requireAck", "publishAt"] as const).filter((k) => patch[k] !== undefined);
      if (blocked.length) throw new AppError(409, "A published announcement can only change its expiry or pin", "published");
    }
    const audienceChange = patch.audience ? { audienceType: patch.audience.type, audienceIds: patch.audience.type === "organization" ? [] : (patch.audience.ids ?? []) } : {};
    if (patch.audience) {
      assertAudience(patch.audience);
      if (!(await canOnAudience(userId, "announcement.draft", patch.audience.type, audienceChange.audienceIds!))) throw forbidden("You can't write announcements for this audience");
    }
    if (patch.publishAt) {
      const target = { type: patch.audience?.type ?? a.audienceType, ids: audienceChange.audienceIds ?? a.audienceIds };
      if (!(await canOnAudience(userId, "announcement.publish", target.type, target.ids))) throw forbidden("You can't publish to this audience");
      if (new Date(patch.publishAt) <= new Date()) throw badRequest("Pick a publish time in the future");
    }
    await a.update({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...audienceChange,
      ...(patch.requireAck !== undefined ? { requireAck: patch.requireAck } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt ? new Date(patch.expiresAt) : null } : {}),
      ...(patch.publishAt !== undefined && a.status !== "published"
        ? { publishAt: patch.publishAt ? new Date(patch.publishAt) : null, status: patch.publishAt ? ("scheduled" as const) : ("draft" as const) }
        : {}),
    });
    syncHint([userId], SYNC);
    return full(a);
  },

  async publish(id: string, userId: string, req?: Parameters<typeof audit>[0]["req"]) {
    const a = await load(id);
    if (!(await canOnAudience(userId, "announcement.publish", a.audienceType, a.audienceIds))) throw forbidden("You can't publish to this audience");
    if (a.status === "published") return full(a);
    if (a.status === "archived") throw new AppError(409, "This announcement is archived", "archived");
    await publishNow(a, userId);
    await audit({ req, actorId: userId, action: "announcement.publish", target: { type: "announcement", id }, after: { audience: { type: a.audienceType, ids: a.audienceIds }, recipients: a.recipientCount } });
    return full(a);
  },

  async archive(id: string, userId: string, req?: Parameters<typeof audit>[0]["req"]) {
    const a = await load(id);
    if (!(await mayManage(a, userId, "announcement.archive"))) throw forbidden("You can't archive this announcement");
    await a.update({ status: "archived" });
    await audit({ req, actorId: userId, action: "announcement.archive", target: { type: "announcement", id } });
    const people = await AnnouncementReceipt.findAll({ where: { announcementId: id }, attributes: ["userId"] });
    syncHint(people.map((p) => p.userId), SYNC);
    refreshBadges(people.map((p) => p.userId));
    return full(a);
  },

  async markRead(id: string, userId: string) {
    const receipt = await receiptOf(id, userId);
    if (!receipt) throw notFound("Announcement not found");
    if (!receipt.readAt) await receipt.update({ readAt: new Date() });
    syncHint([userId], ["announcementReceipts"]);
    return serializeReceipt(receipt);
  },

  async acknowledge(id: string, userId: string) {
    const receipt = await receiptOf(id, userId);
    if (!receipt) throw notFound("Announcement not found");
    if (!receipt.acknowledgedAt) {
      const now = new Date();
      await receipt.update({ acknowledgedAt: now, readAt: receipt.readAt ?? now });
      await Announcement.increment("acknowledgedCount", { where: { id } });
    }
    syncHint([userId], SYNC);
    refreshBadges([userId]);
    return serializeReceipt(receipt);
  },

  async acknowledgements(id: string, userId: string) {
    const a = await load(id);
    if (!(await mayManage(a, userId, "announcement.publish"))) throw forbidden("You can't see acknowledgements for this announcement");
    const rows = await sequelize.query<{ user_id: string; name: string; avatar_url: string | null; acknowledged_at: Date | null }>(
      `SELECT r.user_id, u.name, u.avatar_url, r.acknowledged_at
         FROM announcement_receipts r JOIN users u ON u.id = r.user_id
        WHERE r.announcement_id = :id ORDER BY u.name`,
      { replacements: { id }, type: QueryTypes.SELECT },
    );
    return {
      acknowledged: rows.filter((r) => r.acknowledged_at).map((r) => ({ userId: r.user_id, name: r.name, avatarUrl: r.avatar_url, at: new Date(r.acknowledged_at!).toISOString() })),
      pending: rows.filter((r) => !r.acknowledged_at).map((r) => ({ userId: r.user_id, name: r.name, avatarUrl: r.avatar_url })),
    };
  },

  async remind(id: string, userId: string) {
    const a = await load(id);
    if (!(await mayManage(a, userId, "announcement.publish"))) throw forbidden("You can't send reminders for this announcement");
    if (a.status !== "published") throw new AppError(409, "Only published announcements have reminders", "not_published");
    const cutoff = new Date(Date.now() - REMIND_EVERY_MS);
    const pending = await AnnouncementReceipt.findAll({
      where: { announcementId: id, acknowledgedAt: null, [Op.or]: [{ lastRemindedAt: null }, { lastRemindedAt: { [Op.lt]: cutoff } }] },
    });
    for (const r of pending) {
      await r.update({ lastRemindedAt: new Date() });
      await notify({ userId: r.userId, fromUserId: userId, kind: "announcement", itemId: id, itemType: "announcement", message: `Reminder, please acknowledge: ${a.title}` });
    }
    return pending.length;
  },

  // Every minute in the worker. Claims each row first, so two workers can't both
  // publish the same announcement.
  async publishDue(): Promise<number> {
    const due = await Announcement.findAll({ where: { status: "scheduled", publishAt: { [Op.lte]: new Date() } }, attributes: ["id"], limit: 50 });
    let done = 0;
    for (const { id } of due) {
      const [claimed] = await Announcement.update({ status: "draft" }, { where: { id, status: "scheduled" } });
      if (!claimed) continue;
      const a = await Announcement.findByPk(id);
      if (!a) continue;
      await publishNow(a, a.createdBy ?? null);
      await audit({ actorId: a.createdBy, action: "announcement.publish", target: { type: "announcement", id }, after: { scheduled: true, recipients: a.recipientCount } });
      done++;
    }
    return done;
  },

  // For the Home attention list.
  async pendingAcknowledgements(userId: string, limit = 5) {
    const now = new Date();
    const rows = await sequelize.query<{ id: string; title: string; published_at: Date }>(
      `SELECT a.id, a.title, a.published_at
         FROM announcements a JOIN announcement_receipts r ON r.announcement_id = a.id
        WHERE r.user_id = :userId AND r.acknowledged_at IS NULL AND a.require_ack
          AND a.status = 'published' AND (a.expires_at IS NULL OR a.expires_at > :now)
        ORDER BY a.published_at DESC LIMIT :limit`,
      { replacements: { userId, now, limit }, type: QueryTypes.SELECT },
    );
    return rows;
  },
};
