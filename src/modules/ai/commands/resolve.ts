import type { FieldDef, OperationDef } from "./operations";

// Turns what the model extracted into form fields, each with an honest status
// (API-CHANGES A801). Pure: the database is reached through `lookup`, which tests
// can replace. The rule that matters: nothing uncertain is ever picked for the user.

export type FieldStatus = "extracted" | "resolved" | "missing" | "ambiguous" | "unmatched" | "invalid";

export interface Candidate {
  id: string;
  label: string;
  sublabel?: string;
  imageUrl?: string | null;
}

export interface ParsedField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  options?: readonly string[];
  status: FieldStatus;
  value: unknown;
  raw: string | null;
  display: string | null;
  candidates: Candidate[];
  message: string | null;
  partial?: unknown; // for lists: what's settled while another name is still open
}

export type Lookup = (type: string, query: string) => Promise<Candidate[]>;

export interface ResolveContext {
  productId?: string;
  projectId?: string;
  departmentId?: string;
  teamId?: string;
  now: Date;
  timezone: string;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// One record, or a list of possibilities to choose from. A partial match that's the
// only one is accepted; among several, only an exact name stands out.
export function matchOne(query: string, candidates: Candidate[]): { status: "resolved" | "ambiguous" | "unmatched"; match?: Candidate; candidates: Candidate[] } {
  if (!candidates.length) return { status: "unmatched", candidates: [] };
  if (candidates.length === 1) return { status: "resolved", match: candidates[0]!, candidates: [] };
  const exact = candidates.filter((c) => norm(c.label) === norm(query));
  if (exact.length === 1) return { status: "resolved", match: exact[0]!, candidates: [] };
  return { status: "ambiguous", candidates: exact.length > 1 ? exact : candidates };
}

const isBlank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

function field(def: FieldDef, parts: Partial<ParsedField>): ParsedField {
  return {
    name: def.name,
    label: def.label,
    type: def.type,
    required: !!def.required,
    ...(def.options ? { options: def.options } : {}),
    status: "missing",
    value: null,
    raw: null,
    display: null,
    candidates: [],
    message: null,
    ...parts,
  };
}

const LOOKUP_TYPE: Record<string, string> = { staff: "staff", "staff[]": "staff", product: "product", project: "project", department: "department", team: "team", conversation: "conversation", task: "task" };
const asString = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));

function formatDate(d: Date, timezone: string, dateOnly: boolean): string {
  const opts: Intl.DateTimeFormatOptions = dateOnly
    ? { weekday: "short", day: "numeric", month: "short", timeZone: timezone }
    : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone };
  try {
    return new Intl.DateTimeFormat("en-GB", opts).format(d);
  } catch {
    return d.toISOString();
  }
}

async function resolveRecord(def: FieldDef, type: string, raw: unknown, lookup: Lookup): Promise<ParsedField> {
  const text = asString(raw);
  const m = matchOne(text, await lookup(type, text));
  if (m.status === "resolved") return field(def, { status: "resolved", value: m.match!.id, raw: text, display: m.match!.label });
  if (m.status === "ambiguous") return field(def, { status: "ambiguous", raw: text, candidates: m.candidates, message: `${m.candidates.length} matches for "${text}"` });
  return field(def, { status: "unmatched", raw: text, message: `Nothing matches "${text}"` });
}

async function resolveList(def: FieldDef, raw: unknown, lookup: Lookup): Promise<ParsedField> {
  const names = (Array.isArray(raw) ? raw : [raw]).map(asString).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return field(def, {});
  const results = await Promise.all(names.map(async (n) => ({ name: n, m: matchOne(n, await lookup("staff", n)) })));
  const ok = results.filter((r) => r.m.status === "resolved");
  const ids = [...new Set(ok.map((r) => r.m.match!.id))];
  const rawText = names.join(", ");
  const display = ok.map((r) => r.m.match!.label).join(", ");
  const open = results.find((r) => r.m.status === "ambiguous");
  if (open) {
    return field(def, { status: "ambiguous", raw: rawText, candidates: open.m.candidates, message: `${open.m.candidates.length} matches for "${open.name}"`, partial: ids, display: display || null });
  }
  const none = results.find((r) => r.m.status === "unmatched");
  if (none) return field(def, { status: "unmatched", raw: rawText, message: `Nothing matches "${none.name}"`, partial: ids, display: display || null });
  return field(def, { status: "resolved", value: ids, raw: rawText, display });
}

function resolveDate(def: FieldDef, raw: unknown, ctx: ResolveContext): ParsedField {
  const text = asString(raw);
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return field(def, { status: "invalid", raw: text, message: `"${text}" isn't a date` });
  if (def.future && d <= ctx.now) return field(def, { status: "invalid", raw: text, message: "That time has already passed" });
  if (def.type === "date") return field(def, { status: "resolved", value: d.toISOString().slice(0, 10), raw: text, display: formatDate(d, ctx.timezone, true) });
  return field(def, { status: "resolved", value: d.toISOString(), raw: text, display: formatDate(d, ctx.timezone, false) });
}

const GROUP_TYPES = ["team", "department", "product", "project"];

async function resolveGroups(def: FieldDef, raw: unknown, lookup: Lookup): Promise<ParsedField> {
  const items = (Array.isArray(raw) ? raw : [raw]) as { type?: string; name?: string }[];
  const value: { type: string; id: string }[] = [];
  const display: string[] = [];
  for (const item of items) {
    if (!item?.name || !item.type || !GROUP_TYPES.includes(item.type)) return field(def, { status: "invalid", raw: JSON.stringify(raw), message: "That group isn't clear" });
    const m = matchOne(item.name, await lookup(item.type, item.name));
    if (m.status === "ambiguous") return field(def, { status: "ambiguous", raw: item.name, candidates: m.candidates, message: `${m.candidates.length} matches for "${item.name}"`, partial: value });
    if (m.status === "unmatched") return field(def, { status: "unmatched", raw: item.name, message: `Nothing matches "${item.name}"`, partial: value });
    value.push({ type: item.type, id: m.match!.id });
    display.push(m.match!.label);
  }
  return field(def, { status: "resolved", value, raw: JSON.stringify(raw), display: display.join(", ") });
}

async function resolveAudience(def: FieldDef, raw: unknown, lookup: Lookup): Promise<ParsedField> {
  const a = raw as { type?: string; names?: string[] };
  if (!a || typeof a !== "object" || !a.type) return field(def, { status: "invalid", raw: JSON.stringify(raw), message: "That audience isn't clear" });
  if (a.type === "organization") return field(def, { status: "resolved", value: { type: "organization", ids: [] }, raw: "organization", display: "Everyone" });
  const kind = a.type === "users" ? "staff" : a.type;
  if (!LOOKUP_TYPE[kind]) return field(def, { status: "invalid", raw: a.type, message: "That audience isn't clear" });
  const names = a.names ?? [];
  if (!names.length) return field(def, { status: "unmatched", raw: a.type, message: `Which ${a.type}?` });
  const ids: string[] = [];
  const labels: string[] = [];
  for (const n of names) {
    const m = matchOne(n, await lookup(kind, n));
    if (m.status === "ambiguous") return field(def, { status: "ambiguous", raw: n, candidates: m.candidates, message: `${m.candidates.length} matches for "${n}"` });
    if (m.status === "unmatched") return field(def, { status: "unmatched", raw: n, message: `Nothing matches "${n}"` });
    ids.push(m.match!.id);
    labels.push(m.match!.label);
  }
  return field(def, { status: "resolved", value: { type: a.type, ids }, raw: names.join(", "), display: labels.join(", ") });
}

async function resolveField(def: FieldDef, raw: unknown, extracted: Record<string, unknown>, ctx: ResolveContext, lookup: Lookup): Promise<ParsedField> {
  if (isBlank(raw)) {
    const fromContext = def.contextKey ? ctx[def.contextKey] : undefined;
    if (fromContext) return field(def, { status: "resolved", value: fromContext, message: "From your current context" });
    return field(def, {});
  }
  switch (def.type) {
    case "text":
    case "longtext":
      return field(def, { status: "extracted", value: asString(raw).trim(), raw: asString(raw), display: asString(raw).trim() });
    case "number": {
      const n = typeof raw === "number" ? raw : Number(asString(raw).replace(/,/g, ""));
      return Number.isFinite(n) ? field(def, { status: "extracted", value: n, raw: asString(raw), display: String(n) }) : field(def, { status: "invalid", raw: asString(raw), message: "That isn't a number" });
    }
    case "boolean": {
      const s = norm(asString(raw));
      if (["true", "yes"].includes(s)) return field(def, { status: "extracted", value: true, raw: s, display: "Yes" });
      if (["false", "no"].includes(s)) return field(def, { status: "extracted", value: false, raw: s, display: "No" });
      return field(def, { status: "invalid", raw: s, message: "Yes or no?" });
    }
    case "choice": {
      const hit = def.options?.find((o) => norm(o) === norm(asString(raw).replace(/-/g, "_").replace(/ /g, "_")));
      return hit ? field(def, { status: "resolved", value: hit, raw: asString(raw), display: hit.replace(/_/g, " ") }) : field(def, { status: "invalid", raw: asString(raw), message: `Choose one of: ${def.options?.join(", ")}` });
    }
    case "date":
    case "datetime":
      return resolveDate(def, raw, ctx);
    case "staff[]":
      return resolveList(def, raw, lookup);
    case "group[]":
      return resolveGroups(def, raw, lookup);
    case "audience":
      return resolveAudience(def, raw, lookup);
    case "scope": {
      // What to look in depends on another field: "department" means departments.
      const kind = String(extracted[def.scopeFrom ?? ""] ?? "");
      const type = kind === "user" ? "staff" : kind;
      if (!LOOKUP_TYPE[type]) return field(def, { status: "unmatched", raw: asString(raw), message: "Choose what kind this is first" });
      return resolveRecord(def, type, raw, lookup);
    }
    default:
      return resolveRecord(def, LOOKUP_TYPE[def.type]!, raw, lookup);
  }
}

export async function resolveFields(op: OperationDef, extracted: Record<string, unknown>, ctx: ResolveContext, lookup: Lookup): Promise<ParsedField[]> {
  return Promise.all(op.fields.map((def) => resolveField(def, extracted[def.name], extracted, ctx, lookup)));
}

// Everything required is settled, and nothing anywhere is left in doubt.
export function isReady(op: OperationDef, fields: ParsedField[]): boolean {
  const byName = new Map(fields.map((f) => [f.name, f]));
  for (const f of fields) {
    if (f.status === "ambiguous" || f.status === "unmatched" || f.status === "invalid") return false;
    if (f.required && f.status === "missing") return false;
  }
  for (const def of op.fields) {
    if (!def.requiredWhen) continue;
    const other = byName.get(def.requiredWhen.field)?.value;
    if (other && !def.requiredWhen.notIn.includes(String(other)) && byName.get(def.name)?.status === "missing") return false;
  }
  if (op.key === "send_message") return byName.get("recipientIds")?.status === "resolved" || byName.get("conversationId")?.status === "resolved";
  return true;
}

// Models wrap JSON in fences and prose, and sometimes get it wrong. Null means it
// couldn't be read at all.
export function parseModelJson(text: string): { operation?: string; confidence?: number; fields?: Record<string, unknown> } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as { operation?: string; confidence?: number; fields?: Record<string, unknown> }) : null;
  } catch {
    return null;
  }
}
