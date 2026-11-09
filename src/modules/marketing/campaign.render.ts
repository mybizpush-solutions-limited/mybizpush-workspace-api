// Building one recipient's copy of a campaign email (API-CHANGES A602). Pure.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface MergeValues {
  name: string;
  email: string;
  company: string;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

// Lead data comes from imports and forms, so it's escaped in HTML. Text mode leaves
// it alone. Unknown {{fields}} are left visible so a typo is noticed in the test send.
function merge(template: string, values: MergeValues, unsubscribeUrl: string, html: boolean): string {
  const safe = (v: string) => (html ? escapeHtml(v) : v);
  const map: Record<string, string> = {
    name: safe(values.name),
    first_name: safe(firstName(values.name)),
    email: safe(values.email),
    company: safe(values.company),
    unsubscribe_url: unsubscribeUrl,
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => map[key] ?? whole);
}

// Every http(s) link in the body, in order, without repeats.
export function extractLinks(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(https?:\/\/[^"'\s]+)\1/gi)) out.add(m[2]!);
  return [...out];
}

function rewriteLinks(html: string, linkIds: ReadonlyMap<string, string>, clickUrl: (linkId: string) => string): string {
  return html.replace(/(<a\b[^>]*\bhref\s*=\s*)(["'])(https?:\/\/[^"'\s]+)\2/gi, (whole, start: string, quote: string, url: string) => {
    const id = linkIds.get(url);
    return id ? `${start}${quote}${clickUrl(id)}${quote}` : whole;
  });
}

export interface Rendered {
  html: string;
  text: string;
  subject: string;
}

export function renderForRecipient(input: {
  subject: string;
  bodyHtml: string;
  bodyText: string;
  values: MergeValues;
  unsubscribeUrl: string;
  openPixelUrl: string;
  linkIds: ReadonlyMap<string, string>;
  clickUrl: (linkId: string) => string;
}): Rendered {
  const { values, unsubscribeUrl } = input;
  const hasLink = /\{\{\s*unsubscribe_url\s*\}\}/.test(input.bodyHtml);
  // Links are rewritten before merging, so a value in lead data can't become a tracked link.
  let html = merge(rewriteLinks(input.bodyHtml, input.linkIds, input.clickUrl), values, unsubscribeUrl, true);
  if (!hasLink) {
    html += `<p style="font-size:12px;color:#8b93a3;margin-top:24px;">Don't want these emails? <a href="${unsubscribeUrl}">Unsubscribe</a>.</p>`;
  }
  html += `<img src="${input.openPixelUrl}" width="1" height="1" alt="" style="display:block;border:0;" />`;
  let text = merge(input.bodyText, values, unsubscribeUrl, false);
  if (!/\{\{\s*unsubscribe_url\s*\}\}/.test(input.bodyText)) text += `\n\nUnsubscribe: ${unsubscribeUrl}`;
  return { html, text, subject: merge(input.subject, values, unsubscribeUrl, false) };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (v: string) => v.length <= 254 && EMAIL_RE.test(v);
export const normalizeEmail = (v: string) => v.trim().toLowerCase();
export const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

export interface SenderLevel {
  name?: string | null;
  email?: string | null;
}

// Parses "Name <a@b.c>" or "a@b.c".
export function parseFrom(from: string): { name: string; email: string } {
  const m = /^(.*)<([^>]+)>\s*$/.exec(from);
  if (m) return { name: m[1]!.trim().replace(/^"|"$/g, ""), email: normalizeEmail(m[2]!) };
  return { name: "", email: normalizeEmail(from) };
}

export const SENDER_DOMAIN_ERROR = "sender_domain_not_allowed";

// Who a campaign sends as: the campaign, then its product, then the organization, then
// the configured last resort. A blank name takes the name from the level that gave the
// address. Mail from an unverified domain isn't delivered, so a bad domain is reported,
// never quietly replaced by a good one.
export function resolveSender(input: {
  campaign: SenderLevel;
  product: SenderLevel;
  organization: SenderLevel;
  fallbackFrom: string;
  allowedDomains: string[];
  productDomains: string[];
}): { name: string; email: string; problem: typeof SENDER_DOMAIN_ERROR | null } {
  const fallback = parseFrom(input.fallbackFrom);
  const levels: SenderLevel[] = [input.campaign, input.product, input.organization, fallback];
  const chosen = levels.find((l) => l.email?.trim()) ?? fallback;
  const email = normalizeEmail(chosen.email ?? "");
  const name = (input.campaign.name?.trim() || chosen.name?.trim() || "").replace(/["<>\r\n]/g, "");
  return { name, email, problem: senderDomainAllowed(email, input.allowedDomains, input.productDomains) ? null : SENDER_DOMAIN_ERROR };
}

export function senderDomainAllowed(email: string, allowedDomains: string[], productDomains: string[] = []): boolean {
  if (!isEmail(email)) return false;
  const domain = domainOf(email);
  return [...allowedDomains, ...productDomains].map((d) => d.toLowerCase()).includes(domain);
}

export const formatFrom = (s: { name: string; email: string }) => (s.name ? `${s.name} <${s.email}>` : s.email);

// "https://www.shop.example/" as a site records it, down to "shop.example".
export const bareDomain = (raw: string) => raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");

export interface ImportRowInput {
  email: string;
  name: string;
  company: string;
  phone: string;
}
export type ImportRowStatus = "ready" | "invalid" | "duplicate" | "suppressed" | "skipped";

// What each row of a lead import will do. Repeats in the file count as duplicates.
export function classifyImportRow(row: ImportRowInput, known: { existing: ReadonlySet<string>; suppressed: ReadonlySet<string>; seen: Set<string> }): { status: ImportRowStatus; problem: string | null; email: string } {
  const email = normalizeEmail(row.email);
  if (!email) return { status: "invalid", problem: "No email", email };
  if (!isEmail(email)) return { status: "invalid", problem: "Not a valid email", email };
  if (known.seen.has(email)) return { status: "duplicate", problem: "Repeated in this file", email };
  known.seen.add(email);
  if (known.suppressed.has(email)) return { status: "suppressed", problem: "On the suppression list", email };
  if (known.existing.has(email)) return { status: "duplicate", problem: "Already a lead", email };
  return { status: "ready", problem: null, email };
}

// Svix-style webhook signature, which is what Resend sends.
export function svixSignedContent(id: string, timestamp: string, body: string): string {
  return `${id}.${timestamp}.${body}`;
}
export const isFreshTimestamp = (timestampSeconds: string, nowMs: number, toleranceSeconds = 300) => {
  const t = Number(timestampSeconds);
  return Number.isFinite(t) && Math.abs(nowMs / 1000 - t) <= toleranceSeconds;
};

const STATUS_FLOW: Record<string, string[]> = {
  draft: ["pending_approval", "cancelled"],
  rejected: ["draft", "pending_approval", "cancelled"],
  pending_approval: ["approved", "rejected", "draft", "cancelled"],
  approved: ["scheduled", "sending", "draft", "cancelled"],
  scheduled: ["sending", "approved", "cancelled", "paused"],
  sending: ["paused", "sent", "cancelled"],
  paused: ["sending", "cancelled"],
  sent: [],
  cancelled: [],
};
export const canMoveCampaign = (from: string, to: string) => (STATUS_FLOW[from] ?? []).includes(to);
