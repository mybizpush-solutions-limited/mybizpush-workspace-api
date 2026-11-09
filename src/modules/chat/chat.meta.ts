import { z } from "zod";

// What each message type carries (API-CHANGES A302). Pure: no database, so the
// rules can be tested directly.

export interface MetaAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
}

const dimensions = { width: z.number().int().min(1).max(20000).optional(), height: z.number().int().min(1).max(20000).optional() };
const duration = z.number().int().min(0).max(24 * 60 * 60 * 1000);

// Unknown keys are dropped, so clients can't store arbitrary data in meta.
const CLIENT_META = {
  text: z.object({}).strip(),
  image: z.object({ ...dimensions }).strip(),
  video: z.object({ ...dimensions, durationMs: duration.optional() }).strip(),
  audio: z.object({ durationMs: duration.optional(), waveform: z.array(z.number().min(0).max(1)).max(128).optional() }).strip(),
  voice: z.object({ durationMs: duration, waveform: z.array(z.number().min(0).max(1)).max(128).optional() }).strip(),
  file: z.object({}).strip(),
  link: z.object({ url: z.string().url().max(2000), title: z.string().max(300).optional(), description: z.string().max(1000).optional(), imageUrl: z.string().url().max(2000).optional() }).strip(),
  location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), label: z.string().max(200).optional() }).strip(),
} as const;

export type ClientMessageType = keyof typeof CLIENT_META;
const NEEDS_ATTACHMENT: ClientMessageType[] = ["image", "video", "audio", "voice", "file"];

export class MessageShapeError extends Error {}

// Returns the meta to store, or throws. `system` messages come from the server only.
export function buildMeta(input: { type: string; body: string; meta?: unknown; attachments: MetaAttachment[] }): Record<string, unknown> {
  const { type, body, attachments } = input;
  if (!(type in CLIENT_META)) throw new MessageShapeError(`Messages of type ${type} can't be sent`);
  const schema = CLIENT_META[type as ClientMessageType];
  const parsed = schema.safeParse(input.meta ?? {});
  if (!parsed.success) throw new MessageShapeError(`Bad ${type} message: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(", ")}`);

  const needsFile = NEEDS_ATTACHMENT.includes(type as ClientMessageType);
  if (needsFile && !attachments.length) throw new MessageShapeError(`A ${type} message needs an attachment`);
  if (!needsFile && attachments.length) throw new MessageShapeError(`A ${type} message can't have attachments`);
  if (type === "text" && !body.trim()) throw new MessageShapeError("A message can't be empty");
  return { ...parsed.data, ...(needsFile ? { attachments } : {}) };
}

// A short line for the conversation list. Never includes a deleted message's text.
export function previewOf(type: string, body: string): string {
  const text = body.trim().replace(/\s+/g, " ");
  const fallback: Record<string, string> = { image: "Photo", video: "Video", audio: "Audio", voice: "Voice note", file: "File", link: "Link", location: "Location", system: "" };
  return (text || fallback[type] || "").slice(0, 160);
}

// Words become prefix terms, so "hem" finds "hemp"; punctuation can't break the query.
export function toSearchQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.slice(0, 8).map((w) => `${w}:*`).join(" & ") : null;
}

export const directKeyOf = (a: string, b: string) => [a, b].sort().join(":");
