import { Activity, Notification, User } from "../../models";
import { categoryOf } from "../notifications/notification.kinds";
import { channelsFor } from "../notifications/notification.preferences";
import type { NotificationKind, RecordType } from "../../models";
import { emails } from "../../lib/email";
import { env } from "../../config/env";
import { enqueue } from "../../jobs/queues";
import { serializeNotification } from "./serializers";
import { emitToUser } from "../../realtime/events";

type ActivityKind =
  | "created" | "status_changed" | "assigned" | "commented"
  | "feedback_requested" | "feedback_provided" | "pr_linked"
  | "submitted" | "reviewed" | "dependency_changed";


// Append to the immutable activity log.
export function logActivity(input: {
  itemId: string;
  itemType: RecordType;
  actorId: string;
  kind: ActivityKind;
  data?: Record<string, unknown>;
}): Promise<Activity> {
  return Activity.create({
    itemId: input.itemId,
    itemType: input.itemType,
    actorId: input.actorId,
    kind: input.kind,
    data: input.data ?? null,
  });
}

// Best-effort real-time email alert for a notification (no-ops without Resend
// configured). The caller has already checked the recipient's preferences.
async function emailAlert(userId: string, message: string): Promise<void> {
  try {
    const user = await User.findByPk(userId, { attributes: ["email", "name"] });
    if (!user?.email) return;
    await emails.activityAlert(user.email, user.name, { message, url: `${env.APP_URL}/inbox` });
  } catch {
    /* email is best-effort */
  }
}

// Email someone when they're given a role (project manager, department head…).
export async function notifyRoleAssigned(userId: string, role: string, contextName: string): Promise<void> {
  try {
    const user = await User.findByPk(userId, { attributes: ["email", "name"] });
    if (!user?.email) return;
    await emails.roleAssigned(user.email, user.name, { role, contextName, url: env.APP_URL });
  } catch {
    /* best-effort */
  }
}

// Tell the recipient's open apps right away: the new notification and the
// updated unread count for the badge.
async function announceNotification(notification: Notification): Promise<void> {
  try {
    emitToUser(notification.userId, "notification:new", { notification: serializeNotification(notification) });
    const unread = await Notification.count({ where: { userId: notification.userId, read: false } });
    emitToUser(notification.userId, "badges", { notifications: unread });
  } catch (err) {
    console.error("realtime announce failed", err);
  }
}

// Create a notification for a recipient (no-op if it'd notify the actor themself)
// and fire a real-time email alert.
export async function notify(input: {
  userId: string;
  fromUserId: string | null; // null for system-generated reminders
  kind: NotificationKind;
  itemId: string;
  itemType: RecordType;
  message: string;
  data?: Record<string, unknown> | null;
}): Promise<void> {
  if (input.userId === input.fromUserId) return;
  const channels = await channelsFor(input.userId, categoryOf(input.kind));
  if (channels.email) void emailAlert(input.userId, input.message);
  // Push only, with nothing in the notification list (chat messages by default).
  if (!channels.inApp) {
    if (channels.push) {
      void enqueue("push", "direct", { ...input, data: input.data ?? null }).catch((err) => console.error("push not queued", err));
    }
    return;
  }
  const notification = await Notification.create({
    userId: input.userId,
    fromUserId: input.fromUserId,
    kind: input.kind,
    itemId: input.itemId,
    itemType: input.itemType,
    message: input.message,
    data: input.data ?? null,
    read: false,
  });
  if (!channels.push) {
    void announceNotification(notification);
    return;
  }
  // Push to the recipient's phones. The job id is the notification id, so a
  // retry of this request can never push the same notification twice.
  void enqueue("push", "notification", { notificationId: notification.id }, { jobId: `notification-${notification.id}` }).catch(
    (err) => console.error("push not queued", err),
  );
  void announceNotification(notification);
}
