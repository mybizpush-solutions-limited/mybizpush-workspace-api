import { Announcement, AnnouncementReceipt, User, type AudienceType } from "../../models";
import { groupsService } from "../../modules/groups/groups.service";
import type { SeedContext } from "./context";
import { addMinutes, dayAt, hash, minutesAgo, now } from "./time";

interface AnnouncementSpec {
  title: string;
  body: string;
  author: string;
  audience: { type: "organization" } | { type: "product" | "department"; ref: string };
  publishedDaysAgo: number | null;
  requireAck?: boolean;
  pinned?: boolean;
  expiresInDays?: number;
}

const ANNOUNCEMENTS: AnnouncementSpec[] = [
  {
    title: "Welcome to MyBizPush Workspace",
    body: "Workspace is now our home for tasks, chat, meetings, announcements and attendance. Install the mobile app, turn on notifications and check in at the office with the QR code on the screen at reception.",
    author: "ada",
    audience: { type: "organization" },
    publishedDaysAgo: 12,
    pinned: true,
  },
  {
    title: "Updated leave and remote work policy",
    body: "From December, annual leave requests go through Workspace and need approval from your manager at least 5 working days ahead. Hybrid staff should be in the office on Monday, Wednesday and Thursday. Please read the full policy and acknowledge.",
    author: "funke",
    audience: { type: "organization" },
    publishedDaysAgo: 3,
    requireAck: true,
  },
  {
    title: "Turn on two factor authentication",
    body: "To protect customer data, every account must have two factor authentication enabled by the end of next week. Go to Profile, Security and follow the steps with any authenticator app.",
    author: "ngozi",
    audience: { type: "organization" },
    publishedDaysAgo: 5,
    requireAck: true,
  },
  {
    title: "Hyparrow public beta opens next Monday",
    body: "Thanks to everyone who tested deploys this month. The first 300 waitlist invites go out on Monday morning. Report anything odd in hyparrow-beta.",
    author: "ngozi",
    audience: { type: "product", ref: "hyparrow" },
    publishedDaysAgo: 1,
    expiresInDays: 10,
  },
  {
    title: "Q4 all hands on Friday at 3pm",
    body: "Join us in the main hall at Lagos HQ or online. Lunch is provided for everyone in the office. Bring one win and one thing that slowed you down this quarter.",
    author: "tunde",
    audience: { type: "organization" },
    publishedDaysAgo: 0,
    pinned: true,
    expiresInDays: 6,
  },
  {
    title: "End of year party: save the date",
    body: "Draft. Date, venue and dress code to be confirmed with leadership.",
    author: "funke",
    audience: { type: "organization" },
    publishedDaysAgo: null,
  },
];

async function recipientsOf(type: AudienceType, ids: string[]): Promise<string[]> {
  if (type === "organization") return (await User.findAll({ where: { status: "active" }, attributes: ["id"] })).map((u) => u.id);
  return groupsService.expandIds(ids.map((id) => ({ type: type as "product" | "department", id })));
}

export async function seedAnnouncements(ctx: SeedContext): Promise<void> {
  for (const spec of ANNOUNCEMENTS) {
    if (await Announcement.findOne({ where: { title: spec.title } })) continue;
    const audienceIds = spec.audience.type === "organization" ? [] : [spec.audience.type === "product" ? ctx.product(spec.audience.ref).id : ctx.department(spec.audience.ref).id];
    const published = spec.publishedDaysAgo !== null;
    const publishedAt = published ? (spec.publishedDaysAgo === 0 ? minutesAgo(45) : dayAt(-spec.publishedDaysAgo!, "09:10")) : null;
    const author = ctx.id(spec.author);

    const announcement = await Announcement.create({
      title: spec.title,
      body: spec.body,
      audienceType: spec.audience.type,
      audienceIds,
      status: published ? "published" : "draft",
      requireAck: spec.requireAck ?? false,
      pinned: spec.pinned ?? false,
      publishedAt,
      publishedBy: published ? author : null,
      expiresAt: spec.expiresInDays ? dayAt(spec.expiresInDays, "18:00") : null,
      createdBy: author,
      createdAt: publishedAt ? addMinutes(publishedAt, -90) : minutesAgo(60 * 26),
    });
    if (!publishedAt) continue;

    const recipients = await recipientsOf(spec.audience.type, audienceIds);
    const ageMinutes = (now.getTime() - publishedAt.getTime()) / 60_000;
    const receipts = recipients.map((userId) => {
      const roll = hash(`${spec.title}:${userId}`) % 10;
      const readAt = userId === author || roll < 7 ? addMinutes(publishedAt, Math.min(ageMinutes - 1, 20 + roll * 37)) : null;
      const acknowledgedAt = spec.requireAck && readAt && userId !== ctx.id("ada") && roll < 5 ? addMinutes(readAt, 3) : null;
      return { announcementId: announcement.id, userId, readAt, acknowledgedAt };
    });
    await AnnouncementReceipt.bulkCreate(receipts, { ignoreDuplicates: true });
    await announcement.update({ recipientCount: recipients.length, acknowledgedCount: receipts.filter((r) => r.acknowledgedAt).length });
  }
}
