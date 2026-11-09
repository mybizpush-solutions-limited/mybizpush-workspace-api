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

// Campaigns mention this sender; only allowed domains can be used.
export function resolveSender(input: { fromName?: string | null; fromEmail?: string | null; defaultFrom: string; allowedDomains: string[] }): string | { error: string } {
  if (!input.fromEmail) {
    if (!input.fromName) return input.defaultFrom;
    const address = /<([^>]+)>/.exec(input.defaultFrom)?.[1] ?? input.defaultFrom;
    return `${input.fromName.replace(/["<>]/g, "")} <${address}>`;
  }
  const email = normalizeEmail(input.fromEmail);
  if (!isEmail(email) || !input.allowedDomains.map((d) => d.toLowerCase()).includes(domainOf(email))) return { error: `Campaigns can't send from ${input.fromEmail}` };
  return input.fromName ? `${input.fromName.replace(/["<>]/g, "")} <${email}>` : email;
}

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
