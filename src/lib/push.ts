import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { Op } from "sequelize";
import { env } from "../config/env";
import { DeviceToken } from "../models";

// Push delivery through Expo's push service (API-CHANGES A003). Callers never
// use this directly from a request: they enqueue a `push` job and the worker
// calls sendToUser(), so retries and failures are handled by BullMQ.

const expo = new Expo(env.EXPO_ACCESS_TOKEN ? { accessToken: env.EXPO_ACCESS_TOKEN } : {});

export interface PushPayload {
  title: string;
  body: string;
  // Deep link and routing info for the app (url like mybizpush://tasks/<id>).
  data: Record<string, unknown>;
  badge?: number;
  // Groups related pushes on the lock screen (one conversation, one task).
  threadId?: string;
  // Hide content on the lock screen (HR queries, appraisals).
  sensitive?: boolean;
}

export interface SentTicket {
  ticketId: string;
  token: string;
}

export async function activeTokensFor(userId: string): Promise<string[]> {
  const rows = await DeviceToken.findAll({ where: { userId, disabledAt: { [Op.is]: null } }, attributes: ["token"] });
  return rows.map((r) => r.token).filter((t) => Expo.isExpoPushToken(t));
}

export async function disableTokens(tokens: string[]): Promise<void> {
  if (!tokens.length) return;
  await DeviceToken.update({ disabledAt: new Date() }, { where: { token: tokens, disabledAt: { [Op.is]: null } } });
}

// Sends one notification to every active device of a user. Returns the tickets
// to check receipts for later. Tokens Expo rejects outright are disabled.
export async function sendToUser(userId: string, payload: PushPayload): Promise<SentTicket[]> {
  if (!env.PUSH_ENABLED) return [];
  const tokens = await activeTokensFor(userId);
  if (!tokens.length) return [];

  const messages: ExpoPushMessage[] = tokens.map((to) => ({
    to,
    title: payload.title,
    body: payload.sensitive ? "Open the app to read it." : payload.body,
    data: payload.data,
    badge: payload.badge,
    sound: "default",
    priority: "high",
    channelId: "default",
    threadId: payload.threadId,
  }));

  const sent: SentTicket[] = [];
  const dead: string[] = [];
  for (const chunk of expo.chunkPushNotifications(messages)) {
    // A network or 5xx error throws here; the job fails and BullMQ retries it.
    const tickets: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);
    tickets.forEach((ticket, i) => {
      const token = chunk[i]!.to as string;
      if (ticket.status === "ok") sent.push({ ticketId: ticket.id, token });
      else if (ticket.details?.error === "DeviceNotRegistered") dead.push(token);
      else console.error(`[push] ticket error for ${token}: ${ticket.message}`);
    });
  }
  await disableTokens(dead);
  return sent;
}

// Expo confirms delivery to Apple and Google later. Receipts that say the app is
// gone (DeviceNotRegistered) disable the token so we stop sending to it.
export async function checkReceipts(tickets: SentTicket[]): Promise<{ ok: number; failed: number }> {
  const tokenByTicket = new Map(tickets.map((t) => [t.ticketId, t.token]));
  let ok = 0;
  let failed = 0;
  const dead: string[] = [];
  for (const ids of expo.chunkPushNotificationReceiptIds([...tokenByTicket.keys()])) {
    const receipts = await expo.getPushNotificationReceiptsAsync(ids);
    for (const [id, receipt] of Object.entries(receipts)) {
      if (receipt.status === "ok") {
        ok++;
        continue;
      }
      failed++;
      if (receipt.details?.error === "DeviceNotRegistered") dead.push(tokenByTicket.get(id)!);
      else console.error(`[push] receipt ${id} error: ${receipt.message}`);
    }
  }
  await disableTokens(dead);
  return { ok, failed };
}

export const isExpoPushToken = (token: unknown): token is string => Expo.isExpoPushToken(token);
