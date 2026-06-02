import { NotificationPreference } from "../../models";
import { serializePreferences } from "../shared/serializers";

type ChannelPatch = Partial<{
  meetingReminders: boolean;
  pendingTasks: boolean;
  feedbackRequests: boolean;
  mentions: boolean;
  events: boolean;
}>;

export const preferencesService = {
  async forUser(userId: string) {
    const [prefs] = await NotificationPreference.findOrCreate({ where: { userId }, defaults: { userId } });
    return serializePreferences(prefs);
  },

  async update(userId: string, patch: { channels?: ChannelPatch; digestFrequency?: "off" | "daily" | "weekly" }) {
    const [prefs] = await NotificationPreference.findOrCreate({ where: { userId }, defaults: { userId } });
    await prefs.update({
      ...(patch.channels ?? {}),
      ...(patch.digestFrequency !== undefined ? { digestFrequency: patch.digestFrequency } : {}),
    });
    return serializePreferences(prefs);
  },
};
