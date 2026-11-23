import { Announcement, AnnouncementReceipt, Conversation, Meeting, MeetingAttendee, Message, Notification, User, type NotificationKind, type RecordType } from "../../models";
import { CLOSED_TASK_STATUSES } from "../../models/task-status";
import { sequelize } from "../sequelize";
import type { SeedContext } from "./context";
import { hash, minutesAgo, now } from "./time";

interface Draft {
  userId: string;
  fromUserId: string | null;
  kind: NotificationKind;
  itemId: string;
  itemType: RecordType;
  message: string;
  data?: Record<string, unknown>;
  ageMinutes: number;
}

function taskDrafts(ctx: SeedContext): Draft[] {
  const drafts: Draft[] = [];
  for (const { task, project, assigneeIds } of ctx.tasks) {
    const managerId = project.managerId ?? null;
    const worker = assigneeIds[0] ?? null;
    if (task.status === "submitted" && task.reviewerId) {
      drafts.push({ userId: task.reviewerId, fromUserId: worker, kind: "submitted", itemId: task.id, itemType: "task", message: `Ready for review: ${task.title}`, ageMinutes: 180 });
    }
    if (task.status === "assigned") {
      for (const userId of assigneeIds) drafts.push({ userId, fromUserId: managerId, kind: "assigned", itemId: task.id, itemType: "task", message: `You were assigned: ${task.title}`, ageMinutes: 60 * 26 });
    }
    if (task.status === "revision_required") {
      for (const userId of assigneeIds) drafts.push({ userId, fromUserId: task.reviewerId ?? null, kind: "revision_requested", itemId: task.id, itemType: "task", message: `Changes requested: ${task.title}`, ageMinutes: 300 });
    }
    if (task.dueDate && task.dueDate < now && !CLOSED_TASK_STATUSES.includes(task.status)) {
      for (const userId of assigneeIds) drafts.push({ userId, fromUserId: null, kind: "deadline", itemId: task.id, itemType: "task", message: `Overdue: ${task.title}`, ageMinutes: 60 * 8 });
    }
    if (task.status === "blocked" && task.reporterId) {
      drafts.push({ userId: task.reporterId, fromUserId: worker, kind: "blocked", itemId: task.id, itemType: "task", message: `${task.title} is blocked: ${task.blockedReason ?? ""}`.trim(), ageMinutes: 60 * 20 });
    }
  }
  return drafts;
}

async function meetingDrafts(): Promise<Draft[]> {
  const drafts: Draft[] = [];
  const upcoming = (await Meeting.findAll({ where: { status: "scheduled" } })).filter((m) => m.startsAt > now);
  for (const meeting of upcoming) {
    const pending = await MeetingAttendee.findAll({ where: { meetingId: meeting.id, rsvp: "pending" } });
    for (const a of pending) {
      drafts.push({ userId: a.userId, fromUserId: meeting.organizerId ?? null, kind: "meeting", itemId: meeting.id, itemType: "meeting", message: `Meeting invite: ${meeting.title}`, ageMinutes: 60 * 30 });
    }
  }
  return drafts;
}

async function announcementDrafts(): Promise<Draft[]> {
  const drafts: Draft[] = [];
  for (const a of await Announcement.findAll({ where: { status: "published", requireAck: true } })) {
    const open = await AnnouncementReceipt.findAll({ where: { announcementId: a.id, acknowledgedAt: null } });
    for (const r of open) drafts.push({ userId: r.userId, fromUserId: a.publishedBy ?? null, kind: "announcement", itemId: a.id, itemType: "announcement", message: `Please acknowledge: ${a.title}`, ageMinutes: 60 * 24 });
  }
  return drafts;
}

async function mentionDrafts(): Promise<Draft[]> {
  const drafts: Draft[] = [];
  const messages = await Message.findAll({ where: sequelize.where(sequelize.fn("cardinality", sequelize.col("mentions")), ">", 0) });
  for (const m of messages) {
    const [conversation, sender] = await Promise.all([Conversation.findByPk(m.conversationId, { attributes: ["name"] }), m.senderId ? User.findByPk(m.senderId, { attributes: ["name"] }) : null]);
    const ageMinutes = Math.max(1, Math.round((now.getTime() - m.createdAt.getTime()) / 60_000));
    for (const userId of m.mentions) {
      drafts.push({
        userId,
        fromUserId: m.senderId ?? null,
        kind: "mentioned",
        itemId: m.conversationId,
        itemType: "conversation",
        message: `${sender?.name ?? "Someone"} mentioned you in ${conversation?.name ?? "a conversation"}: ${m.body.slice(0, 120)}`,
        data: { conversationId: m.conversationId, messageId: m.id, parentId: m.parentId ?? null },
        ageMinutes,
      });
    }
  }
  return drafts;
}

// The inbox people would have after a normal week. Created directly: going
// through notify() would also email and push to the seeded addresses.
export async function seedNotifications(ctx: SeedContext): Promise<void> {
  const drafts = [...taskDrafts(ctx), ...(await meetingDrafts()), ...(await announcementDrafts()), ...(await mentionDrafts())];
  for (const { ageMinutes, ...d } of drafts) {
    if (d.userId === d.fromUserId) continue;
    const jitter = d.kind === "mentioned" ? 0 : hash(`${d.userId}:${d.itemId}`) % 240;
    await Notification.findOrCreate({
      where: { userId: d.userId, kind: d.kind, itemId: d.itemId },
      defaults: { ...d, data: d.data ?? null, read: ageMinutes > 60 * 24 && hash(d.message) % 2 === 0, createdAt: minutesAgo(ageMinutes + jitter) },
    });
  }
}
