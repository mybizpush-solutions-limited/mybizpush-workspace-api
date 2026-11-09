import { google, type gmail_v1 } from "googleapis";
import { Op } from "sequelize";
import { env } from "../../config/env";
import { audit } from "../../lib/audit";
import { decryptSecret } from "../../lib/crypto";
import { AppError, forbidden, notFound } from "../../lib/errors";
import { isGoogleConfigured } from "../../lib/google";
import { EmailThreadLink, GoogleAccount, Issue, Project, Task, User, type ThreadRecordType } from "../../models";
import { can } from "../access/engine";
import type { Scope } from "../access/catalog";
import { notify } from "../shared/events";
import { syncHint } from "../shared/live";
import { buildRawMessage, extractBody, hasNewReply, headerOf, parseAddresses } from "./integrations.pure";

// Gmail (API-CHANGES A701). Each person only ever reaches their own mailbox, with
// their own consent. Without Google credentials, calls return 503 and nothing else
// in the API is affected.

type Req = Parameters<typeof audit>[0]["req"];
export type GmailApi = gmail_v1.Gmail;
const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function assertConfigured(): void {
  if (!isGoogleConfigured() && !clientOverride) throw new AppError(503, "Google integration is not configured", "google_unconfigured");
}

// A stand-in mailbox for tests, since nothing here can reach Google.
let clientOverride: ((refreshToken: string) => GmailApi) | null = null;
export function setGmailClient(factory: ((refreshToken: string) => GmailApi) | null): void {
  clientOverride = factory;
}

async function gmailFor(userId: string): Promise<{ gmail: GmailApi; account: GoogleAccount }> {
  assertConfigured();
  const account = await GoogleAccount.findByPk(userId);
  if (!account?.gmailRefreshToken) throw new AppError(409, "Connect Gmail first", "gmail_not_connected");
  const refreshToken = decryptSecret(account.gmailRefreshToken);
  if (clientOverride) return { gmail: clientOverride(refreshToken), account };
  const client = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
  client.setCredentials({ refresh_token: refreshToken });
  return { gmail: google.gmail({ version: "v1", auth: client }), account };
}

// Google refusing the stored token means the person has to connect again.
function isAuthFailure(err: unknown): boolean {
  const e = err as { code?: number; status?: number; response?: { status?: number; data?: { error?: string } }; message?: string };
  const status = e.response?.status ?? e.status ?? e.code;
  return status === 401 || e.response?.data?.error === "invalid_grant" || /invalid_grant/.test(e.message ?? "");
}
function translate(err: unknown): never {
  if (isAuthFailure(err)) throw new AppError(409, "Google has revoked Gmail access. Connect again.", "gmail_reauthorize");
  const status = (err as { code?: number; response?: { status?: number } }).response?.status ?? (err as { code?: number }).code;
  if (status === 404) throw notFound("That email thread wasn't found");
  throw err;
}

function serializeThread(t: gmail_v1.Schema$Thread) {
  const messages = t.messages ?? [];
  const last = messages[messages.length - 1];
  const first = messages[0];
  const people = new Map<string, { name: string; email: string }>();
  for (const m of messages) {
    for (const h of ["From", "To", "Cc"]) {
      for (const a of parseAddresses(headerOf(m.payload?.headers, h))) if (!people.has(a.email.toLowerCase())) people.set(a.email.toLowerCase(), a);
    }
  }
  return {
    id: t.id ?? "",
    subject: headerOf(first?.payload?.headers, "Subject") ?? "",
    snippet: last?.snippet ?? t.snippet ?? "",
    participants: [...people.values()],
    messageCount: messages.length,
    lastMessageAt: last?.internalDate ? new Date(Number(last.internalDate)).toISOString() : null,
    unread: messages.some((m) => m.labelIds?.includes("UNREAD")),
  };
}

function serializeMessage(m: gmail_v1.Schema$Message) {
  const headers = m.payload?.headers;
  const body = extractBody(m.payload as Parameters<typeof extractBody>[0]);
  return {
    id: m.id ?? "",
    threadId: m.threadId ?? "",
    from: parseAddresses(headerOf(headers, "From"))[0] ?? { name: "", email: "" },
    to: parseAddresses(headerOf(headers, "To")),
    cc: parseAddresses(headerOf(headers, "Cc")),
    subject: headerOf(headers, "Subject") ?? "",
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    snippet: m.snippet ?? "",
    bodyText: body.text,
    bodyHtml: body.html,
    attachments: body.attachments,
  };
}

export function serializeLink(l: EmailThreadLink, linkedByName = "") {
  return {
    id: l.id,
    threadId: l.threadId,
    recordType: l.recordType,
    recordId: l.recordId,
    subject: l.subject,
    snippet: l.snippet,
    participants: l.participants,
    messageCount: l.messageCount,
    lastMessageAt: l.lastMessageAt?.toISOString() ?? null,
    hasNewReply: l.hasNewReply,
    linkedBy: l.linkedBy,
    linkedByName,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

// The scope a record's permissions are checked on, and whether it exists.
async function recordScope(type: ThreadRecordType, id: string): Promise<Scope> {
  if (type === "project") {
    if (!(await Project.findByPk(id, { attributes: ["id"] }))) throw notFound("That project no longer exists");
    return { type: "project", id };
  }
  if (type === "product") return { type: "product", id };
  const row = await (type === "task" ? Task.findByPk(id, { attributes: ["projectId"] }) : Issue.findByPk(id, { attributes: ["projectId"] }));
  if (!row) throw notFound(`That ${type} no longer exists`);
  return { type: "project", id: row.projectId };
}

const fetchThread = async (gmail: GmailApi, id: string) => (await gmail.users.threads.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] })).data;

async function saveLink(userId: string, threadId: string, recordType: ThreadRecordType, recordId: string, thread: gmail_v1.Schema$Thread) {
  const t = serializeThread(thread);
  const [link, created] = await EmailThreadLink.findOrCreate({
    where: { threadId, recordType, recordId, linkedBy: userId },
    defaults: {
      threadId,
      recordType,
      recordId,
      linkedBy: userId,
      subject: t.subject.slice(0, 500),
      snippet: t.snippet.slice(0, 500),
      participants: t.participants,
      messageCount: t.messageCount,
      lastMessageAt: t.lastMessageAt ? new Date(t.lastMessageAt) : null,
    },
  });
  syncHint([userId], ["emailThreadLinks"]);
  return { link, created };
}

const nameOf = async (id: string) => (await User.findByPk(id, { attributes: ["name"] }))?.name ?? "";

export const gmailService = {
  async status(userId: string) {
    const account = await GoogleAccount.findByPk(userId);
    const scopes = account?.gmailScopes ?? "";
    return { connected: !!account?.gmailRefreshToken, email: account?.gmailEmail ?? null, canRead: scopes.includes(READ_SCOPE), canSend: scopes.includes(SEND_SCOPE) };
  },

  async disconnect(userId: string): Promise<void> {
    await GoogleAccount.update({ gmailRefreshToken: null, gmailEmail: null, gmailScopes: null }, { where: { userId } });
  },

  async threads(userId: string, q: { q?: string; pageToken?: string; limit?: number }) {
    const { gmail } = await gmailFor(userId);
    try {
      const list = await gmail.users.threads.list({ userId: "me", q: q.q, pageToken: q.pageToken, maxResults: q.limit ?? 20 });
      const threads = await Promise.all((list.data.threads ?? []).map(async (t) => serializeThread(await fetchThread(gmail, t.id!))));
      return { threads, nextPageToken: list.data.nextPageToken ?? null };
    } catch (err) {
      translate(err);
    }
  },

  async thread(userId: string, id: string) {
    const { gmail } = await gmailFor(userId);
    try {
      const { data } = await gmail.users.threads.get({ userId: "me", id, format: "full" });
      return { thread: serializeThread(data), messages: (data.messages ?? []).map(serializeMessage) };
    } catch (err) {
      translate(err);
    }
  },

  async send(userId: string, input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; html?: boolean; threadId?: string; inReplyToMessageId?: string; link?: { recordType: ThreadRecordType; recordId: string } }, req?: Req) {
    const { gmail, account } = await gmailFor(userId);
    if (input.link && !(await can({ sub: userId }, "task.view", await recordScope(input.link.recordType, input.link.recordId)))) throw forbidden("You can't link to that record");
    try {
      let inReplyTo: string | null = null;
      if (input.inReplyToMessageId) {
        const orig = await gmail.users.messages.get({ userId: "me", id: input.inReplyToMessageId, format: "metadata", metadataHeaders: ["Message-ID"] });
        inReplyTo = headerOf(orig.data.payload?.headers, "Message-ID");
      }
      const raw = buildRawMessage({ from: account.gmailEmail ?? "me", to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, body: input.body, html: input.html, inReplyTo });
      const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId: input.threadId } });
      const threadId = sent.data.threadId ?? input.threadId ?? "";
      // Who it went to and the text stay out of the audit log.
      await audit({ req, actorId: userId, action: "gmail.send", target: { type: "gmail_message", id: sent.data.id ?? null }, after: { recipients: input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0), link: input.link ?? null } });
      let link = null;
      if (input.link && threadId) {
        const saved = await saveLink(userId, threadId, input.link.recordType, input.link.recordId, await fetchThread(gmail, threadId));
        link = serializeLink(saved.link, await nameOf(userId));
      }
      return { messageId: sent.data.id ?? null, threadId, link };
    } catch (err) {
      translate(err);
    }
  },

  async taskDraft(userId: string, threadId: string) {
    const { gmail } = await gmailFor(userId);
    try {
      const { data } = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
      const messages = data.messages ?? [];
      const last = messages[messages.length - 1];
      const subject = headerOf(messages[0]?.payload?.headers, "Subject") ?? "";
      const body = extractBody(last?.payload as Parameters<typeof extractBody>[0]);
      const from = headerOf(last?.payload?.headers, "From") ?? "";
      return { draft: { title: subject.replace(/^(re|fwd?):\s*/i, "").slice(0, 200), description: `From: ${from}\n\n${(body.text || last?.snippet || "").slice(0, 6000)}`, sourceType: "email", sourceId: threadId } };
    } catch (err) {
      translate(err);
    }
  },

  async link(userId: string, input: { threadId: string; recordType: ThreadRecordType; recordId: string }) {
    const scope = await recordScope(input.recordType, input.recordId);
    if (!(await can({ sub: userId }, "task.view", scope))) throw forbidden("You can't link to that record");
    const { gmail } = await gmailFor(userId);
    try {
      const { link, created } = await saveLink(userId, input.threadId, input.recordType, input.recordId, await fetchThread(gmail, input.threadId));
      return { created, link: serializeLink(link, await nameOf(userId)) };
    } catch (err) {
      translate(err);
    }
  },

  async links(q: { recordType: ThreadRecordType; recordId: string }) {
    const rows = await EmailThreadLink.findAll({ where: { recordType: q.recordType, recordId: q.recordId }, order: [["lastMessageAt", "DESC"]] });
    const people = rows.length ? await User.findAll({ where: { id: [...new Set(rows.map((r) => r.linkedBy))] }, attributes: ["id", "name"] }) : [];
    const names = new Map(people.map((p) => [p.id, p.name]));
    return rows.map((l) => serializeLink(l, names.get(l.linkedBy) ?? ""));
  },

  async seen(id: string, userId: string) {
    const l = await EmailThreadLink.findByPk(id);
    if (!l) throw notFound("Link not found");
    if (l.linkedBy !== userId) throw forbidden("Only the person who linked this can do that");
    await l.update({ hasNewReply: false });
    syncHint([userId], ["emailThreadLinks"]);
    return serializeLink(l, await nameOf(userId));
  },

  async unlink(id: string, userId: string): Promise<void> {
    const l = await EmailThreadLink.findByPk(id);
    if (!l) throw notFound("Link not found");
    if (l.linkedBy !== userId && !(await can({ sub: userId }, "task.assign", await recordScope(l.recordType, l.recordId)))) throw forbidden("You can't remove this link");
    await l.destroy();
    syncHint([l.linkedBy, userId], ["emailThreadLinks"]);
  },

  // Every 15 minutes: has anyone answered a linked thread?
  async checkReplies(): Promise<void> {
    const users = await EmailThreadLink.findAll({ attributes: ["linkedBy"], group: ["linkedBy"], raw: true });
    for (const { linkedBy } of users) {
      const account = await GoogleAccount.findByPk(linkedBy);
      if (!account?.gmailRefreshToken) continue;
      const links = await EmailThreadLink.findAll({ where: { linkedBy, updatedAt: { [Op.gte]: new Date(Date.now() - 90 * 86_400_000) } } });
      let gmail: GmailApi;
      try {
        gmail = (await gmailFor(linkedBy)).gmail;
      } catch {
        continue;
      }
      for (const link of links) {
        try {
          const thread = await fetchThread(gmail, link.threadId);
          const t = serializeThread(thread);
          const messages = thread.messages ?? [];
          const fresh = hasNewReply({ knownCount: link.messageCount, currentCount: t.messageCount, lastFrom: headerOf(messages[messages.length - 1]?.payload?.headers, "From"), myEmail: account.gmailEmail ?? null });
          await link.update({
            messageCount: t.messageCount,
            snippet: t.snippet.slice(0, 500),
            participants: t.participants,
            lastMessageAt: t.lastMessageAt ? new Date(t.lastMessageAt) : link.lastMessageAt,
            hasNewReply: link.hasNewReply || fresh,
            lastCheckFailedAt: null,
          });
          if (fresh) {
            await notify({ userId: linkedBy, fromUserId: null, kind: "status_changed", itemId: link.recordId, itemType: link.recordType, message: `New reply on ${t.subject || "a linked email"}` });
            syncHint([linkedBy], ["emailThreadLinks"]);
          }
        } catch (err) {
          // Tell the person once, not every 15 minutes.
          if (!link.lastCheckFailedAt) {
            await link.update({ lastCheckFailedAt: new Date() });
            if (isAuthFailure(err)) {
              await notify({ userId: linkedBy, fromUserId: null, kind: "integration_failure", itemId: link.recordId, itemType: link.recordType, message: "Gmail needs connecting again, so linked email replies aren't being tracked" });
            }
          }
        }
      }
    }
  },
};
