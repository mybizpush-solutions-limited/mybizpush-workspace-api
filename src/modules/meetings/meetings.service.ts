import { Op } from "sequelize";
import {
  Department,
  GoogleAccount,
  Meeting,
  MeetingAttendee,
  Project,
  User,
  isOrgManager,
  type MeetingScope,
  type MeetingStatus,
  type MeetingType,
  type RecurrenceRule,
} from "../../models";
import { env } from "../../config/env";
import { audit } from "../../lib/audit";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors";
import { serializeMeeting, serializeMeetingAttendee } from "../shared/serializers";
import {
  createMeetEventAsOrganizer,
  updateMeetEventAsOrganizer,
  deleteMeetEventAsOrganizer,
} from "../../lib/google";
import { can } from "../access/engine";
import type { Scope } from "../access/catalog";
import { groupsService } from "../groups/groups.service";
import type { GroupRef } from "../groups/groups.merge";
import { notify } from "../shared/events";
import { refreshBadges, syncHint } from "../shared/live";
import { isInMeetingScope } from "./meeting.visibility";

const MEETING_COLLECTIONS = ["meetings", "meetingAttendees"];

const withAttendees = {
  include: [{ model: User, as: "attendees", attributes: ["id"], through: { attributes: [] } }],
};

// Resolve the invite addresses for a set of attendees — preferring the Gmail
// they linked via "Connect Google" (the identity they join Meet with), falling
// back to their company email.
async function resolveAttendeeEmails(attendeeIds: string[]): Promise<string[]> {
  const users = await User.findAll({
    where: { id: { [Op.in]: attendeeIds } },
    attributes: ["id", "email"],
    include: [{ model: GoogleAccount, as: "googleAccount", attributes: ["email"] }],
  });
  return users.map((u) => (u.get("googleAccount") as GoogleAccount | undefined)?.email || u.email);
}

// Validate, trim and de-duplicate third-party invitee emails.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function cleanEmails(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const email = raw.trim();
    if (!email || !EMAIL_RE.test(email)) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

// Translate a structured recurrence into an iCalendar RRULE line for Google.
export function buildRRule(r: RecurrenceRule | null | undefined): string | null {
  if (!r) return null;
  const FREQ = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY" } as const;
  const parts = [`FREQ=${FREQ[r.freq]}`, `INTERVAL=${Math.max(1, r.interval || 1)}`];
  if (r.count && r.count > 0) {
    parts.push(`COUNT=${r.count}`);
  } else if (r.until) {
    // RRULE UNTIL must be a UTC timestamp; end of the chosen day.
    const until = new Date(`${r.until}T23:59:59Z`);
    parts.push(`UNTIL=${until.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
  }
  return `RRULE:${parts.join(";")}`;
}

const scopeOf = (m: { scopeType?: MeetingScope | null; scopeId?: string | null }): Scope =>
  m.scopeType && m.scopeType !== "organization" ? { type: m.scopeType, id: m.scopeId ?? null } : { type: "organization", id: null };

// The organizer (scheduler), an executive, or whoever holds the permission on the
// meeting's scope may change it.
async function assertCanManage(userId: string, meeting: Meeting, permission: "meeting.edit" | "meeting.cancel"): Promise<void> {
  if (meeting.organizerId === userId) return;
  const user = await User.findByPk(userId, { attributes: ["accessLevel"] });
  if (user?.accessLevel === "executive_admin") return;
  if (meeting.scopeType && (await can({ sub: userId }, permission, scopeOf(meeting)))) return;
  throw forbidden("Only the organizer or an executive can change this meeting");
}

// Fallback Meet URL when no central organizer account is configured (dev only).
function mockMeetUrl(): string {
  const chunk = () => Math.random().toString(36).slice(2, 6);
  return `https://meet.google.com/${chunk()}-${chunk()}-${chunk()}`;
}

// Only executives, project managers, and HR department members may schedule.
async function canSchedule(userId: string): Promise<boolean> {
  const user = await User.findByPk(userId, {
    include: [{ model: Department, as: "departments", attributes: ["slug"], through: { attributes: [] } }],
  });
  if (!user) return false;
  if (isOrgManager(user.accessLevel)) return true;

  const hrSlug = env.HR_DEPARTMENT_SLUG.toLowerCase();
  const depts = (user.get("departments") as Department[] | undefined) ?? [];
  if (depts.some((d) => d.slug.toLowerCase() === hrSlug)) return true;

  // Project manager = manages at least one project.
  const managed = await Project.count({ where: { managerId: userId } });
  return managed > 0;
}

export interface MeetingFields {
  type?: MeetingType;
  scopeType?: MeetingScope | null;
  scopeId?: string | null;
  locationType?: "online" | "in_person" | "hybrid";
  location?: string | null;
  agenda?: { title: string; durationMinutes?: number; ownerId?: string }[];
  reminderMinutes?: number[];
  groups?: GroupRef[];
  excludeUserIds?: string[];
}

const fieldColumns = (f: MeetingFields) => ({
  ...(f.type !== undefined ? { type: f.type } : {}),
  ...(f.scopeType !== undefined ? { scopeType: f.scopeType } : {}),
  ...(f.scopeId !== undefined ? { scopeId: f.scopeId } : {}),
  ...(f.locationType !== undefined ? { locationType: f.locationType } : {}),
  ...(f.location !== undefined ? { location: f.location } : {}),
  ...(f.agenda !== undefined ? { agenda: f.agenda } : {}),
  ...(f.reminderMinutes !== undefined ? { reminderMinutes: [...new Set(f.reminderMinutes)] } : {}),
  ...(f.groups !== undefined ? { groups: f.groups } : {}),
});

async function reloadFull(id: string, withDetail = true) {
  const meeting = await Meeting.findByPk(id, withAttendees);
  if (!meeting) throw notFound("Meeting not found");
  const base = serializeMeeting(meeting);
  if (!withDetail) return base;
  const rows = await MeetingAttendee.findAll({ where: { meetingId: id } });
  return { ...base, attendees: rows.map(serializeMeetingAttendee) };
}

const meetingFormat = (m: Meeting) => `${m.title}, ${m.startsAt.toISOString()}`;

async function tellAttendees(meeting: Meeting, actorId: string | null, message: string, people?: string[]): Promise<void> {
  const ids = people ?? (await MeetingAttendee.findAll({ where: { meetingId: meeting.id }, attributes: ["userId"] })).map((a) => a.userId);
  for (const userId of ids) {
    await notify({ userId, fromUserId: actorId, kind: "meeting", itemId: meeting.id, itemType: "meeting", message });
  }
}

async function announce(meetingId: string, organizerId: string | null | undefined): Promise<void> {
  const people = (await MeetingAttendee.findAll({ where: { meetingId }, attributes: ["userId"] })).map((a) => a.userId);
  syncHint([...people, organizerId], MEETING_COLLECTIONS);
  refreshBadges([...people, organizerId]);
}

// Attendees = individuals + groups - removed + organizer.
async function resolvePeople(input: { attendeeIds?: string[]; groups?: GroupRef[]; excludeUserIds?: string[] }, organizerId: string | null | undefined): Promise<string[]> {
  const fromGroups = input.groups?.length ? await groupsService.expandIds(input.groups) : [];
  const excluded = new Set(input.excludeUserIds ?? []);
  const set = new Set([...(input.attendeeIds ?? []), ...fromGroups].filter((id) => !excluded.has(id)));
  if (organizerId) set.add(organizerId);
  const found = await User.count({ where: { id: [...set] } });
  if (found !== set.size) throw badRequest("One of the people picked no longer exists");
  return [...set];
}

export const meetingsService = {
  canSchedule,

  // Cancelled meetings used to be deleted, so older callers don't expect them here.
  async list(opts: { includeCancelled?: boolean } = {}) {
    const rows = await Meeting.findAll({
      ...withAttendees,
      where: opts.includeCancelled ? {} : { status: { [Op.ne]: "cancelled" } },
      order: [["startsAt", "ASC"]],
    });
    return rows.map((m) => serializeMeeting(m));
  },

  async get(id: string, userId: string) {
    const meeting = await Meeting.findByPk(id);
    if (!meeting) throw notFound("Meeting not found");
    await assertCanSee(meeting, userId);
    return reloadFull(id);
  },

  async create(input: {
    id?: string;
    title: string;
    description?: string;
    attendeeIds?: string[];
    externalEmails?: string[];
    organizerId: string;
    startsAt: string;
    endsAt: string;
    recurrence?: RecurrenceRule | null;
    meetLink?: boolean;
  } & MeetingFields) {
    if (input.scopeType && input.scopeType !== "organization" && !input.scopeId) throw badRequest(`Pick which ${input.scopeType} this meeting is for`);
    if (new Date(input.endsAt) <= new Date(input.startsAt)) throw badRequest("A meeting has to end after it starts");
    const allowed = (await canSchedule(input.organizerId)) || (await can({ sub: input.organizerId }, "meeting.create", scopeOf(input)));
    if (!allowed) {
      throw forbidden("Only executives, project managers, and HR can schedule meetings");
    }

    const attendeeIds = await resolvePeople(input, input.organizerId);
    const externalEmails = cleanEmails(input.externalEmails ?? []);
    const emails = [...(await resolveAttendeeEmails(attendeeIds)), ...externalEmails];
    const recurrence = input.recurrence ?? null;
    const meetLink = input.meetLink !== false;

    // The event is owned by the central organizer account; everyone (including
    // the scheduler) is invited by email. Falls back to a placeholder Meet link
    // only when no organizer account is configured (dev).
    const google = await createMeetEventAsOrganizer({
      summary: input.title.trim(),
      description: input.description?.trim(),
      attendees: emails,
      startIso: new Date(input.startsAt).toISOString(),
      endIso: new Date(input.endsAt).toISOString(),
      recurrence: buildRRule(recurrence),
      conference: meetLink,
      location: input.location ?? undefined,
    }).catch(() => null);

    const meeting = await Meeting.create({
      ...(input.id ? { id: input.id } : {}),
      title: input.title.trim(),
      description: input.description?.trim() ?? null,
      organizerId: input.organizerId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      meetUrl: meetLink ? (google?.meetUrl ?? mockMeetUrl()) : "",
      hasMeetLink: meetLink,
      googleEventId: google?.eventId ?? null,
      syncState: google?.eventId ? "synced" : "not_linked",
      recurrence,
      externalEmails,
      ...fieldColumns(input),
    });
    await (meeting as any).setAttendees(attendeeIds);
    // Scheduling it is saying yes to it.
    await MeetingAttendee.update({ rsvp: "accepted", respondedAt: new Date() }, { where: { meetingId: meeting.id, userId: input.organizerId } });

    await tellAttendees(meeting, input.organizerId, `Meeting invite: ${meetingFormat(meeting)}`, attendeeIds);
    await announce(meeting.id, input.organizerId);
    return reloadFull(meeting.id);
  },

  // Edit a meeting. The organizer always stays an attendee. Updates the Google
  // event too. A change of time needs people to confirm again.
  async update(
    actingUserId: string,
    meetingId: string,
    patch: {
      title?: string;
      description?: string;
      attendeeIds?: string[];
      externalEmails?: string[];
      startsAt?: string;
      endsAt?: string;
      recurrence?: RecurrenceRule | null;
    } & MeetingFields,
  ) {
    const meeting = await Meeting.findByPk(meetingId, withAttendees);
    if (!meeting) throw notFound("Meeting not found");
    await assertCanManage(actingUserId, meeting, "meeting.edit");
    if (meeting.status === "cancelled") throw new AppError(409, "This meeting was cancelled", "cancelled");

    const beforeStart = meeting.startsAt.getTime();
    const beforeEnd = meeting.endsAt.getTime();
    const beforeLocation = meeting.location;

    if (patch.title !== undefined) meeting.title = patch.title.trim();
    if (patch.description !== undefined) meeting.description = patch.description.trim() || null;
    if (patch.startsAt) meeting.startsAt = new Date(patch.startsAt);
    if (patch.endsAt) meeting.endsAt = new Date(patch.endsAt);
    if (patch.recurrence !== undefined) meeting.recurrence = patch.recurrence;
    if (patch.externalEmails !== undefined) meeting.externalEmails = cleanEmails(patch.externalEmails);
    if (meeting.endsAt <= meeting.startsAt) throw badRequest("A meeting has to end after it starts");
    meeting.set(fieldColumns(patch));

    const before = ((meeting.get("attendees") as User[] | undefined) ?? []).map((u) => u.id);
    let attendeeIds = before;
    if (patch.attendeeIds || patch.groups?.length) {
      // Without attendeeIds, picked groups add to who's already invited.
      attendeeIds = await resolvePeople({ attendeeIds: patch.attendeeIds ?? before, groups: patch.groups, excludeUserIds: patch.excludeUserIds }, meeting.organizerId);
      await (meeting as any).setAttendees(attendeeIds);
    } else if (patch.excludeUserIds?.length) {
      attendeeIds = await resolvePeople({ attendeeIds: before, excludeUserIds: patch.excludeUserIds }, meeting.organizerId);
      await (meeting as any).setAttendees(attendeeIds);
    }

    await meeting.save();

    const timeChanged = meeting.startsAt.getTime() !== beforeStart || meeting.endsAt.getTime() !== beforeEnd;
    if (timeChanged) {
      await MeetingAttendee.update(
        { rsvp: "pending", respondedAt: null },
        { where: { meetingId, rsvp: ["accepted", "tentative"], ...(meeting.organizerId ? { userId: { [Op.ne]: meeting.organizerId } } : {}) } },
      );
    }

    if (meeting.googleEventId) {
      const emails = [...(await resolveAttendeeEmails(attendeeIds)), ...(meeting.externalEmails ?? [])];
      await updateMeetEventAsOrganizer(meeting.googleEventId, {
        summary: meeting.title,
        description: meeting.description ?? undefined,
        attendees: emails,
        startIso: meeting.startsAt.toISOString(),
        endIso: meeting.endsAt.toISOString(),
        recurrence: buildRRule(meeting.recurrence),
        location: meeting.location ?? undefined,
      }).catch(() => undefined);
    }

    const added = attendeeIds.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !attendeeIds.includes(id));
    if (added.length) await tellAttendees(meeting, actingUserId, `Meeting invite: ${meetingFormat(meeting)}`, added);
    const stayed = attendeeIds.filter((id) => before.includes(id));
    if (timeChanged) await tellAttendees(meeting, actingUserId, `New time for ${meetingFormat(meeting)}`, stayed);
    else if (meeting.location !== beforeLocation) await tellAttendees(meeting, actingUserId, `New location for ${meeting.title}`, stayed);
    if (removed.length) {
      // Their devices drop the meeting on the next pull.
      const { SyncTombstone } = await import("../sync/tombstones");
      await SyncTombstone.bulkCreate(removed.map((userId) => ({ collection: "meetings", recordId: meetingId, userId, deletedAt: new Date() })));
      syncHint(removed, MEETING_COLLECTIONS);
      refreshBadges(removed);
    }
    await announce(meetingId, meeting.organizerId);
    return reloadFull(meetingId);
  },

  // Keeps the row: its notes and attendance are the record of what happened.
  async softCancel(actingUserId: string, meetingId: string, reason: string | undefined, req?: Parameters<typeof audit>[0]["req"]) {
    const meeting = await Meeting.findByPk(meetingId);
    if (!meeting) throw notFound("Meeting not found");
    await assertCanManage(actingUserId, meeting, "meeting.cancel");
    if (meeting.status === "cancelled") return reloadFull(meetingId);
    if (meeting.googleEventId) await deleteMeetEventAsOrganizer(meeting.googleEventId).catch(() => undefined);
    await meeting.update({ status: "cancelled", cancelReason: reason ?? null, cancelledAt: new Date() });
    await audit({ req, actorId: actingUserId, action: "meeting.cancel", target: { type: "meeting", id: meetingId }, scope: meeting.scopeType ? { type: meeting.scopeType, id: meeting.scopeId } : null, after: { reason: reason ?? null } });
    await tellAttendees(meeting, actingUserId, `Cancelled: ${meeting.title}${reason ? ` (${reason})` : ""}`);
    await announce(meetingId, meeting.organizerId);
    return reloadFull(meetingId);
  },

  async complete(actingUserId: string, meetingId: string) {
    const meeting = await Meeting.findByPk(meetingId);
    if (!meeting) throw notFound("Meeting not found");
    await assertCanManage(actingUserId, meeting, "meeting.edit");
    if (meeting.status === "cancelled") throw new AppError(409, "This meeting was cancelled", "cancelled");
    await meeting.update({ status: "completed" as MeetingStatus });
    await announce(meetingId, meeting.organizerId);
    return reloadFull(meetingId);
  },

  // Cancel a meeting: delete the Google event (notifying attendees) and the row.
  async cancel(actingUserId: string, meetingId: string): Promise<void> {
    const meeting = await Meeting.findByPk(meetingId);
    if (!meeting) throw notFound("Meeting not found");
    await assertCanManage(actingUserId, meeting, "meeting.cancel");

    if (meeting.googleEventId) {
      await deleteMeetEventAsOrganizer(meeting.googleEventId).catch(() => undefined);
    }
    await (meeting as any).setAttendees([]);
    await meeting.destroy();
  },

  async rsvp(meetingId: string, userId: string, response: "accepted" | "tentative" | "declined", note?: string) {
    const meeting = await Meeting.findByPk(meetingId);
    if (!meeting) throw notFound("Meeting not found");
    if (meeting.status === "cancelled") throw new AppError(409, "This meeting was cancelled", "cancelled");
    const row = await MeetingAttendee.findOne({ where: { meetingId, userId } });
    if (!row) throw forbidden("You're not invited to this meeting");
    await row.update({ rsvp: response, rsvpNote: note ?? null, respondedAt: new Date() });
    if (response !== "accepted" && meeting.organizerId) {
      const me = await User.findByPk(userId, { attributes: ["name"] });
      await notify({
        userId: meeting.organizerId,
        fromUserId: userId,
        kind: "meeting",
        itemId: meetingId,
        itemType: "meeting",
        message: `${me?.name ?? "Someone"} ${response === "declined" ? "can't make" : "might make"} ${meeting.title}${note ? `: ${note}` : ""}`,
      });
    }
    await announce(meetingId, meeting.organizerId);
    return serializeMeetingAttendee(row);
  },

  async markAttendance(meetingId: string, actorId: string, entries: { userId: string; status: "unknown" | "present" | "late" | "absent" }[]) {
    const meeting = await Meeting.findByPk(meetingId);
    if (!meeting) throw notFound("Meeting not found");
    await assertCanManage(actorId, meeting, "meeting.edit");
    for (const e of entries) {
      await MeetingAttendee.update({ attendance: e.status, attendanceMarkedBy: actorId }, { where: { meetingId, userId: e.userId } });
    }
    await announce(meetingId, meeting.organizerId);
    return (await MeetingAttendee.findAll({ where: { meetingId } })).map(serializeMeetingAttendee);
  },
};

export async function assertCanSee(meeting: Meeting, userId: string): Promise<void> {
  if (meeting.organizerId === userId) return;
  if (await MeetingAttendee.count({ where: { meetingId: meeting.id, userId } })) return;
  if (await isInMeetingScope(meeting, userId)) return;
  if (await can({ sub: userId }, "meeting.view", { type: "organization", id: null })) {
    // Everyone holds meeting.view by default, so at organization level this only
    // opens meetings that aren't private to their invitees.
    if (meeting.scopeType === "organization") return;
    const user = await User.findByPk(userId, { attributes: ["accessLevel"] });
    if (user && isOrgManager(user.accessLevel)) return;
  }
  throw forbidden("You can't see this meeting");
}
