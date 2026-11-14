import { Notification } from "../../models";
import { notFound } from "../../lib/errors";
import { serializeNotification } from "../shared/serializers";
import { emitToUser } from "../../realtime/events";

// Reading on one device clears the badge on the user's other devices too.
async function pushBadge(userId: string): Promise<void> {
  const unread = await Notification.count({ where: { userId, read: false } });
  emitToUser(userId, "badges", { notifications: unread });
}

export const notificationsService = {
  async forUser(userId: string) {
    const rows = await Notification.findAll({ where: { userId }, order: [["createdAt", "DESC"]] });
    return rows.map(serializeNotification);
  },

  unreadCount: (userId: string) => Notification.count({ where: { userId, read: false } }),

  async markRead(id: string, userId: string) {
    const n = await Notification.findOne({ where: { id, userId } });
    if (!n) throw notFound("Notification not found");
    await n.update({ read: true });
    await pushBadge(userId);
    return serializeNotification(n);
  },

  async markAllRead(userId: string) {
    await Notification.update({ read: true }, { where: { userId, read: false } });
    await pushBadge(userId);
  },
};
