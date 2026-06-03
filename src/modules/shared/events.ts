import { Activity, Notification, NotificationPreference, User } from "../../models";
import type { ItemType } from "../../models";
import { emails } from "../../lib/email";
import { env } from "../../config/env";

type ActivityKind =
  | "created" | "status_changed" | "assigned" | "commented"
  | "feedback_requested" | "feedback_provided" | "pr_linked";

type NotificationKind = "assigned" | "mentioned" | "feedback_requested" | "status_changed" | "commented";

// Append to the immutable activity log.
export function logActivity(input: {
  itemId: string;
  itemType: ItemType;
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

// Which notification preference gates the email for each kind. Defaults apply
// when the user has no preferences row yet (we email by default — comprehensive).
const PREF_FOR_KIND: Record<NotificationKind, "pendingTasks" | "feedbackRequests" | "mentions" | "events"> = {
  assigned: "pendingTasks",
  status_changed: "events",
  feedback_requested: "feedbackRequests",
  mentioned: "mentions",
  commented: "events",
};
const PREF_DEFAULT: Record<string, boolean> = {
  pendingTasks: true,
  feedbackRequests: true,
  mentions: true,
  events: true,
};

// Best-effort real-time email alert for a notification (honours the recipient's
// preferences; no-ops without Resend configured).
async function emailAlert(userId: string, kind: NotificationKind, message: string): Promise<void> {
  try {
    const user = await User.findByPk(userId, { attributes: ["email", "name"] });
    if (!user?.email) return;
    const flag = PREF_FOR_KIND[kind];
    const pref = await NotificationPreference.findByPk(userId);
    const enabled = pref ? Boolean((pref as unknown as Record<string, boolean>)[flag]) : PREF_DEFAULT[flag];
    if (!enabled) return;
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

// Create a notification for a recipient (no-op if it'd notify the actor themself)
// and fire a real-time email alert.
export async function notify(input: {
  userId: string;
  fromUserId: string;
  kind: NotificationKind;
  itemId: string;
  itemType: ItemType;
  message: string;
}): Promise<void> {
  if (input.userId === input.fromUserId) return;
  await Notification.create({
    userId: input.userId,
    fromUserId: input.fromUserId,
    kind: input.kind,
    itemId: input.itemId,
    itemType: input.itemType,
    message: input.message,
    read: false,
  });
  void emailAlert(input.userId, input.kind, input.message);
}
