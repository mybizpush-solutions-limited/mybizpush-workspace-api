// Pure helpers for integrations (API-CHANGES A701, A703, A704).

// ---- OAuth return links ------------------------------------------------------

// Only known destinations can receive the user after sign-in. A prefix that isn't
// just a scheme has to end at a path boundary, so https://app.example can't match
// https://app.example.evil.com.
export function isAllowedReturn(url: string, allowlist: readonly string[]): boolean {
  if (!url || /[\s\\]/.test(url) || [...url].some((c) => c.charCodeAt(0) < 32)) return false;
  return allowlist.some((prefix) => {
    if (!prefix || !url.startsWith(prefix)) return false;
    if (prefix.endsWith("/") || prefix.endsWith("://")) return true;
    const next = url[prefix.length];
    return next === undefined || next === "/" || next === "?" || next === "#";
  });
}

export function withResult(url: string, provider: string, status: "connected" | "error"): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}provider=${encodeURIComponent(provider)}&status=${status}`;
}

// ---- Gmail -------------------------------------------------------------------

export interface Address {
  name: string;
  email: string;
}

// `"Ada O" <ada@x.com>, bola@y.com` into people. Commas inside quotes don't split.
export function parseAddresses(header: string | null | undefined): Address[] {
  if (!header) return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const c of header) {
    if (c === '"') quoted = !quoted;
    if (c === "," && !quoted) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^(.*)<([^>]+)>\s*$/.exec(p);
      if (m) return { name: m[1]!.trim().replace(/^"|"$/g, "").trim(), email: m[2]!.trim() };
      return { name: "", email: p };
    });
}

export const headerOf = (headers: { name?: string | null; value?: string | null }[] | null | undefined, name: string): string | null =>
  headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;

interface Part {
  mimeType?: string | null;
  filename?: string | null;
  body?: { data?: string | null; size?: number | null; attachmentId?: string | null } | null;
  parts?: Part[] | null;
}

const decode = (data: string | null | undefined) => (data ? Buffer.from(data, "base64url").toString("utf8") : "");

// Walks a Gmail message's parts for its text, HTML and files.
export function extractBody(payload: Part | null | undefined): { text: string; html: string; attachments: { filename: string; mimeType: string; size: number }[] } {
  const out = { text: "", html: "", attachments: [] as { filename: string; mimeType: string; size: number }[] };
  const walk = (p: Part | null | undefined) => {
    if (!p) return;
    if (p.filename) {
      out.attachments.push({ filename: p.filename, mimeType: p.mimeType ?? "application/octet-stream", size: p.body?.size ?? 0 });
    } else if (p.mimeType === "text/plain" && !out.text) out.text = decode(p.body?.data);
    else if (p.mimeType === "text/html" && !out.html) out.html = decode(p.body?.data);
    p.parts?.forEach(walk);
  };
  walk(payload);
  return out;
}

// A line break in a header would let a value add headers of its own, such as Bcc.
const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
const encodeSubject = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

export function buildRawMessage(input: { from: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; html?: boolean; inReplyTo?: string | null; references?: string | null }): string {
  const headers = [
    `From: ${clean(input.from)}`,
    `To: ${input.to.map(clean).join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.map(clean).join(", ")}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.map(clean).join(", ")}`] : []),
    `Subject: ${encodeSubject(clean(input.subject))}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${clean(input.inReplyTo)}`, `References: ${clean(input.references ?? input.inReplyTo)}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: text/${input.html ? "html" : "plain"}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(input.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

// A reply is new when there are more messages than last time, and the latest isn't
// the person who linked the thread answering it themself.
export function hasNewReply(input: { knownCount: number; currentCount: number; lastFrom: string | null; myEmail: string | null }): boolean {
  if (input.currentCount <= input.knownCount) return false;
  if (!input.lastFrom || !input.myEmail) return true;
  return !parseAddresses(input.lastFrom).some((a) => a.email.toLowerCase() === input.myEmail!.toLowerCase());
}

// ---- Calendar ----------------------------------------------------------------

export interface EventFacts {
  title: string;
  startsAt: string;
  endsAt: string;
}

const sameInstant = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();
const sameEvent = (a: EventFacts, b: EventFacts) => a.title === b.title && sameInstant(a.startsAt, b.startsAt) && sameInstant(a.endsAt, b.endsAt);

export type SyncVerdict = "in_sync" | "cancelled" | "changed_in_google" | "local_ahead";

// `snapshot` is what both sides agreed on last. If Google still matches it, the
// change is ours, not yet pushed; if it doesn't, someone changed it in Google.
export function compareEvent(input: { local: EventFacts; snapshot: EventFacts | null; remote: (EventFacts & { cancelled: boolean }) | null }): SyncVerdict {
  const { local, snapshot, remote } = input;
  if (!remote || remote.cancelled) return "cancelled";
  if (sameEvent(local, remote)) return "in_sync";
  return snapshot && sameEvent(snapshot, remote) ? "local_ahead" : "changed_in_google";
}

// Google event ids allow lowercase a to v and digits, so a dashless UUID is valid.
export const googleEventIdFor = (uuid: string) => uuid.replace(/-/g, "").toLowerCase();
