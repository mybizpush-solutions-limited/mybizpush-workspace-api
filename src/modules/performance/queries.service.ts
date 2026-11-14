import { Op, type WhereOptions } from "sequelize";
import { audit } from "../../lib/audit";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors";
import { Attachment, StaffQuery, StaffQueryEvent, User, type QueryStatus } from "../../models";
import { can } from "../access/engine";
import { canOverUser } from "../access/reach";
import { createDoc, CW, decorate, finish, FAINT, GREY, h1, INK, letterhead, M, confidentialChip } from "../reports/pdfChrome";
import { notify } from "../shared/events";
import { syncHint } from "../shared/live";
import { serializeAttachment } from "../shared/serializers";
import { canMoveQuery, queryReference } from "./target.calc";

// Staff queries (API-CHANGES A501, PRD 12). Confidential: without access, a query
// answers 404, so that even its existence stays private.

const SYNC = ["staffQueries"];
type Req = Parameters<typeof audit>[0]["req"];

export const seesAllQueries = async (userId: string) => (await can({ sub: userId }, "query.view")) || (await can({ sub: userId }, "hr.view"));

export function serializeQuery(q: StaffQuery, attachments: Attachment[] = []) {
  return {
    id: q.id,
    reference: queryReference(q.seq, q.createdAt),
    staffId: q.staffId,
    issuedBy: q.issuedBy ?? null,
    category: q.category,
    subject: q.subject,
    body: q.body,
    deadlineAt: q.deadlineAt.toISOString(),
    overdue: q.status === "issued" && q.deadlineAt < new Date(),
    status: q.status,
    response: q.response ?? null,
    respondedAt: q.respondedAt?.toISOString() ?? null,
    decision: q.decision ?? null,
    decisionNote: q.decisionNote ?? null,
    reviewedBy: q.reviewedBy ?? null,
    reviewedAt: q.reviewedAt?.toISOString() ?? null,
    resolvedBy: q.resolvedBy ?? null,
    resolvedAt: q.resolvedAt?.toISOString() ?? null,
    attachments: attachments.map(serializeAttachment),
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

const attachmentsOf = (q: StaffQuery) => (q.attachmentIds.length ? Attachment.findAll({ where: { id: q.attachmentIds, itemType: "query", itemId: q.id } }) : Promise.resolve([] as Attachment[]));
const full = async (q: StaffQuery) => serializeQuery(q, await attachmentsOf(q));

async function loadVisible(id: string, userId: string): Promise<StaffQuery> {
  const q = await StaffQuery.findByPk(id);
  if (!q || !(q.staffId === userId || q.issuedBy === userId || (await seesAllQueries(userId)))) throw notFound("Query not found");
  return q;
}

function assertMove(q: StaffQuery, to: QueryStatus): void {
  if (!canMoveQuery(q.status, to)) throw new AppError(409, `A query can't move from ${q.status} to ${to}`, "invalid_transition");
}

async function record(q: StaffQuery, kind: string, actorId: string, note: string | null, req: Req): Promise<void> {
  await StaffQueryEvent.create({ queryId: q.id, kind, actorId, note });
  // The audit trail names the action, not the confidential text.
  await audit({ req, actorId, action: `query.${kind}`, target: { type: "query", id: q.id }, after: { status: q.status, staffId: q.staffId, decision: q.decision ?? null } });
  syncHint([q.staffId, q.issuedBy], SYNC);
}

const tell = (userId: string | null | undefined, fromUserId: string | null, q: StaffQuery, message: string) =>
  userId ? notify({ userId, fromUserId, kind: "query", itemId: q.id, itemType: "query", message }) : Promise.resolve();

export interface QueryInput {
  id?: string;
  staffId: string;
  category: StaffQuery["category"];
  subject: string;
  body: string;
  deadlineAt: string;
}

async function assertMayIssue(input: QueryInput, userId: string): Promise<void> {
  if (input.staffId === userId) throw badRequest("You can't issue a query to yourself");
  if (!(await canOverUser(userId, "query.issue", input.staffId, ["department"]))) throw forbidden("You can't issue a query to this person");
  const staff = await User.findByPk(input.staffId, { attributes: ["id"] });
  if (!staff) throw badRequest("That person no longer exists");
  if (new Date(input.deadlineAt) <= new Date()) throw badRequest("Pick a response deadline in the future");
}

async function letterPdf(p: { reference: string; date: Date; staffName: string; issuerName: string; category: string; subject: string; body: string; deadlineAt: Date; draft: boolean }): Promise<Buffer> {
  const title = `Staff query ${p.reference}`;
  const { doc, chunks } = createDoc(title);
  letterhead(doc);
  confidentialChip(doc, M, doc.y);
  doc.moveDown(2);
  doc.font("bold").fontSize(15).fillColor(INK).text(p.draft ? `${p.subject} (draft)` : p.subject, M, doc.y, { width: CW });
  doc.moveDown(0.5);
  doc.font("reg").fontSize(9.5).fillColor(GREY);
  for (const line of [`Reference: ${p.reference}`, `Date: ${p.date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, `To: ${p.staffName}`, `From: ${p.issuerName}`, `Category: ${p.category}`]) {
    doc.text(line, M, doc.y, { width: CW });
  }
  h1(doc, "Query");
  doc.font("reg").fontSize(10.5).fillColor(INK).text(p.body, M, doc.y, { width: CW, lineGap: 2.5 });
  doc.moveDown(1);
  doc
    .font("bold")
    .fontSize(10.5)
    .fillColor(INK)
    .text(`Please respond by ${p.deadlineAt.toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "Africa/Lagos" })}.`, M, doc.y, { width: CW });
  doc.moveDown(1);
  doc.font("reg").fontSize(8).fillColor(FAINT).text("This letter is confidential and is held on your staff record. Respond in MyBizPush Workspace.", M, doc.y, { width: CW });
  decorate(doc, title);
  return finish(doc, chunks);
}

const nameOf = async (id: string | null | undefined) => (id ? ((await User.findByPk(id, { attributes: ["name"] }))?.name ?? "") : "");

export const queriesService = {
  async list(userId: string, q: { segment?: "received" | "issued" | "all"; status?: string; staffId?: string; category?: string }) {
    const where: Record<string, unknown> = {};
    const segment = q.segment ?? "received";
    if (segment === "received") where.staffId = userId;
    else if (segment === "issued") where.issuedBy = userId;
    else if (!(await seesAllQueries(userId))) throw forbidden("You can't see every query");
    if (q.status) where.status = q.status;
    if (q.category) where.category = q.category;
    if (q.staffId) {
      // Named filters can't widen a segment: received stays yours.
      if (segment === "received" && q.staffId !== userId) return [];
      where.staffId = q.staffId;
    }
    const rows = await StaffQuery.findAll({ where: where as WhereOptions, order: [["createdAt", "DESC"]], limit: 200 });
    return Promise.all(rows.map(full));
  },

  async get(id: string, userId: string) {
    const q = await loadVisible(id, userId);
    const events = await StaffQueryEvent.findAll({ where: { queryId: id }, order: [["createdAt", "ASC"]] });
    return {
      query: await full(q),
      events: events.map((e) => ({ id: e.id, kind: e.kind, actorId: e.actorId ?? null, note: e.note ?? null, createdAt: e.createdAt.toISOString() })),
    };
  },

  async issue(input: QueryInput, userId: string, req?: Req) {
    await assertMayIssue(input, userId);
    if (input.id) {
      const existing = await StaffQuery.findByPk(input.id);
      if (existing) {
        if (existing.issuedBy !== userId) throw badRequest("That id is already used");
        return full(existing);
      }
    }
    const q = await StaffQuery.create({
      ...(input.id ? { id: input.id } : {}),
      staffId: input.staffId,
      issuedBy: userId,
      category: input.category,
      subject: input.subject,
      body: input.body,
      deadlineAt: new Date(input.deadlineAt),
    });
    await q.reload();
    await record(q, "issued", userId, null, req);
    await tell(q.staffId, userId, q, "You've received a staff query");
    return full(q);
  },

  async respond(id: string, input: { response: string; attachmentIds?: string[] }, userId: string, req?: Req) {
    const q = await loadVisible(id, userId);
    if (q.staffId !== userId) throw forbidden("Only the person queried can respond");
    assertMove(q, "responded");
    const ids = input.attachmentIds ?? [];
    if (ids.length) {
      const files = await Attachment.findAll({ where: { id: ids } });
      if (files.length !== new Set(ids).size || files.some((a) => a.itemType !== "query" || a.itemId !== id || a.uploadedBy !== userId)) {
        throw forbidden("One of the files isn't yours to attach");
      }
    }
    await q.update({ response: input.response, respondedAt: new Date(), status: "responded", attachmentIds: ids });
    await record(q, "responded", userId, null, req);
    await tell(q.issuedBy, userId, q, "A staff query has a response");
    return full(q);
  },

  async review(id: string, note: string | undefined, userId: string, req?: Req) {
    const q = await loadVisible(id, userId);
    if (!(await can({ sub: userId }, "query.review"))) throw forbidden("You can't review queries");
    assertMove(q, "under_review");
    await q.update({ status: "under_review", reviewedBy: userId, reviewedAt: new Date() });
    await record(q, "under_review", userId, note ?? null, req);
    return full(q);
  },

  async resolve(id: string, input: { decision: StaffQuery["decision"]; decisionNote?: string }, userId: string, req?: Req) {
    const q = await loadVisible(id, userId);
    if (!(await can({ sub: userId }, "query.resolve"))) throw forbidden("You can't resolve queries");
    assertMove(q, "resolved");
    await q.update({ status: "resolved", decision: input.decision, decisionNote: input.decisionNote ?? null, resolvedBy: userId, resolvedAt: new Date() });
    await record(q, "resolved", userId, input.decisionNote ?? null, req);
    await tell(q.staffId, userId, q, "A staff query has been decided");
    return full(q);
  },

  async withdraw(id: string, reason: string | undefined, userId: string, req?: Req) {
    const q = await loadVisible(id, userId);
    if (q.issuedBy !== userId && !(await can({ sub: userId }, "query.resolve"))) throw forbidden("You can't withdraw this query");
    assertMove(q, "withdrawn");
    await q.update({ status: "withdrawn" });
    await record(q, "withdrawn", userId, reason ?? null, req);
    await tell(q.staffId, userId, q, "A staff query was withdrawn");
    return full(q);
  },

  async letter(id: string, userId: string, req?: Req) {
    const q = await loadVisible(id, userId);
    const buffer = await letterPdf({
      reference: queryReference(q.seq, q.createdAt),
      date: q.createdAt,
      staffName: await nameOf(q.staffId),
      issuerName: await nameOf(q.issuedBy),
      category: q.category,
      subject: q.subject,
      body: q.body,
      deadlineAt: q.deadlineAt,
      draft: false,
    });
    await audit({ req, actorId: userId, action: "query.letter", target: { type: "query", id } });
    return { buffer, fileName: `${queryReference(q.seq, q.createdAt)}.pdf` };
  },

  async previewLetter(input: QueryInput, userId: string) {
    await assertMayIssue(input, userId);
    return letterPdf({
      reference: "Draft",
      date: new Date(),
      staffName: await nameOf(input.staffId),
      issuerName: await nameOf(userId),
      category: input.category,
      subject: input.subject,
      body: input.body,
      deadlineAt: new Date(input.deadlineAt),
      draft: true,
    });
  },

  // Hourly: one reminder a day before the deadline if nothing has come back.
  async remindDue(): Promise<void> {
    const now = new Date();
    const rows = await StaffQuery.findAll({
      where: { status: "issued", reminderSentAt: null, deadlineAt: { [Op.gt]: now, [Op.lte]: new Date(now.getTime() + 24 * 3600_000) } },
    });
    for (const q of rows) {
      const [claimed] = await StaffQuery.update({ reminderSentAt: now }, { where: { id: q.id, reminderSentAt: null } });
      if (claimed) await tell(q.staffId, null, q, "A staff query is waiting for your response");
    }
  },
};

export function queriesVisibleTo(userId: string, seesAll: boolean): WhereOptions {
  if (seesAll) return {};
  return { [Op.or]: [{ staffId: userId }, { issuedBy: userId }] };
}
