import { randomUUID } from "node:crypto";
import { Op, QueryTypes, type WhereOptions } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { audit } from "../../lib/audit";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors";
import { enqueue } from "../../jobs/queues";
import { Campaign, CampaignRecipient, Lead, LeadList, LeadSegment, Product, Suppression, type LeadConsent, type SegmentRule, type SegmentRules } from "../../models";
import { redis } from "../../redis/client";
import { can } from "../access/engine";
import { parseCsv, parseXlsx } from "../staff/staff.import";
import { classifyImportRow, domainOf, isEmail, normalizeEmail, type ImportRowStatus } from "./campaign.render";

// Leads, lists, segments, imports and suppression (API-CHANGES A601). Everything
// belongs to one product and is checked against that product.

type Req = Parameters<typeof audit>[0]["req"];
const productScope = (id: string) => ({ type: "product" as const, id });

export async function requireOnProduct(userId: string, permission: string, productId: string): Promise<void> {
  if (!(await can({ sub: userId }, permission, productScope(productId)))) throw forbidden("You don't have permission to do this for this product");
}

export function serializeLead(l: Lead, listIds: string[] = []) {
  return {
    id: l.id,
    productId: l.productId,
    email: l.email,
    name: l.name,
    company: l.company,
    phone: l.phone ?? null,
    source: l.source,
    tags: l.tags,
    consent: l.consent,
    consentAt: l.consentAt?.toISOString() ?? null,
    consentSource: l.consentSource ?? null,
    status: l.status,
    ownerId: l.ownerId ?? null,
    custom: l.custom,
    listIds,
    createdBy: l.createdBy ?? null,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

async function listIdsFor(leadIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!leadIds.length) return map;
  const rows = await sequelize.query<{ lead_id: string; list_id: string }>(`SELECT lead_id, list_id FROM lead_list_members WHERE lead_id IN (:leadIds)`, {
    replacements: { leadIds },
    type: QueryTypes.SELECT,
  });
  for (const r of rows) map.set(r.lead_id, [...(map.get(r.lead_id) ?? []), r.list_id]);
  return map;
}

async function loadLead(id: string): Promise<Lead> {
  const l = await Lead.findByPk(id);
  if (!l) throw notFound("Lead not found");
  return l;
}

async function addToLists(leadIds: string[], listIds: string[]): Promise<void> {
  for (const listId of listIds) {
    for (const leadId of leadIds) {
      await sequelize.query(`INSERT INTO lead_list_members (list_id, lead_id, created_at) VALUES (:listId, :leadId, now()) ON CONFLICT DO NOTHING`, { replacements: { listId, leadId } });
    }
  }
}

async function assertListsInProduct(listIds: string[], productId: string): Promise<void> {
  if (!listIds.length) return;
  const n = await LeadList.count({ where: { id: listIds, productId } });
  if (n !== new Set(listIds).size) throw badRequest("One of the lists isn't in this product");
}

const like = (q: string) => ({ [Op.iLike]: `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%` });

// ---- Segments: rules to a query --------------------------------------------
function ruleWhere(rule: SegmentRule): WhereOptions {
  switch (rule.field) {
    case "tag":
      return { tags: { [Op.contains]: [rule.value] } };
    case "source":
      return { source: rule.value };
    case "consent":
      return { consent: rule.value };
    case "status":
      return { status: rule.value };
    case "company":
      return { company: like(rule.value) };
    case "email_domain":
      return { email: { [Op.iLike]: `%@${rule.value.replace(/^@/, "").replace(/[%_]/g, (c) => `\\${c}`)}` } };
    case "list":
      return { id: { [Op.in]: sequelize.literal(`(SELECT lead_id FROM lead_list_members WHERE list_id = ${sequelize.escape(rule.value)})`) } };
    case "created_after":
      return { createdAt: { [Op.gte]: new Date(rule.value) } };
    case "created_before":
      return { createdAt: { [Op.lte]: new Date(rule.value) } };
  }
}

export function segmentWhere(productId: string, rules: SegmentRules): WhereOptions {
  const ands: WhereOptions[] = [{ productId }];
  if (rules.all?.length) ands.push(...rules.all.map(ruleWhere));
  if (rules.any?.length) ands.push({ [Op.or]: rules.any.map(ruleWhere) } as WhereOptions);
  return { [Op.and]: ands };
}

// ---- Suppression -----------------------------------------------------------
export async function suppressedSet(productId: string, emails?: string[]): Promise<Set<string>> {
  const rows = await Suppression.findAll({
    where: { [Op.or]: [{ productId }, { productId: null }], ...(emails ? { email: emails } : {}) },
    attributes: ["email"],
  });
  return new Set(rows.map((r) => r.email));
}

export async function addSuppression(input: { productId: string | null; email: string; reason: Suppression["reason"]; note?: string | null; createdBy?: string | null }): Promise<Suppression> {
  const email = normalizeEmail(input.email);
  const existing = await Suppression.findOne({ where: { email, productId: input.productId } });
  if (existing) return existing;
  return Suppression.create({ productId: input.productId, email, reason: input.reason, note: input.note ?? null, createdBy: input.createdBy ?? null });
}

export const serializeSuppression = (s: Suppression) => ({ id: s.id, productId: s.productId ?? null, email: s.email, reason: s.reason, note: s.note ?? null, createdBy: s.createdBy ?? null, createdAt: s.createdAt.toISOString() });

// ---- Imports ---------------------------------------------------------------
const IMPORT_TTL = 60 * 60;
const MAX_ROWS = 20_000;
const importKey = (id: string) => `leadimport:${id}`;
const FIELD_NAMES: Record<string, string[]> = {
  email: ["email", "e-mail", "email address", "mail"],
  name: ["name", "full name", "fullname", "contact", "contact name"],
  company: ["company", "organisation", "organization", "business"],
  phone: ["phone", "phone number", "mobile", "tel"],
  tags: ["tags", "tag", "labels"],
  consent: ["consent", "opted in", "opt in", "subscribed"],
};
type Field = keyof typeof FIELD_NAMES;

interface ImportRow {
  row: number;
  email: string;
  name: string;
  company: string;
  phone: string;
  tags: string;
  consent: string;
  status: ImportRowStatus;
  problem: string | null;
}
interface ImportState {
  id: string;
  productId: string;
  createdBy: string;
  fileName: string;
  headers: string[];
  mapping: Partial<Record<Field, string>>;
  table: string[][];
  status: "preview" | "running" | "done" | "failed";
  rows: ImportRow[];
  result?: { created: number; updated: number; failed: number };
  options?: { listId?: string | null; tags?: string[]; consent?: "unknown" | "granted"; consentSource?: string };
}

async function saveImport(s: ImportState): Promise<void> {
  await redis.set(importKey(s.id), JSON.stringify(s), "EX", IMPORT_TTL);
}
async function loadImport(id: string, userId: string): Promise<ImportState> {
  const raw = await redis.get(importKey(id));
  if (!raw) throw notFound("This import has expired");
  const s = JSON.parse(raw) as ImportState;
  if (s.createdBy !== userId) throw notFound("This import has expired");
  return s;
}

async function classify(s: ImportState): Promise<void> {
  const col = (f: Field) => (s.mapping[f] ? s.headers.indexOf(s.mapping[f]!) : -1);
  const value = (r: string[], f: Field) => (col(f) >= 0 ? (r[col(f)] ?? "").trim() : "");
  const emails = s.table.map((r) => normalizeEmail(value(r, "email"))).filter((e) => isEmail(e));
  const [existing, suppressed] = await Promise.all([
    emails.length ? Lead.findAll({ where: { productId: s.productId, email: emails }, attributes: ["email"] }) : [],
    emails.length ? suppressedSet(s.productId, emails) : new Set<string>(),
  ]);
  const known = { existing: new Set(existing.map((l) => l.email)), suppressed, seen: new Set<string>() };
  const skipped = new Set(s.rows.filter((r) => r.status === "skipped").map((r) => r.row));
  s.rows = s.table.map((r, i) => {
    const base = { email: value(r, "email"), name: value(r, "name"), company: value(r, "company"), phone: value(r, "phone") };
    const c = classifyImportRow(base, known);
    return { row: i + 1, ...base, email: c.email, tags: value(r, "tags"), consent: value(r, "consent"), status: skipped.has(i + 1) ? "skipped" : c.status, problem: skipped.has(i + 1) ? null : c.problem };
  });
}

function summarizeImport(s: ImportState, q: { rowStatus?: string; limit?: number; offset?: number } = {}) {
  const counts = { total: s.rows.length, ready: 0, invalid: 0, duplicate: 0, suppressed: 0, skipped: 0 };
  for (const r of s.rows) counts[r.status]++;
  const filtered = q.rowStatus ? s.rows.filter((r) => r.status === q.rowStatus) : s.rows;
  const offset = q.offset ?? 0;
  return {
    id: s.id,
    fileName: s.fileName,
    headers: s.headers,
    mapping: s.mapping,
    status: s.status,
    counts,
    rows: filtered.slice(offset, offset + (q.limit ?? 100)).map(({ row, email, name, company, phone, status, problem }) => ({ row, email, name, company, phone, status, problem })),
    result: s.result ?? null,
  };
}

// Words that mean someone agreed, in a consent column.
const YES = new Set(["yes", "y", "true", "1", "granted", "opted in", "subscribed"]);

export const leadsService = {
  async list(productId: string, userId: string, q: { q?: string; tag?: string; consent?: string; status?: string; listId?: string; limit?: number; offset?: number }) {
    await requireOnProduct(userId, "campaign.view", productId);
    const where: Record<string | symbol, unknown> = { productId };
    if (q.q) where[Op.or] = [{ email: like(q.q) }, { name: like(q.q) }, { company: like(q.q) }];
    if (q.tag) where.tags = { [Op.contains]: [q.tag] };
    if (q.consent) where.consent = q.consent;
    if (q.status) where.status = q.status;
    if (q.listId) where.id = { [Op.in]: sequelize.literal(`(SELECT lead_id FROM lead_list_members WHERE list_id = ${sequelize.escape(q.listId)})`) };
    const { rows, count } = await Lead.findAndCountAll({ where: where as WhereOptions, order: [["createdAt", "DESC"]], limit: q.limit ?? 50, offset: q.offset ?? 0 });
    const lists = await listIdsFor(rows.map((r) => r.id));
    return { leads: rows.map((l) => serializeLead(l, lists.get(l.id) ?? [])), total: count };
  },

  async create(productId: string, input: { id?: string; email: string; name?: string; company?: string; phone?: string | null; source?: Lead["source"]; tags?: string[]; consent?: LeadConsent; consentSource?: string | null; ownerId?: string | null; custom?: Record<string, unknown>; listIds?: string[] }, userId: string) {
    await requireOnProduct(userId, "campaign.create", productId);
    if (!(await Product.findByPk(productId, { attributes: ["id"] }))) throw notFound("Product not found");
    const email = normalizeEmail(input.email);
    if (!isEmail(email)) throw badRequest("That isn't a valid email");
    const existing = await Lead.findOne({ where: { productId, email }, attributes: ["id"] });
    if (existing) throw new AppError(409, "This person is already a lead", "duplicate_lead", { leadId: existing.id });
    await assertListsInProduct(input.listIds ?? [], productId);
    // Someone who unsubscribed stays that way, even if they're added again by hand.
    const status = (await suppressedSet(productId, [email])).size ? ("unsubscribed" as const) : ("active" as const);
    const lead = await Lead.create({
      ...(input.id ? { id: input.id } : {}),
      productId,
      email,
      name: input.name ?? "",
      company: input.company ?? "",
      phone: input.phone ?? null,
      source: input.source ?? "manual",
      tags: input.tags ?? [],
      consent: input.consent ?? "unknown",
      consentAt: input.consent === "granted" ? new Date() : null,
      consentSource: input.consentSource ?? null,
      status,
      ownerId: input.ownerId ?? null,
      custom: input.custom ?? {},
      createdBy: userId,
    });
    await addToLists([lead.id], input.listIds ?? []);
    return serializeLead(lead, input.listIds ?? []);
  },

  async get(id: string, userId: string) {
    const lead = await loadLead(id);
    await requireOnProduct(userId, "campaign.view", lead.productId);
    const rows = await CampaignRecipient.findAll({ where: { leadId: id }, order: [["createdAt", "DESC"]], limit: 100 });
    const campaigns = rows.length ? await Campaign.findAll({ where: { id: [...new Set(rows.map((r) => r.campaignId))] }, attributes: ["id", "name"] }) : [];
    const names = new Map(campaigns.map((c) => [c.id, c.name]));
    return {
      lead: serializeLead(lead, (await listIdsFor([id])).get(id) ?? []),
      engagement: rows.map((r) => ({ campaignId: r.campaignId, campaignName: names.get(r.campaignId) ?? "", status: r.status, sentAt: r.sentAt?.toISOString() ?? null, openedAt: r.openedAt?.toISOString() ?? null, clickedAt: r.clickedAt?.toISOString() ?? null })),
    };
  },

  async update(id: string, patch: Partial<{ email: string; name: string; company: string; phone: string | null; source: Lead["source"]; tags: string[]; consent: LeadConsent; consentSource: string | null; ownerId: string | null; custom: Record<string, unknown>; listIds: string[] }>, userId: string) {
    const lead = await loadLead(id);
    await requireOnProduct(userId, "campaign.create", lead.productId);
    const email = patch.email !== undefined ? normalizeEmail(patch.email) : lead.email;
    if (!isEmail(email)) throw badRequest("That isn't a valid email");
    if (email !== lead.email) {
      const taken = await Lead.findOne({ where: { productId: lead.productId, email }, attributes: ["id"] });
      if (taken) throw new AppError(409, "This person is already a lead", "duplicate_lead", { leadId: taken.id });
    }
    await lead.update({
      email,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.company !== undefined ? { company: patch.company } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.consent !== undefined ? { consent: patch.consent, consentAt: patch.consent === "granted" ? new Date() : lead.consentAt } : {}),
      ...(patch.consentSource !== undefined ? { consentSource: patch.consentSource } : {}),
      ...(patch.ownerId !== undefined ? { ownerId: patch.ownerId } : {}),
      ...(patch.custom !== undefined ? { custom: patch.custom } : {}),
    });
    if (patch.listIds) {
      await assertListsInProduct(patch.listIds, lead.productId);
      await sequelize.query(`DELETE FROM lead_list_members WHERE lead_id = :id`, { replacements: { id } });
      await addToLists([id], patch.listIds);
    }
    return serializeLead(lead, (await listIdsFor([id])).get(id) ?? []);
  },

  async remove(id: string, userId: string): Promise<void> {
    const lead = await loadLead(id);
    await requireOnProduct(userId, "campaign.create", lead.productId);
    await lead.destroy();
  },

  // ---- Import --------------------------------------------------------------
  async startImport(productId: string, file: { buffer: Buffer; originalname: string }, userId: string) {
    await requireOnProduct(userId, "campaign.import", productId);
    const lower = file.originalname.toLowerCase();
    const table = lower.endsWith(".xlsx") ? await parseXlsx(file.buffer) : lower.endsWith(".csv") ? parseCsv(file.buffer.toString("utf8").replace(/^﻿/, "")) : null;
    if (!table) throw badRequest("Upload a .csv or .xlsx file");
    if (table.length < 2) throw badRequest("The file has no rows under the header");
    if (table.length - 1 > MAX_ROWS) throw badRequest(`Import up to ${MAX_ROWS} leads at a time`);
    const headers = table[0]!.map((h) => h.trim());
    const mapping: Partial<Record<Field, string>> = {};
    for (const [field, names] of Object.entries(FIELD_NAMES)) {
      const hit = headers.find((h) => names.includes(h.toLowerCase()));
      if (hit) mapping[field] = hit;
    }
    const s: ImportState = { id: randomUUID(), productId, createdBy: userId, fileName: file.originalname, headers, mapping, table: table.slice(1), status: "preview", rows: [] };
    await classify(s);
    await saveImport(s);
    return summarizeImport(s);
  },

  async getImport(id: string, userId: string, q: { rowStatus?: string; limit?: number; offset?: number }) {
    return summarizeImport(await loadImport(id, userId), q);
  },

  async setMapping(id: string, mapping: Partial<Record<Field, string>>, userId: string) {
    const s = await loadImport(id, userId);
    if (s.status !== "preview") throw new AppError(409, "This import already ran", "already_ran");
    for (const header of Object.values(mapping)) if (header && !s.headers.includes(header)) throw badRequest(`The file has no column called ${header}`);
    s.mapping = mapping;
    await classify(s);
    await saveImport(s);
    return summarizeImport(s);
  },

  async fixRow(id: string, row: number, patch: { email?: string; name?: string; company?: string; phone?: string; skip?: boolean }, userId: string) {
    const s = await loadImport(id, userId);
    if (s.status !== "preview") throw new AppError(409, "This import already ran", "already_ran");
    const target = s.rows.find((r) => r.row === row);
    const source = s.table[row - 1];
    if (!target || !source) throw notFound("That row doesn't exist");
    const put = (f: Field, value: string | undefined) => {
      if (value === undefined) return;
      const col = s.mapping[f] ? s.headers.indexOf(s.mapping[f]!) : -1;
      if (col >= 0) source[col] = value;
    };
    put("email", patch.email);
    put("name", patch.name);
    put("company", patch.company);
    put("phone", patch.phone);
    if (patch.skip !== undefined) target.status = patch.skip ? "skipped" : "ready";
    await classify(s);
    await saveImport(s);
    return summarizeImport(s);
  },

  async commitImport(id: string, options: { listId?: string; newListName?: string; tags?: string[]; consent?: "unknown" | "granted"; consentSource?: string }, userId: string, req?: Req) {
    const s = await loadImport(id, userId);
    if (s.status !== "preview") throw new AppError(409, "This import already ran", "already_ran");
    if (!s.mapping.email) throw badRequest("Say which column holds the email");
    let listId = options.listId ?? null;
    if (listId) await assertListsInProduct([listId], s.productId);
    if (options.newListName) listId = (await LeadList.create({ productId: s.productId, name: options.newListName, createdBy: userId })).id;
    s.status = "running";
    s.options = { listId, tags: options.tags, consent: options.consent, consentSource: options.consentSource };
    await saveImport(s);
    await audit({ req, actorId: userId, action: "lead.import", target: { type: "lead_import", id }, scope: productScope(s.productId), after: { file: s.fileName, ready: s.rows.filter((r) => r.status === "ready").length, consent: options.consent ?? "unknown" } });
    await enqueue("imports", "leads", { id }, { jobId: `lead-import-${id}` });
    return summarizeImport(s);
  },

  // The worker's half.
  async runImport(id: string): Promise<void> {
    const raw = await redis.get(importKey(id));
    if (!raw) return;
    const s = JSON.parse(raw) as ImportState;
    const opts = s.options ?? {};
    const result = { created: 0, updated: 0, failed: 0 };
    const created: string[] = [];
    for (const r of s.rows.filter((x) => x.status === "ready")) {
      try {
        const consentFromFile = YES.has(r.consent.trim().toLowerCase());
        const consent: LeadConsent = opts.consent === "granted" || consentFromFile ? "granted" : "unknown";
        const lead = await Lead.create({
          productId: s.productId,
          email: r.email,
          name: r.name,
          company: r.company,
          phone: r.phone || null,
          source: "import",
          tags: [...new Set([...(opts.tags ?? []), ...r.tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean)])],
          consent,
          consentAt: consent === "granted" ? new Date() : null,
          consentSource: opts.consentSource ?? `import: ${s.fileName}`,
          createdBy: s.createdBy,
        });
        created.push(lead.id);
        result.created++;
      } catch (err) {
        console.error("lead import row failed", err);
        result.failed++;
      }
    }
    if (opts.listId) {
      await addToLists(created, [opts.listId]);
      // Duplicates are already leads: they still belong on the chosen list.
      const dupes = s.rows.filter((x) => x.status === "duplicate" && x.problem === "Already a lead").map((x) => x.email);
      if (dupes.length) {
        const leads = await Lead.findAll({ where: { productId: s.productId, email: dupes }, attributes: ["id"] });
        await addToLists(leads.map((l) => l.id), [opts.listId]);
        result.updated = leads.length;
      }
    }
    s.status = "done";
    s.result = result;
    await saveImport(s);
  },

  // ---- Lists ---------------------------------------------------------------
  async lists(productId: string, userId: string) {
    await requireOnProduct(userId, "campaign.view", productId);
    const rows = await LeadList.findAll({ where: { productId }, order: [["name", "ASC"]] });
    return Promise.all(rows.map(serializeList));
  },
  async createList(productId: string, input: { id?: string; name: string; description?: string }, userId: string) {
    await requireOnProduct(userId, "campaign.create", productId);
    const row = await LeadList.create({ ...(input.id ? { id: input.id } : {}), productId, name: input.name, description: input.description ?? "", createdBy: userId });
    return serializeList(row);
  },
  async updateList(id: string, patch: { name?: string; description?: string }, userId: string) {
    const row = await LeadList.findByPk(id);
    if (!row) throw notFound("List not found");
    await requireOnProduct(userId, "campaign.create", row.productId);
    await row.update(patch);
    return serializeList(row);
  },
  async removeList(id: string, userId: string): Promise<void> {
    const row = await LeadList.findByPk(id);
    if (!row) throw notFound("List not found");
    await requireOnProduct(userId, "campaign.create", row.productId);
    await row.destroy();
  },
  async setListMembers(id: string, leadIds: string[], add: boolean, userId: string) {
    const row = await LeadList.findByPk(id);
    if (!row) throw notFound("List not found");
    await requireOnProduct(userId, "campaign.create", row.productId);
    const inProduct = await Lead.count({ where: { id: leadIds, productId: row.productId } });
    if (inProduct !== new Set(leadIds).size) throw badRequest("One of the leads isn't in this product");
    if (add) await addToLists(leadIds, [id]);
    else await sequelize.query(`DELETE FROM lead_list_members WHERE list_id = :id AND lead_id IN (:leadIds)`, { replacements: { id, leadIds } });
    return serializeList(row);
  },

  // ---- Segments ------------------------------------------------------------
  async segments(productId: string, userId: string) {
    await requireOnProduct(userId, "campaign.view", productId);
    return (await LeadSegment.findAll({ where: { productId }, order: [["name", "ASC"]] })).map(serializeSegment);
  },
  async createSegment(productId: string, input: { id?: string; name: string; rules: SegmentRules }, userId: string) {
    await requireOnProduct(userId, "campaign.create", productId);
    return serializeSegment(await LeadSegment.create({ ...(input.id ? { id: input.id } : {}), productId, name: input.name, rules: input.rules, createdBy: userId }));
  },
  async updateSegment(id: string, patch: { name?: string; rules?: SegmentRules }, userId: string) {
    const row = await LeadSegment.findByPk(id);
    if (!row) throw notFound("Segment not found");
    await requireOnProduct(userId, "campaign.create", row.productId);
    await row.update(patch);
    return serializeSegment(row);
  },
  async removeSegment(id: string, userId: string): Promise<void> {
    const row = await LeadSegment.findByPk(id);
    if (!row) throw notFound("Segment not found");
    await requireOnProduct(userId, "campaign.create", row.productId);
    await row.destroy();
  },
  async previewSegment(productId: string, rules: SegmentRules, userId: string) {
    await requireOnProduct(userId, "campaign.view", productId);
    const where = segmentWhere(productId, rules);
    const [count, sample] = await Promise.all([Lead.count({ where }), Lead.findAll({ where, limit: 10, order: [["createdAt", "DESC"]] })]);
    return { count, sample: sample.map((l) => serializeLead(l)) };
  },

  // ---- Suppression ---------------------------------------------------------
  async suppressions(productId: string, userId: string, q: { q?: string; reason?: string; limit?: number; offset?: number }) {
    await requireOnProduct(userId, "campaign.view", productId);
    const where: Record<string | symbol, unknown> = { [Op.or]: [{ productId }, { productId: null }] };
    if (q.q) where.email = like(q.q);
    if (q.reason) where.reason = q.reason;
    const { rows, count } = await Suppression.findAndCountAll({ where: where as WhereOptions, order: [["createdAt", "DESC"]], limit: q.limit ?? 50, offset: q.offset ?? 0 });
    return { suppressions: rows.map(serializeSuppression), total: count };
  },
  async suppress(productId: string, input: { email: string; note?: string; allProducts?: boolean }, userId: string, req?: Req) {
    await requireOnProduct(userId, "campaign.create", productId);
    if (input.allProducts && !(await can({ sub: userId }, "campaign.create"))) throw forbidden("You can't suppress across every product");
    if (!isEmail(normalizeEmail(input.email))) throw badRequest("That isn't a valid email");
    const row = await addSuppression({ productId: input.allProducts ? null : productId, email: input.email, reason: "manual", note: input.note, createdBy: userId });
    await audit({ req, actorId: userId, action: "suppression.add", target: { type: "suppression", id: row.id }, scope: productScope(productId), after: { domain: domainOf(row.email), allProducts: !!input.allProducts } });
    return serializeSuppression(row);
  },
  async unsuppress(id: string, userId: string, req?: Req): Promise<void> {
    const row = await Suppression.findByPk(id);
    if (!row) throw notFound("Not found");
    const allowed = await can({ sub: userId }, "campaign.approve", row.productId ? productScope(row.productId) : { type: "organization", id: null });
    if (!allowed) throw forbidden("You can't remove this");
    // Someone's choice to leave isn't ours to reverse.
    if (row.reason === "unsubscribed") throw new AppError(409, "This person unsubscribed, so they stay off the list", "unsubscribed");
    await row.destroy();
    await audit({ req, actorId: userId, action: "suppression.remove", target: { type: "suppression", id }, before: { domain: domainOf(row.email), reason: row.reason } });
  },
};

async function serializeList(l: LeadList) {
  const [row] = await sequelize.query<{ n: string }>(`SELECT COUNT(*) AS n FROM lead_list_members WHERE list_id = :id`, { replacements: { id: l.id }, type: QueryTypes.SELECT });
  return { id: l.id, productId: l.productId, name: l.name, description: l.description, memberCount: Number(row?.n ?? 0), createdAt: l.createdAt.toISOString(), updatedAt: l.updatedAt.toISOString() };
}
const serializeSegment = (s: LeadSegment) => ({ id: s.id, productId: s.productId, name: s.name, rules: s.rules, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() });
