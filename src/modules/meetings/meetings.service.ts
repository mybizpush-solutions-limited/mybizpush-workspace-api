import { Op } from "sequelize";
import { Department, GoogleAccount, Meeting, Project, User } from "../../models";
import { env } from "../../config/env";
import { forbidden, notFound } from "../../lib/errors";
import { serializeMeeting } from "../shared/serializers";
import {
  createMeetEventAsOrganizer,
  updateMeetEventAsOrganizer,
  deleteMeetEventAsOrganizer,
} from "../../lib/google";

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

// The organizer (scheduler) or any executive may edit/cancel a meeting.
async function assertCanManage(userId: string, meeting: Meeting): Promise<void> {
  if (meeting.organizerId === userId) return;
  const user = await User.findByPk(userId, { attributes: ["accessLevel"] });
  if (user?.accessLevel === "executive_admin") return;
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
  if (user.accessLevel === "executive_admin") return true;

  const hrSlug = env.HR_DEPARTMENT_SLUG.toLowerCase();
  const depts = (user.get("departments") as Department[] | undefined) ?? [];
  if (depts.some((d) => d.slug.toLowerCase() === hrSlug)) return true;

  // Project manager = manages at least one project.
  const managed = await Project.count({ where: { managerId: userId } });
  return managed > 0;
}

export const meetingsService = {
  canSchedule,

  async list() {
    const rows = await Meeting.findAll({ ...withAttendees, order: [["startsAt", "ASC"]] });
    return rows.map(serializeMeeting);
  },

  async create(input: {
    title: string;
    description?: string;
    attendeeIds?: string[];
    organizerId: string;
    startsAt: string;
    endsAt: string;
  }) {
    if (!(await canSchedule(input.organizerId))) {
      throw forbidden("Only executives, project managers, and HR can schedule meetings");
    }

    const attendeeIds = new Set(input.attendeeIds ?? []);
    attendeeIds.add(input.organizerId);
    const emails = await resolveAttendeeEmails([...attendeeIds]);

    // The event is owned by the central organizer account; everyone (including
    // the scheduler) is invited by email. Falls back to a placeholder Meet link
    // only when no organizer account is configured (dev).
    const google = await createMeetEventAsOrganizer({
      summary: input.title.trim(),
      description: input.description?.trim(),
      attendees: emails,
      startIso: new Date(input.startsAt).toISOString(),
      endIso: new Date(input.endsAt).toISOString(),
    }).catch(() => null);

    const meeting = await Meeting.create({
      title: input.title.trim(),
      description: input.description?.trim() ?? null,
      organizerId: input.organizerId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      meetUrl: google?.meetUrl ?? mockMeetUrl(),
      googleEventId: google?.eventId ?? null,
    });
    await (meeting as any).setAttendees([...attendeeIds]);

    const reloaded = await Meeting.findByPk(meeting.id, withAttendees);
    return serializeMeeting(reloaded!);
  },

  // Edit a meeting (title/description/time/attendees). Organizer or exec only.
  // The organizer always stays an attendee. Updates the Google event too.
  async update(
    actingUserId: string,
    meetingId: string,
    patch: { title?: string; description?: string; attendeeIds?: string[]; startsAt?: string; endsAt?: string },
  ) {
    const meeting = await Meeting.findByPk(meetingId, withAttendees);
    if (!meeting) throw notFound("Meeting not found");
    await assertCanManage(actingUserId, meeting);

    if (patch.title !== undefined) meeting.title = patch.title.trim();
    if (patch.description !== undefined) meeting.description = patch.description.trim() || null;
    if (patch.startsAt) meeting.startsAt = new Date(patch.startsAt);
    if (patch.endsAt) meeting.endsAt = new Date(patch.endsAt);

    let attendeeIds: string[] | undefined;
    if (patch.attendeeIds) {
      const set = new Set(patch.attendeeIds);
      set.add(meeting.organizerId!); // organizer stays on the invite
      attendeeIds = [...set];
      await (meeting as any).setAttendees(attendeeIds);
    } else {
      attendeeIds = ((meeting.get("attendees") as User[] | undefined) ?? []).map((u) => u.id);
    }

    await meeting.save();

    if (meeting.googleEventId) {
      const emails = await resolveAttendeeEmails(attendeeIds);
      await updateMeetEventAsOrganizer(meeting.googleEventId, {
        summary: meeting.title,
        description: meeting.description ?? undefined,
        attendees: emails,
        startIso: meeting.startsAt.toISOString(),
        endIso: meeting.endsAt.toISOString(),
      }).catch(() => undefined);
    }

    const reloaded = await Meeting.findByPk(meeting.id, withAttendees);
    return serializeMeeting(reloaded!);
  },

  // Cancel a meeting: delete the Google event (notifying attendees) and the row.
  async cancel(actingUserId: string, meetingId: string): Promise<void> {
    const meeting = await Meeting.findByPk(meetingId);
    if (!meeting) throw notFound("Meeting not found");
    await assertCanManage(actingUserId, meeting);

    if (meeting.googleEventId) {
      await deleteMeetEventAsOrganizer(meeting.googleEventId).catch(() => undefined);
    }
    await (meeting as any).setAttendees([]);
    await meeting.destroy();
  },
};
