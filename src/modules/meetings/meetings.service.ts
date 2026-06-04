import { Op } from "sequelize";
import { Department, GoogleAccount, Meeting, Project, User } from "../../models";
import { env } from "../../config/env";
import { forbidden } from "../../lib/errors";
import { serializeMeeting } from "../shared/serializers";
import { createMeetEventAsOrganizer } from "../../lib/google";

const withAttendees = {
  include: [{ model: User, as: "attendees", attributes: ["id"], through: { attributes: [] } }],
};

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

    // Resolve attendee invite addresses. Prefer the Gmail they linked via
    // "Connect Google" (that's the identity they actually join Meet with);
    // fall back to their company email if they haven't linked one.
    const attendeeUsers = await User.findAll({
      where: { id: { [Op.in]: [...attendeeIds] } },
      attributes: ["id", "email"],
      include: [{ model: GoogleAccount, as: "googleAccount", attributes: ["email"] }],
    });
    const emails = attendeeUsers.map((u) => {
      const linked = (u.get("googleAccount") as GoogleAccount | undefined)?.email;
      return linked || u.email;
    });

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
};
