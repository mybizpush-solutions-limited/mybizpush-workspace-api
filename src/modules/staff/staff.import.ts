import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { badRequest, notFound } from "../../lib/errors";
import { redis } from "../../redis/client";
import { env } from "../../config/env";
import { Department, Invitation, Product, Team, User } from "../../models";
import { Op } from "sequelize";

// Staff import (API-CHANGES A107, ORG-05): preview first, then a background
// job sends the invitations. Previews live in Redis for an hour.

const TTL_SECONDS = 60 * 60;
const key = (id: string) => `staffimport:${id}`;
const MAX_ROWS = 2_000;

export type Field = "name" | "email" | "department" | "product" | "team" | "phone" | "employeeId" | "jobTitle";

const SYNONYMS: Record<Field, string[]> = {
  name: ["name", "full name", "fullname", "staff name", "employee name"],
  email: ["email", "work email", "company email", "email address", "mail"],
  department: ["department", "dept", "unit"],
  product: ["product", "products", "brand"],
  team: ["team", "squad"],
  phone: ["phone", "phone number", "mobile", "tel"],
  employeeId: ["employee id", "staff id", "id number", "employee number"],
  jobTitle: ["job title", "title", "role", "position", "job"],
};

export interface PreviewRow {
  row: number; // 1-based row in the file, header excluded
  name: string;
  email: string;
  departmentId: string | null;
  productId: string | null;
  teamId: string | null;
  jobTitles: string[];
  status: "ready" | "duplicate" | "invalid";
  problem?: string;
}

export interface ImportState {
  id: string;
  createdBy: string;
  fileName: string;
  mapping: Partial<Record<Field, string>>; // field -> header in the file
  rows: PreviewRow[];
  status: "preview" | "running" | "done" | "failed";
  result?: { invited: number; failed: { email: string; error: string }[] };
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

export async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (r) => {
    const values = (r.values as unknown[]).slice(1); // exceljs rows are 1-based
    rows.push(values.map((v) => (v === null || v === undefined ? "" : typeof v === "object" && "text" in (v as object) ? String((v as { text: unknown }).text) : String(v))));
  });
  return rows;
}

function autoMap(headers: string[]): Partial<Record<Field, string>> {
  const mapping: Partial<Record<Field, string>> = {};
  for (const [field, names] of Object.entries(SYNONYMS) as [Field, string[]][]) {
    const hit = headers.find((h) => names.includes(h.trim().toLowerCase()));
    if (hit) mapping[field] = hit;
  }
  return mapping;
}

const byName = <T extends { id: string; name: string }>(rows: T[]) => new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.id]));

export async function preview(actorId: string, file: { buffer: Buffer; originalname: string }): Promise<ImportState> {
  const lower = file.originalname.toLowerCase();
  const table = lower.endsWith(".xlsx") ? await parseXlsx(file.buffer) : lower.endsWith(".csv") ? parseCsv(file.buffer.toString("utf8").replace(/^\uFEFF/, "")) : null;
  if (!table) throw badRequest("Upload a .csv or .xlsx file");
  if (table.length < 2) throw badRequest("The file has no rows under the header");
  if (table.length - 1 > MAX_ROWS) throw badRequest(`Import up to ${MAX_ROWS} people at a time`);

  const headers = table[0]!.map((h) => h.trim());
  const mapping = autoMap(headers);
  if (!mapping.email) throw badRequest("Couldn't find an email column. Name it 'Email'.");
  const col = (f: Field) => (mapping[f] ? headers.indexOf(mapping[f]!) : -1);

  const [depts, products, teams] = await Promise.all([
    Department.findAll({ attributes: ["id", "name"] }),
    Product.findAll({ attributes: ["id", "name"] }),
    Team.findAll({ attributes: ["id", "name"] }),
  ]);
  const deptByName = byName(depts);
  const productByName = byName(products);
  const teamByName = byName(teams);

  const emails = table.slice(1).map((r) => (r[col("email")] ?? "").trim().toLowerCase()).filter(Boolean);
  const [existingUsers, pendingInvites] = await Promise.all([
    User.findAll({ where: { [Op.or]: [{ email: emails }, { secondaryEmail: emails }] }, attributes: ["email", "secondaryEmail"] }),
    Invitation.findAll({ where: { email: emails, acceptedAt: { [Op.is]: null }, revokedAt: { [Op.is]: null } }, attributes: ["email"] }),
  ]);
  const taken = new Set(existingUsers.flatMap((u) => [u.email, u.secondaryEmail].filter((x): x is string => !!x).map((x) => x.toLowerCase())));
  const invited = new Set(pendingInvites.map((i) => i.email.toLowerCase()));
  const domain = `@${env.ALLOWED_EMAIL_DOMAIN}`.toLowerCase();
  const seen = new Set<string>();

  const rows: PreviewRow[] = table.slice(1).map((r, i) => {
    const get = (f: Field) => (col(f) >= 0 ? (r[col(f)] ?? "").trim() : "");
    const email = get("email").toLowerCase();
    const name = get("name");
    const out: PreviewRow = {
      row: i + 1,
      name,
      email,
      departmentId: null,
      productId: null,
      teamId: null,
      jobTitles: get("jobTitle") ? [get("jobTitle")] : [],
      status: "ready",
    };
    const fail = (problem: string): PreviewRow => ({ ...out, status: "invalid", problem });
    if (!email) return fail("Email is missing");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(`${email} is not an email address`);
    if (!email.endsWith(domain)) return fail(`${email} is not a company email`);
    if (seen.has(email)) return { ...out, status: "duplicate", problem: "Appears more than once in this file" };
    seen.add(email);
    if (taken.has(email)) return { ...out, status: "duplicate", problem: "Already has an account" };
    if (invited.has(email)) return { ...out, status: "duplicate", problem: "Already invited" };
    const dept = get("department");
    if (dept) {
      out.departmentId = deptByName.get(dept.toLowerCase()) ?? null;
      if (!out.departmentId) return fail(`Department "${dept}" not found`);
    }
    const product = get("product");
    if (product) {
      out.productId = productByName.get(product.toLowerCase()) ?? null;
      if (!out.productId) return fail(`Product "${product}" not found`);
    }
    const team = get("team");
    if (team) {
      out.teamId = teamByName.get(team.toLowerCase()) ?? null;
      if (!out.teamId) return fail(`Team "${team}" not found`);
    }
    return out;
  });

  const state: ImportState = { id: randomUUID(), createdBy: actorId, fileName: file.originalname, mapping, rows, status: "preview" };
  await redis.set(key(state.id), JSON.stringify(state), "EX", TTL_SECONDS);
  return state;
}

export async function getImport(id: string): Promise<ImportState> {
  const raw = await redis.get(key(id));
  if (!raw) throw notFound("This import has expired. Upload the file again.");
  return JSON.parse(raw) as ImportState;
}

export async function saveImport(state: ImportState): Promise<void> {
  await redis.set(key(state.id), JSON.stringify(state), "EX", TTL_SECONDS);
}

// Fix one row from the review screen ("Fix" on ORG-05): pick the right
// department, product or team, or correct the email.
export async function fixRow(id: string, row: number, patch: Partial<Pick<PreviewRow, "email" | "name" | "departmentId" | "productId" | "teamId">>): Promise<ImportState> {
  const state = await getImport(id);
  const r = state.rows.find((x) => x.row === row);
  if (!r) throw notFound("Row not found");
  Object.assign(r, patch);
  const domain = `@${env.ALLOWED_EMAIL_DOMAIN}`.toLowerCase();
  r.email = r.email.trim().toLowerCase();
  if (!r.email.endsWith(domain)) Object.assign(r, { status: "invalid", problem: `${r.email} is not a company email` });
  else if (await User.count({ where: { [Op.or]: [{ email: r.email }, { secondaryEmail: r.email }] } })) Object.assign(r, { status: "duplicate", problem: "Already has an account" });
  else Object.assign(r, { status: "ready", problem: undefined });
  await saveImport(state);
  return state;
}

export const summarize = (s: ImportState) => ({
  id: s.id,
  fileName: s.fileName,
  mapping: s.mapping,
  status: s.status,
  counts: {
    ready: s.rows.filter((r) => r.status === "ready").length,
    duplicates: s.rows.filter((r) => r.status === "duplicate").length,
    invalid: s.rows.filter((r) => r.status === "invalid").length,
  },
  problems: s.rows.filter((r) => r.status !== "ready"),
  result: s.result ?? null,
});
