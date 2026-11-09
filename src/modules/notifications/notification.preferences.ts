import { NotificationCategoryPreference, NotificationPreference } from "../../models";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  defaultChannels,
  LEGACY_EMAIL_DEFAULT,
  LEGACY_EMAIL_FLAG,
  type Category,
  type Channels,
  type QuietHours,
} from "./notification.kinds";

// Per category choices (API-CHANGES A304, ME-03). Nobody needs a row: with none,
// the defaults apply, and the web app's older email switches still decide email.

function legacyEmail(category: Category, pref: NotificationPreference | null): boolean {
  const flag = LEGACY_EMAIL_FLAG[category];
  if (!flag) return false;
  return pref ? Boolean(pref[flag]) : LEGACY_EMAIL_DEFAULT[flag];
}

export async function channelsFor(userId: string, category: Category): Promise<Channels> {
  const row = await NotificationCategoryPreference.findOne({ where: { userId, category } });
  if (row) return { inApp: row.inApp, push: row.push, email: row.email };
  const pref = await NotificationPreference.findByPk(userId);
  return { ...defaultChannels(category), email: legacyEmail(category, pref) };
}

export async function quietHoursFor(userId: string): Promise<QuietHours> {
  const p = await NotificationPreference.findByPk(userId);
  return {
    enabled: p?.quietEnabled ?? false,
    start: p?.quietStart ?? "22:00",
    end: p?.quietEnd ?? "07:00",
    timezone: p?.quietTimezone ?? "Africa/Lagos",
  };
}

export const notificationPreferences = {
  async get(userId: string) {
    const [rows, pref] = await Promise.all([NotificationCategoryPreference.findAll({ where: { userId } }), NotificationPreference.findByPk(userId)]);
    const set = new Map(rows.map((r) => [r.category, r]));
    return {
      categories: CATEGORIES.map((key) => {
        const row = set.get(key);
        const channels = row ? { inApp: row.inApp, push: row.push, email: row.email } : { ...defaultChannels(key), email: legacyEmail(key, pref) };
        return { key, label: CATEGORY_LABELS[key], ...channels };
      }),
      quietHours: await quietHoursFor(userId),
      digestFrequency: pref?.digestFrequency ?? "daily",
    };
  },

  async update(userId: string, patch: { categories?: ({ key: Category } & Partial<Channels>)[]; quietHours?: Partial<QuietHours>; digestFrequency?: "off" | "daily" | "weekly" }) {
    for (const c of patch.categories ?? []) {
      const current = await channelsFor(userId, c.key);
      await NotificationCategoryPreference.upsert({
        userId,
        category: c.key,
        inApp: c.inApp ?? current.inApp,
        push: c.push ?? current.push,
        email: c.email ?? current.email,
      });
    }
    if (patch.quietHours || patch.digestFrequency) {
      const [pref] = await NotificationPreference.findOrCreate({ where: { userId }, defaults: { userId } });
      const q = patch.quietHours ?? {};
      await pref.update({
        ...(q.enabled !== undefined ? { quietEnabled: q.enabled } : {}),
        ...(q.start !== undefined ? { quietStart: q.start } : {}),
        ...(q.end !== undefined ? { quietEnd: q.end } : {}),
        ...(q.timezone !== undefined ? { quietTimezone: q.timezone } : {}),
        ...(patch.digestFrequency ? { digestFrequency: patch.digestFrequency } : {}),
      });
    }
    return this.get(userId);
  },
};
