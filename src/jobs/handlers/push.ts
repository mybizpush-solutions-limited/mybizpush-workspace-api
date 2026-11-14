import { Notification, User, type RecordType } from "../../models";
import { deepLink, isQuietNow, isSensitiveKind } from "../../modules/notifications/notification.kinds";
import { quietHoursFor } from "../../modules/notifications/notification.preferences";
import { checkReceipts, sendToUser, type SentTicket } from "../../lib/push";
import { enqueue } from "../queues";
import { registerJob } from "../workers";

// "Daniel Okafor" -> "Daniel O." (the push catalogue's title style, SYS-22).
export function shortName(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "MyBizPush";
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

// Expo confirms delivery a few minutes after sending; check then.
const RECEIPT_DELAY_MS = 15 * 60 * 1000;

registerJob<{ notificationId: string }>("push", "notification", async ({ notificationId }) => {
  const n = await Notification.findByPk(notificationId);
  if (!n || n.read) return; // deleted or already read in the app: nothing to say
  if (isQuietNow(await quietHoursFor(n.userId))) return; // the row is there when they look
  const from = n.fromUserId ? await User.findByPk(n.fromUserId, { attributes: ["name"] }) : null;
  const badge = await Notification.count({ where: { userId: n.userId, read: false } });

  const tickets = await sendToUser(n.userId, {
    title: shortName(from?.name),
    body: n.message,
    badge,
    threadId: `${n.itemType}:${n.itemId}`,
    sensitive: isSensitiveKind(n.kind),
    data: {
      url: deepLink(n.itemType, n.itemId, n.data),
      notificationId: n.id,
      kind: n.kind,
      itemType: n.itemType,
      itemId: n.itemId,
      ...(n.data ?? {}),
    },
  });
  if (tickets.length) {
    await enqueue("push", "receipts", { tickets }, { delay: RECEIPT_DELAY_MS, jobId: `receipts-${n.id}` });
  }
});

// A push with no row in the notification list (chat messages by default).
registerJob<{ userId: string; fromUserId: string | null; kind: string; itemId: string; itemType: RecordType; message: string; data: Record<string, unknown> | null }>(
  "push",
  "direct",
  async (p) => {
    if (isQuietNow(await quietHoursFor(p.userId))) return;
    const from = p.fromUserId ? await User.findByPk(p.fromUserId, { attributes: ["name"] }) : null;
    const tickets = await sendToUser(p.userId, {
      title: shortName(from?.name),
      body: p.message,
      threadId: `${p.itemType}:${p.itemId}`,
      sensitive: isSensitiveKind(p.kind),
      data: { url: deepLink(p.itemType, p.itemId, p.data), kind: p.kind, itemType: p.itemType, itemId: p.itemId, ...(p.data ?? {}) },
    });
    if (tickets.length) await enqueue("push", "receipts", { tickets }, { delay: RECEIPT_DELAY_MS });
  },
);

registerJob<{ tickets: SentTicket[] }>("push", "receipts", async ({ tickets }) => {
  await checkReceipts(tickets);
});
