import { Op } from "sequelize";
import { Meeting, User } from "../../models";
import { serializeMeeting } from "../shared/serializers";
import { createMeetEvent } from "../../lib/google";

const withAttendees = {
  include: [{ model: User, as: "attendees", attributes: ["id"], through: { attributes: [] } }],
};

// Fallback Meet URL when the organizer hasn't connected Google Calendar.
function mockMeetUrl(): string {
  const chunk = () => Math.random().toString(36).slice(2, 6);
  return `https://meet.google.com/${chunk()}-${chunk()}-${chunk()}`;
}

export const meetingsService = {
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
    const attendeeIds = new Set(input.attendeeIds ?? []);
    attendeeIds.add(input.organizerId);

    // Resolve attendee emails for the calendar invite.
    const attendeeUsers = await User.findAll({
      where: { id: { [Op.in]: [...attendeeIds] } },
      attributes: ["id", "email"],
    });
    const emails = attendeeUsers.map((u) => u.email);

    // Create a real Google Calendar event + Meet link if the organizer is
    // connected; otherwise fall back to a placeholder URL.
    const google = await createMeetEvent(input.organizerId, {
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
