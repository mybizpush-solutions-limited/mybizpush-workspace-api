import { Notification } from "../../models";
import { notFound } from "../../lib/errors";
import { serializeNotification } from "../shared/serializers";

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
    return serializeNotification(n);
  },

  async markAllRead(userId: string) {
    await Notification.update({ read: true }, { where: { userId, read: false } });
  },
};
