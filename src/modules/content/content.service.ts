import { Op, type WhereOptions } from "sequelize";
import { audit } from "../../lib/audit";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors";
import { Attachment, ContentEvent, ContentItem, SocialAccount } from "../../models";
import { can } from "../access/engine";
import { assertCanSeeRecord, viewerFor, visibleIds } from "../access/visibility";
import { notify } from "../shared/events";
import { syncHint } from "../shared/live";
import { serializeAttachment } from "../shared/serializers";
import { decideContentMove, type ContentActor, type ContentStatus, type ContentVia } from "./content.workflow";

// Content planning (API-CHANGES A603) and product social accounts (A604).

type Req = Parameters<typeof audit>[0]["req"];
const productScope = (id: string) => ({ type: "product" as const, id });
const SYNC = ["contentItems", "contentEvents"];

export function serializeContent(c: ContentItem, attachments: Attachment[] = []) {
  return {
    id: c.id,
    productId: c.productId,
    title: c.title,
    type: c.type,
    platform: c.platform ?? null,
    status: c.status,
    brief: c.brief,
    caption: c.caption,
    writerId: c.writerId ?? null,
    designerId: c.designerId ?? null,
    reviewerId: c.reviewerId ?? null,
    publishAt: c.publishAt?.toISOString() ?? null,
    publishedAt: c.publishedAt?.toISOString() ?? null,
    blogPostId: c.blogPostId ?? null,
    url: c.url ?? null,
    attachments: attachments.map(serializeAttachment),
    createdBy: c.createdBy ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function serializeContentEvent(e: ContentEvent) {
  return {
    id: e.id,
    contentId: e.contentId,
    kind: e.kind,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    decision: e.decision ?? null,
    note: e.note ?? null,
    actorId: e.actorId ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

export const serializeSocial = (s: SocialAccount) => ({
  id: s.id,
  productId: s.productId,
  platform: s.platform,
  handle: s.handle,
  url: s.url ?? null,
  ownerId: s.ownerId ?? null,
  notes: s.notes,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

const people = (c: ContentItem) => [c.writerId, c.designerId, c.reviewerId, c.createdBy];

async function load(id: string): Promise<ContentItem> {
  const c = await ContentItem.findByPk(id);
  if (!c) throw notFound("Content item not found");
  return c;
}

// Sync and lists: through the shared rule.
export async function contentVisibleWhere(userId: string): Promise<WhereOptions> {
  return { id: visibleIds(await viewerFor(userId), "content") } as WhereOptions;
}

async function rolesOf(c: ContentItem, userId: string): Promise<Set<ContentActor>> {
  const roles = new Set<ContentActor>();
  if (c.writerId === userId) roles.add("writer");
  if (c.designerId === userId) roles.add("designer");
  if (await can({ sub: userId }, "content.create", productScope(c.productId))) roles.add("manager");
  if (c.reviewerId === userId || (await can({ sub: userId }, "content.approve", productScope(c.productId)))) roles.add("reviewer");
  return roles;
}

function refuse(code: "invalid_transition" | "not_allowed_transition" | "use_endpoint", message: string): never {
  throw new AppError(code === "not_allowed_transition" ? 403 : 409, message, code);
}

async function move(c: ContentItem, to: ContentStatus, userId: string, via: ContentVia): Promise<void> {
  const d = decideContentMove({ from: c.status as ContentStatus, to, roles: await rolesOf(c, userId), via });
  if (!d.allowed) refuse(d.code, d.message);
}

const tell = (userId: string | null | undefined, from: string, c: ContentItem, message: string) =>
  userId ? notify({ userId, fromUserId: from, kind: "content", itemId: c.id, itemType: "content", message }) : Promise.resolve();

export interface ContentInput {
  id?: string;
  productId: string;
  title: string;
  type: ContentItem["type"];
  platform?: ContentItem["platform"];
  brief?: string;
  caption?: string;
  writerId?: string | null;
  designerId?: string | null;
  reviewerId?: string | null;
  publishAt?: string | null;
  blogPostId?: string | null;
  url?: string | null;
}

export const contentService = {
  async list(userId: string, q: { productId?: string; status?: string; type?: string; platform?: string; from?: string; to?: string; assigneeId?: string; limit?: number; offset?: number }) {
    const ands: WhereOptions[] = [await contentVisibleWhere(userId)];
    if (q.productId) ands.push({ productId: q.productId });
    if (q.status) ands.push({ status: q.status.split(",") });
    if (q.type) ands.push({ type: q.type });
    if (q.platform) ands.push({ platform: q.platform });
    if (q.assigneeId) ands.push({ [Op.or]: [{ writerId: q.assigneeId }, { designerId: q.assigneeId }, { reviewerId: q.assigneeId }] } as WhereOptions);
    if (q.from) ands.push({ publishAt: { [Op.gte]: new Date(q.from) } });
    if (q.to) ands.push({ publishAt: { [Op.lte]: new Date(q.to) } });
    const { rows, count } = await ContentItem.findAndCountAll({ where: { [Op.and]: ands }, order: [["publishAt", "ASC"], ["createdAt", "DESC"]], limit: q.limit ?? 100, offset: q.offset ?? 0 });
    const files = rows.length ? await Attachment.findAll({ where: { itemType: "content", itemId: rows.map((r) => r.id) } }) : [];
    return { items: rows.map((c) => serializeContent(c, files.filter((f) => f.itemId === c.id))), total: count };
  },

  async get(id: string, userId: string) {
    await assertCanSeeRecord(userId, "content", id);
    const c = await load(id);
    const [events, files] = await Promise.all([
      ContentEvent.findAll({ where: { contentId: id }, order: [["createdAt", "ASC"]] }),
      Attachment.findAll({ where: { itemType: "content", itemId: id } }),
    ]);
    return { item: serializeContent(c, files), events: events.map(serializeContentEvent) };
  },

  async create(input: ContentInput, userId: string) {
    if (!(await can({ sub: userId }, "content.create", productScope(input.productId)))) throw forbidden("You can't create content for this product");
    if (input.id) {
      const existing = await ContentItem.findByPk(input.id);
      if (existing) return serializeContent(existing);
    }
    const c = await ContentItem.create({
      ...(input.id ? { id: input.id } : {}),
      productId: input.productId,
      title: input.title,
      type: input.type,
      platform: input.platform ?? null,
      brief: input.brief ?? "",
      caption: input.caption ?? "",
      writerId: input.writerId ?? null,
      designerId: input.designerId ?? null,
      reviewerId: input.reviewerId ?? null,
      publishAt: input.publishAt ? new Date(input.publishAt) : null,
      blogPostId: input.blogPostId ?? null,
      url: input.url ?? null,
      createdBy: userId,
    });
    await ContentEvent.create({ contentId: c.id, kind: "created", toStatus: c.status, actorId: userId });
    for (const uid of new Set([c.writerId, c.designerId])) await tell(uid, userId, c, `New content to work on: ${c.title}`);
    if (c.reviewerId) await tell(c.reviewerId, userId, c, `You'll review: ${c.title}`);
    syncHint(people(c), SYNC);
    return serializeContent(c);
  },

  async update(id: string, patch: Partial<Omit<ContentInput, "id" | "productId">>, userId: string) {
    const c = await load(id);
    const named = c.writerId === userId || c.designerId === userId;
    if (!named && !(await can({ sub: userId }, "content.create", productScope(c.productId)))) throw forbidden("You can't edit this");
    if (c.status === "published") throw new AppError(409, "Published content can't be edited", "published");
    const before = { writerId: c.writerId, designerId: c.designerId, reviewerId: c.reviewerId };
    await c.update({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.platform !== undefined ? { platform: patch.platform } : {}),
      ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
      ...(patch.caption !== undefined ? { caption: patch.caption } : {}),
      ...(patch.writerId !== undefined ? { writerId: patch.writerId } : {}),
      ...(patch.designerId !== undefined ? { designerId: patch.designerId } : {}),
      ...(patch.reviewerId !== undefined ? { reviewerId: patch.reviewerId } : {}),
      ...(patch.publishAt !== undefined ? { publishAt: patch.publishAt ? new Date(patch.publishAt) : null } : {}),
      ...(patch.blogPostId !== undefined ? { blogPostId: patch.blogPostId } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
    });
    if (c.writerId !== before.writerId) await tell(c.writerId, userId, c, `New content to work on: ${c.title}`);
    if (c.designerId !== before.designerId) await tell(c.designerId, userId, c, `New content to work on: ${c.title}`);
    if (c.reviewerId !== before.reviewerId) await tell(c.reviewerId, userId, c, `You'll review: ${c.title}`);
    syncHint(people(c), SYNC);
    return serializeContent(c);
  },

  async setStatus(id: string, status: ContentStatus, note: string | undefined, userId: string) {
    const c = await load(id);
    await move(c, status, userId, "status");
    const from = c.status;
    if (from === status) return serializeContent(c);
    await c.update({ status });
    await ContentEvent.create({ contentId: id, kind: "status", fromStatus: from, toStatus: status, note: note ?? null, actorId: userId });
    if (status === "in_review") await tell(c.reviewerId, userId, c, `Ready for review: ${c.title}`);
    syncHint(people(c), SYNC);
    return serializeContent(c);
  },

  async review(id: string, input: { decision: "approve" | "request_revision"; note?: string }, userId: string, req?: Req) {
    const c = await load(id);
    if (input.decision === "request_revision" && !input.note) throw badRequest("Say what needs to change");
    if (c.status !== "in_review") throw new AppError(409, "This isn't waiting for a review", "not_reviewable");
    const to: ContentStatus = input.decision === "approve" ? "approved" : "revision_required";
    await move(c, to, userId, "review");
    if (c.writerId === userId || c.designerId === userId) throw new AppError(403, "You can't review your own work", "self_review");
    const from = c.status;
    await c.update({ status: to });
    const event = await ContentEvent.create({ contentId: id, kind: "review", fromStatus: from, toStatus: to, decision: input.decision, note: input.note ?? null, actorId: userId });
    await audit({ req, actorId: userId, action: `content.review.${input.decision}`, target: { type: "content", id }, scope: productScope(c.productId) });
    const message = input.decision === "approve" ? `Approved: ${c.title}` : `Changes requested: ${c.title}`;
    for (const uid of new Set([c.writerId, c.designerId, c.createdBy])) await tell(uid, userId, c, message);
    syncHint(people(c), SYNC);
    return { item: serializeContent(c), event: serializeContentEvent(event) };
  },

  async publish(id: string, input: { url?: string; publishedAt?: string }, userId: string, req?: Req) {
    const c = await load(id);
    if (!(await can({ sub: userId }, "content.publish", productScope(c.productId)))) throw forbidden("You can't publish content for this product");
    const d = decideContentMove({ from: c.status as ContentStatus, to: "published", roles: new Set<ContentActor>(["manager"]), via: "publish" });
    if (!d.allowed) refuse(d.code, d.message);
    const from = c.status;
    await c.update({ status: "published", publishedAt: input.publishedAt ? new Date(input.publishedAt) : new Date(), ...(input.url ? { url: input.url } : {}) });
    await ContentEvent.create({ contentId: id, kind: "status", fromStatus: from, toStatus: "published", actorId: userId });
    await audit({ req, actorId: userId, action: "content.publish", target: { type: "content", id }, scope: productScope(c.productId) });
    for (const uid of new Set([c.writerId, c.designerId, c.reviewerId])) await tell(uid, userId, c, `Published: ${c.title}`);
    syncHint(people(c), SYNC);
    return serializeContent(c);
  },

  async remove(id: string, userId: string): Promise<void> {
    const c = await load(id);
    if (c.createdBy !== userId && !(await can({ sub: userId }, "content.approve", productScope(c.productId)))) throw forbidden("You can't delete this");
    await c.destroy();
    syncHint(people(c), SYNC);
  },

  // ---- Social accounts -----------------------------------------------------
  async socialAccounts(productId: string, userId: string) {
    if (!(await can({ sub: userId }, "product.view", productScope(productId)))) throw forbidden("You can't see this product");
    return (await SocialAccount.findAll({ where: { productId }, order: [["platform", "ASC"]] })).map(serializeSocial);
  },
  async addSocial(productId: string, input: { id?: string; platform: string; handle: string; url?: string | null; ownerId?: string | null; notes?: string }, userId: string) {
    if (!(await can({ sub: userId }, "product.edit", productScope(productId)))) throw forbidden("You can't edit this product");
    const row = await SocialAccount.create({ ...(input.id ? { id: input.id } : {}), productId, platform: input.platform, handle: input.handle, url: input.url ?? null, ownerId: input.ownerId ?? null, notes: input.notes ?? "" });
    return serializeSocial(row);
  },
  async updateSocial(id: string, patch: { platform?: string; handle?: string; url?: string | null; ownerId?: string | null; notes?: string }, userId: string) {
    const row = await SocialAccount.findByPk(id);
    if (!row) throw notFound("Account not found");
    if (!(await can({ sub: userId }, "product.edit", productScope(row.productId)))) throw forbidden("You can't edit this product");
    await row.update(patch);
    return serializeSocial(row);
  },
  async removeSocial(id: string, userId: string): Promise<void> {
    const row = await SocialAccount.findByPk(id);
    if (!row) throw notFound("Account not found");
    if (!(await can({ sub: userId }, "product.edit", productScope(row.productId)))) throw forbidden("You can't edit this product");
    await row.destroy();
  },
};
