import { Notification, User } from "../../models";
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

// Where tapping the push takes the user in the app.
function deepLink(itemType: string, itemId: string): string {
  return `mybizpush://${itemType}s/${itemId}`;
}

// Expo confirms delivery a few minutes after sending; check then.
const RECEIPT_DELAY_MS = 15 * 60 * 1000;

registerJob<{ notificationId: string }>("push", "notification", async ({ notificationId }) => {
  const n = await Notification.findByPk(notificationId);
  if (!n || n.read) return; // deleted or already read in the app: nothing to say
  const from = n.fromUserId ? await User.findByPk(n.fromUserId, { attributes: ["name"] }) : null;
  const badge = await Notification.count({ where: { userId: n.userId, read: false } });

  const tickets = await sendToUser(n.userId, {
    title: shortName(from?.name),
    body: n.message,
    badge,
    threadId: `${n.itemType}:${n.itemId}`,
    data: {
      url: deepLink(n.itemType, n.itemId),
      notificationId: n.id,
      kind: n.kind,
      itemType: n.itemType,
      itemId: n.itemId,
    },
  });
  if (tickets.length) {
    await enqueue("push", "receipts", { tickets }, { delay: RECEIPT_DELAY_MS, jobId: `receipts:${n.id}` });
  }
});

registerJob<{ tickets: SentTicket[] }>("push", "receipts", async ({ tickets }) => {
  await checkReceipts(tickets);
});
