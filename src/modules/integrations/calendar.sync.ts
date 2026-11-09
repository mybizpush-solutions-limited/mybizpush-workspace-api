import { Op } from "sequelize";
import { audit } from "../../lib/audit";
import { AppError, notFound } from "../../lib/errors";
import { calendarOps } from "../../lib/google";
import { GoogleAccount, Meeting, MeetingAttendee, User } from "../../models";
import { can } from "../access/engine";
import { buildRRule, meetingsService } from "../meetings/meetings.service";
import { notify } from "../shared/events";
import { syncHint } from "../shared/live";
import { serializeMeeting } from "../shared/serializers";
import { compareEvent, type EventFacts } from "./integrations.pure";

// Keeping meetings and Google Calendar honest with each other (API-CHANGES A704).
// The organizer account owns every event. Changes made in Google are noticed here;
// nothing is overwritten until a person chooses which side to keep.

const COLLECTIONS = ["meetings", "meetingAttendees"];
type Req = Parameters<typeof audit>[0]["req"];
const withAttendees = { include: [{ model: User, as: "attendees", attributes: ["id"], through: { attributes: [] } }] };

const localFacts = (m: Meeting): EventFacts => ({ title: m.title, startsAt: m.startsAt.toISOString(), endsAt: m.endsAt.toISOString() });

async function attendeeIds(meetingId: string): Promise<string[]> {
  return (await MeetingAttendee.findAll({ where: { meetingId }, attributes: ["userId"] })).map((a) => a.userId);
}

async function hint(m: Meeting): Promise<void> {
  syncHint([...(await attendeeIds(m.id)), m.organizerId], COLLECTIONS);
}

async function inviteEmails(meeting: Meeting): Promise<string[]> {
  const ids = await attendeeIds(meeting.id);
  const users = await User.findAll({ where: { id: ids }, attributes: ["id", "email"], include: [{ model: GoogleAccount, as: "googleAccount", attributes: ["email"] }] });
  return [...users.map((u) => (u.get("googleAccount") as GoogleAccount | undefined)?.email || u.email), ...(meeting.externalEmails ?? [])];
}

// Writes our copy to Google, creating the event if it never got there.
async function pushLocal(m: Meeting): Promise<void> {
  const body = {
    summary: m.title,
    description: m.description ?? undefined,
    attendees: await inviteEmails(m),
    startIso: m.startsAt.toISOString(),
    endIso: m.endsAt.toISOString(),
    recurrence: buildRRule(m.recurrence),
    location: m.location ?? undefined,
  };
  const remote = m.googleEventId ? await calendarOps.get(m.googleEventId) : null;
  if (remote && !remote.cancelled) {
    await calendarOps.update(m.googleEventId!, body);
  } else {
    const created = await calendarOps.create({ ...body, conference: m.hasMeetLink, eventId: m.googleEventId ?? undefined });
    if (!created) throw new Error("Google didn't create the event");
    await m.update({ googleEventId: created.eventId, ...(m.hasMeetLink && created.meetUrl ? { meetUrl: created.meetUrl } : {}) });
  }
}

const markSynced = (m: Meeting, facts: EventFacts) => m.update({ syncState: "synced", syncConflict: null, googleSnapshot: facts });

export const calendarSync = {
  // Every 15 minutes in the worker.
  async sweep(): Promise<void> {
    if (!calendarOps.isConfigured()) return;
    const meetings = await Meeting.findAll({
      where: {
        status: "scheduled",
        googleEventId: { [Op.ne]: null },
        [Op.or]: [{ endsAt: { [Op.gte]: new Date(Date.now() - 86_400_000) } }, { recurrence: { [Op.ne]: null } }],
      },
    });
    for (const m of meetings) {
      // A conflict stays until someone decides. Failed writes are retried below.
      if (m.syncState === "conflict" && m.syncConflict?.reason === "changed_in_google") continue;
      try {
        await this.check(m);
      } catch (err) {
        console.error(`[calendar-sync] ${m.id} not checked:`, (err as Error).message);
      }
    }
  },

  async check(m: Meeting): Promise<void> {
    const remote = await calendarOps.get(m.googleEventId!);
    const local = localFacts(m);
    const verdict = compareEvent({ local, snapshot: m.googleSnapshot ?? null, remote });

    if (verdict === "cancelled") {
      // A write that never reached Google has nothing there to be cancelled.
      if (m.syncConflict?.reason === "write_failed") {
        await pushLocal(m);
        await markSynced(m, local);
        return;
      }
      await m.update({ status: "cancelled", cancelReason: "Cancelled in Google Calendar", cancelledAt: new Date(), syncState: "synced", syncConflict: null });
      for (const userId of await attendeeIds(m.id)) {
        await notify({ userId, fromUserId: null, kind: "meeting", itemId: m.id, itemType: "meeting", message: `Cancelled in Google Calendar: ${m.title}` });
      }
      await hint(m);
      return;
    }
    if (verdict === "in_sync") {
      if (m.syncState !== "synced" || !m.googleSnapshot) {
        await markSynced(m, local);
        await hint(m);
      }
      return;
    }
    if (verdict === "local_ahead") {
      // Our last write didn't arrive. Nobody changed anything in Google, so retry it.
      await pushLocal(m);
      await markSynced(m, local);
      await hint(m);
      return;
    }
    await m.update({
      syncState: "conflict",
      syncConflict: { reason: "changed_in_google", detectedAt: new Date().toISOString(), google: { title: remote!.title, startsAt: remote!.startsAt, endsAt: remote!.endsAt } },
    });
    if (m.organizerId) {
      await notify({ userId: m.organizerId, fromUserId: null, kind: "integration_failure", itemId: m.id, itemType: "meeting", message: `${m.title} was changed in Google Calendar. Choose which version to keep.` });
    }
    await hint(m);
  },

  async conflicts(userId: string) {
    const all = await can({ sub: userId }, "meeting.edit");
    const rows = await Meeting.findAll({ where: { syncState: "conflict", status: { [Op.ne]: "cancelled" }, ...(all ? {} : { organizerId: userId }) }, ...withAttendees, order: [["startsAt", "ASC"]] });
    return rows.map((m) => serializeMeeting(m));
  },

  async resolve(id: string, keep: "local" | "google", userId: string, req?: Req) {
    const m = await Meeting.findByPk(id);
    if (!m) throw notFound("Meeting not found");
    await meetingsService.assertCanManage(userId, m, "meeting.edit");
    if (m.syncState !== "conflict") throw new AppError(409, "This meeting has no conflict", "no_conflict");
    if (keep === "local") {
      await pushLocal(m).catch((err) => {
        throw new AppError(502, `Google didn't accept the change: ${(err as Error).message}`, "google_error");
      });
      await markSynced(m, localFacts(m));
    } else {
      const remote = await calendarOps.get(m.googleEventId!);
      if (!remote || remote.cancelled) throw new AppError(409, "This event is no longer in Google Calendar, so keep your version", "gone_from_google");
      const moved = new Date(remote.startsAt).getTime() !== m.startsAt.getTime() || new Date(remote.endsAt).getTime() !== m.endsAt.getTime();
      await m.update({ title: remote.title, startsAt: new Date(remote.startsAt), endsAt: new Date(remote.endsAt), syncState: "synced", syncConflict: null, googleSnapshot: { title: remote.title, startsAt: remote.startsAt, endsAt: remote.endsAt } });
      if (moved) {
        await MeetingAttendee.update({ rsvp: "pending", respondedAt: null }, { where: { meetingId: id, rsvp: ["accepted", "tentative"], ...(m.organizerId ? { userId: { [Op.ne]: m.organizerId } } : {}) } });
        for (const uid of await attendeeIds(id)) {
          if (uid !== m.organizerId) await notify({ userId: uid, fromUserId: userId, kind: "meeting", itemId: id, itemType: "meeting", message: `New time for ${m.title}` });
        }
      }
    }
    await audit({ req, actorId: userId, action: "meeting.sync.resolve", target: { type: "meeting", id }, after: { keep } });
    await hint(m);
    return meetingsService.get(id, userId);
  },
};
