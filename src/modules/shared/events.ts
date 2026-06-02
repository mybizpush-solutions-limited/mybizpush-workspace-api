import { Activity, Notification } from "../../models";
import type { ItemType } from "../../models";

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

// Create a notification for a recipient (no-op if it'd notify the actor themself).
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
}
