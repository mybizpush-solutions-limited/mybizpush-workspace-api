import { Op } from "sequelize";
import { Meeting, MeetingAttendee } from "../../models";
import { redis } from "../../redis/client";
import { occurrencesBetween } from "../../modules/meetings/occurrences";
import { notify } from "../../modules/shared/events";
import { registerJob, registerSchedule } from "../workers";

// Meeting reminders (A401). Every minute, finds reminders that have just come due.
// A slightly wide look-back means a late run still sends them; the Redis key means
// a person is only ever reminded once per meeting date and reminder time.

const LOOK_BACK_MS = 5 * 60 * 1000;
const MAX_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;
const KEY_TTL_SECONDS = 8 * 24 * 60 * 60;

function when(minutes: number): string {
  if (minutes === 0) return "now";
  if (minutes < 60) return `in ${minutes} minutes`;
  if (minutes < 1440) return `in ${Math.round(minutes / 60)} hours`;
  return `in ${Math.round(minutes / 1440)} days`;
}

registerJob("reminders", "meeting-reminders", async () => {
  const now = new Date();
  const horizon = new Date(now.getTime() + MAX_REMINDER_MS);
  const meetings = await Meeting.findAll({
    where: {
      status: "scheduled",
      startsAt: { [Op.lt]: horizon },
      [Op.or]: [{ recurrence: { [Op.ne]: null } }, { startsAt: { [Op.gte]: now } }],
    },
  });
  for (const m of meetings) {
    const minutes = m.reminderMinutes ?? [];
    if (!minutes.length) continue;
    for (const o of occurrencesBetween(m.startsAt, m.endsAt, m.recurrence, now, horizon)) {
      if (o.start < now) continue; // already started
      for (const r of minutes) {
        const dueAt = o.start.getTime() - r * 60_000;
        if (dueAt > now.getTime() || dueAt < now.getTime() - LOOK_BACK_MS) continue;
        const fresh = await redis.set(`meeting:reminder:${m.id}:${o.start.getTime()}:${r}`, "1", "EX", KEY_TTL_SECONDS, "NX");
        if (fresh !== "OK") continue;
        const people = await MeetingAttendee.findAll({ where: { meetingId: m.id, rsvp: { [Op.ne]: "declined" } }, attributes: ["userId"] });
        for (const { userId } of people) {
          await notify({ userId, fromUserId: null, kind: "meeting", itemId: m.id, itemType: "meeting", message: `${m.title} starts ${when(r)}` });
        }
      }
    }
  }
});

registerSchedule("reminders", "meeting-reminders", "* * * * *");
