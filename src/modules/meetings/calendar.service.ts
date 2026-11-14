import { Op, type WhereOptions } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors";
import {
  CalendarEvent,
  Meeting,
  MeetingActionItem,
  MeetingAttendee,
  MeetingNote,
  type MeetingScope,
} from "../../models";
import { can } from "../access/engine";
import type { Scope } from "../access/catalog";
import { notify } from "../shared/events";
import { syncHint } from "../shared/live";
import { tasksService, type WorkItemCreateInput } from "../workitems/workitems.service";
import { assertCanSee } from "./meetings.service";
import { assertCanSeeCalendarEvent } from "../access/visibility";
import { inMyScopesSql, isInMeetingScope, visibleMeetingsSql } from "./meeting.visibility";
import { occurrencesBetween } from "./occurrences";

// The Calendar tab, non-meeting events, and what follows a meeting (A402, A404).

export function serializeNote(n: MeetingNote) {
  return { id: n.id, meetingId: n.meetingId, kind: n.kind, body: n.body, createdBy: n.createdBy ?? null, createdAt: n.createdAt.toISOString(), updatedAt: n.updatedAt.toISOString() };
}
export function serializeActionItem(a: MeetingActionItem) {
  return {
    id: a.id,
    meetingId: a.meetingId,
    title: a.title,
    description: a.description,
    ownerId: a.ownerId ?? null,
    dueDate: a.dueDate?.toISOString() ?? null,
    status: a.status,
    taskId: a.taskId ?? null,
    createdBy: a.createdBy ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}
export function serializeEvent(e: CalendarEvent) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    scopeType: e.scopeType,
    scopeId: e.scopeId ?? null,
    allDay: e.allDay,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    location: e.location ?? null,
    createdBy: e.createdBy ?? null,
    cancelledAt: e.cancelledAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

const MAX_RANGE_DAYS = 366;
const scopeOf = (type: MeetingScope, id?: string | null): Scope => (type === "organization" ? { type: "organization", id: null } : { type, id: id ?? null });

async function hintMeeting(meetingId: string, collections: string[]): Promise<void> {
  const people = await MeetingAttendee.findAll({ where: { meetingId }, attributes: ["userId"] });
  syncHint(people.map((p) => p.userId), collections);
}

async function loadMeeting(id: string): Promise<Meeting> {
  const m = await Meeting.findByPk(id);
  if (!m) throw notFound("Meeting not found");
  return m;
}

// Attendees and the organizer write the record of a meeting.
async function assertParticipant(m: Meeting, userId: string): Promise<void> {
  if (m.organizerId === userId) return;
  if (await MeetingAttendee.count({ where: { meetingId: m.id, userId } })) return;
  throw forbidden("Only people in this meeting can do that");
}

export interface CalendarQuery {
  from: string;
  to: string;
  view?: "mine" | "all";
  scopeType?: MeetingScope;
  scopeId?: string;
  includeCancelled?: boolean;
}

export const calendarService = {
  async items(userId: string, q: CalendarQuery) {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (to <= from) throw badRequest("The end of the range must be after the start");
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw badRequest(`The range can't be longer than ${MAX_RANGE_DAYS} days`);

    const named = q.scopeType ? scopeOf(q.scopeType, q.scopeId) : null;
    if (q.scopeType && q.scopeType !== "organization" && !q.scopeId) throw badRequest("Pick which one");
    let namedAllowed = false;
    if (named && q.scopeType) {
      namedAllowed = q.scopeType === "organization" || (await isInMeetingScope({ scopeType: q.scopeType, scopeId: q.scopeId ?? null }, userId));
      if (!namedAllowed && !(await can({ sub: userId }, "meeting.view", named))) throw forbidden("You can't see that calendar");
      // Holding it org-wide is the default for everyone, so it doesn't open another
      // group's calendar on its own; those people see what's shared with them.
      namedAllowed = namedAllowed || (await can({ sub: userId }, "report.view", named));
    }

    const u = sequelize.escape(userId);
    const conditions: string[] = [];
    if (named && namedAllowed) {
      conditions.push(`("Meeting".scope_type = ${sequelize.escape(q.scopeType!)}${q.scopeId ? ` AND "Meeting".scope_id = ${sequelize.escape(q.scopeId)}` : ""})`);
    } else if (named) {
      conditions.push(`("Meeting".scope_type = ${sequelize.escape(q.scopeType!)}${q.scopeId ? ` AND "Meeting".scope_id = ${sequelize.escape(q.scopeId)}` : ""} AND ${visibleMeetingsSql(userId)})`);
    } else if (q.view === "all") {
      conditions.push(visibleMeetingsSql(userId));
    } else {
      conditions.push(`("Meeting".organizer_id = ${u} OR "Meeting".id IN (SELECT meeting_id FROM meeting_attendees WHERE user_id = ${u}))`);
    }

    const meetings = await Meeting.findAll({
      where: {
        [Op.and]: [
          sequelize.literal(conditions.join(" OR ")),
          q.includeCancelled ? {} : { status: { [Op.ne]: "cancelled" } },
          // A recurring series started earlier can still have dates in range.
          { [Op.or]: [{ recurrence: { [Op.ne]: null } }, { startsAt: { [Op.lt]: to }, endsAt: { [Op.gt]: from } }] },
          { startsAt: { [Op.lt]: to } },
        ],
      } as WhereOptions,
    });
    const myRows = meetings.length ? await MeetingAttendee.findAll({ where: { userId, meetingId: meetings.map((m) => m.id) } }) : [];
    const myRsvp = new Map(myRows.map((r) => [r.meetingId, r.rsvp]));

    const items: { sortKey: number; [k: string]: unknown }[] = [];
    for (const m of meetings) {
      for (const o of occurrencesBetween(m.startsAt, m.endsAt, m.recurrence, from, to)) {
        items.push({
          sortKey: o.start.getTime(),
          kind: "meeting",
          id: m.id,
          occurrenceStart: o.start.toISOString(),
          occurrenceEnd: o.end.toISOString(),
          isRecurring: !!m.recurrence,
          title: m.title,
          allDay: false,
          type: m.type,
          scopeType: m.scopeType ?? null,
          scopeId: m.scopeId ?? null,
          status: m.status,
          location: m.location ?? null,
          meetUrl: m.meetUrl || null,
          myRsvp: myRsvp.get(m.id) ?? null,
        });
      }
    }

    const eventScope = named && namedAllowed
      ? { scopeType: q.scopeType, ...(q.scopeId ? { scopeId: q.scopeId } : {}) }
      : sequelize.literal(inMyScopesSql(userId, '"CalendarEvent"'));
    const events = await CalendarEvent.findAll({
      where: {
        [Op.and]: [eventScope, q.includeCancelled ? {} : { cancelledAt: null }, { startsAt: { [Op.lt]: to } }, { endsAt: { [Op.gt]: from } }],
      } as WhereOptions,
    });
    for (const e of events) {
      items.push({
        sortKey: e.startsAt.getTime(),
        kind: "event",
        id: e.id,
        occurrenceStart: e.startsAt.toISOString(),
        occurrenceEnd: e.endsAt.toISOString(),
        isRecurring: false,
        title: e.title,
        allDay: e.allDay,
        type: null,
        scopeType: e.scopeType,
        scopeId: e.scopeId ?? null,
        status: e.cancelledAt ? "cancelled" : "scheduled",
        location: e.location ?? null,
        meetUrl: null,
        myRsvp: null,
      });
    }
    items.sort((a, b) => a.sortKey - b.sortKey);
    return items.map(({ sortKey: _sortKey, ...rest }) => rest);
  },

  // ---- Notes ----------------------------------------------------------------
  async notes(meetingId: string, userId: string) {
    const m = await loadMeeting(meetingId);
    await assertCanSee(m, userId);
    const [notes, actionItems] = await Promise.all([
      MeetingNote.findAll({ where: { meetingId }, order: [["createdAt", "ASC"]] }),
      MeetingActionItem.findAll({ where: { meetingId }, order: [["createdAt", "ASC"]] }),
    ]);
    return { notes: notes.map(serializeNote), actionItems: actionItems.map(serializeActionItem) };
  },

  async addNote(meetingId: string, input: { id?: string; kind?: "note" | "decision"; body: string }, userId: string) {
    const m = await loadMeeting(meetingId);
    await assertParticipant(m, userId);
    if (input.id) {
      const existing = await MeetingNote.findByPk(input.id);
      if (existing) return serializeNote(existing);
    }
    const note = await MeetingNote.create({ ...(input.id ? { id: input.id } : {}), meetingId, kind: input.kind ?? "note", body: input.body, createdBy: userId });
    await hintMeeting(meetingId, ["meetingNotes"]);
    return serializeNote(note);
  },

  async updateNote(meetingId: string, noteId: string, body: string, userId: string) {
    const m = await loadMeeting(meetingId);
    const note = await MeetingNote.findOne({ where: { id: noteId, meetingId } });
    if (!note) throw notFound("Note not found");
    if (note.createdBy !== userId && m.organizerId !== userId) throw forbidden("You can't edit this note");
    await note.update({ body });
    await hintMeeting(meetingId, ["meetingNotes"]);
    return serializeNote(note);
  },

  async removeNote(meetingId: string, noteId: string, userId: string): Promise<void> {
    const m = await loadMeeting(meetingId);
    const note = await MeetingNote.findOne({ where: { id: noteId, meetingId } });
    if (!note) throw notFound("Note not found");
    if (note.createdBy !== userId && m.organizerId !== userId) throw forbidden("You can't remove this note");
    await note.destroy();
    await hintMeeting(meetingId, ["meetingNotes"]);
  },

  // ---- Action items ---------------------------------------------------------
  async addActionItem(meetingId: string, input: { id?: string; title: string; description?: string; ownerId?: string | null; dueDate?: string | null }, userId: string) {
    const m = await loadMeeting(meetingId);
    await assertParticipant(m, userId);
    if (input.id) {
      const existing = await MeetingActionItem.findByPk(input.id);
      if (existing) return serializeActionItem(existing);
    }
    const item = await MeetingActionItem.create({
      ...(input.id ? { id: input.id } : {}),
      meetingId,
      title: input.title,
      description: input.description ?? "",
      ownerId: input.ownerId ?? null,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      createdBy: userId,
    });
    if (item.ownerId) await notify({ userId: item.ownerId, fromUserId: userId, kind: "meeting", itemId: meetingId, itemType: "meeting", message: `Action item from ${m.title}: ${item.title}` });
    await hintMeeting(meetingId, ["meetingActionItems"]);
    return serializeActionItem(item);
  },

  async updateActionItem(meetingId: string, itemId: string, patch: { title?: string; description?: string; ownerId?: string | null; dueDate?: string | null; status?: "open" | "done" }, userId: string) {
    const m = await loadMeeting(meetingId);
    await assertParticipant(m, userId);
    const item = await MeetingActionItem.findOne({ where: { id: itemId, meetingId } });
    if (!item) throw notFound("Action item not found");
    if (item.status === "converted" && patch.status) throw new AppError(409, "This item is tracked by its task now", "already_converted");
    const newOwner = patch.ownerId !== undefined && patch.ownerId !== item.ownerId ? patch.ownerId : null;
    await item.update({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.ownerId !== undefined ? { ownerId: patch.ownerId } : {}),
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate ? new Date(patch.dueDate) : null } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
    if (newOwner) await notify({ userId: newOwner, fromUserId: userId, kind: "meeting", itemId: meetingId, itemType: "meeting", message: `Action item from ${m.title}: ${item.title}` });
    await hintMeeting(meetingId, ["meetingActionItems"]);
    return serializeActionItem(item);
  },

  async removeActionItem(meetingId: string, itemId: string, userId: string): Promise<void> {
    const m = await loadMeeting(meetingId);
    const item = await MeetingActionItem.findOne({ where: { id: itemId, meetingId } });
    if (!item) throw notFound("Action item not found");
    if (item.createdBy !== userId && m.organizerId !== userId) throw forbidden("You can't remove this item");
    await item.destroy();
    await hintMeeting(meetingId, ["meetingActionItems"]);
  },

  // Follow-up work is tracked as a task. Permissions are the task's own.
  async convert(meetingId: string, itemId: string, input: Partial<WorkItemCreateInput> & { projectId: string }, userId: string, strict: boolean) {
    const m = await loadMeeting(meetingId);
    await assertParticipant(m, userId);
    const item = await MeetingActionItem.findOne({ where: { id: itemId, meetingId } });
    if (!item) throw notFound("Action item not found");
    if (item.status === "converted" || item.taskId) throw new AppError(409, "This item is already a task", "already_converted");
    const task = await tasksService.create(
      {
        ...input,
        title: input.title ?? item.title,
        description: input.description ?? item.description,
        assigneeIds: input.assigneeIds ?? (item.ownerId ? [item.ownerId] : []),
        dueDate: input.dueDate ?? item.dueDate?.toISOString(),
        sourceType: "meeting_action",
        sourceId: item.id,
      },
      userId,
      { strict },
    );
    await item.update({ status: "converted", taskId: task.id });
    await hintMeeting(meetingId, ["meetingActionItems"]);
    return { actionItem: serializeActionItem(item), item: task };
  },

  // ---- Events ---------------------------------------------------------------
  async createEvent(input: { id?: string; title: string; description?: string; scopeType: MeetingScope; scopeId?: string | null; allDay?: boolean; startsAt: string; endsAt: string; location?: string | null }, userId: string) {
    if (input.scopeType !== "organization" && !input.scopeId) throw badRequest(`Pick which ${input.scopeType} this is for`);
    if (new Date(input.endsAt) < new Date(input.startsAt)) throw badRequest("An event can't end before it starts");
    if (!(await can({ sub: userId }, "event.create", scopeOf(input.scopeType, input.scopeId)))) throw forbidden("You can't add events here");
    const e = await CalendarEvent.create({
      ...(input.id ? { id: input.id } : {}),
      title: input.title,
      description: input.description ?? "",
      scopeType: input.scopeType,
      scopeId: input.scopeType === "organization" ? null : (input.scopeId ?? null),
      allDay: input.allDay ?? false,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      location: input.location ?? null,
      createdBy: userId,
    });
    return serializeEvent(e);
  },

  async getEvent(id: string, userId: string) {
    await assertCanSeeCalendarEvent(userId, id);
    const e = await CalendarEvent.findByPk(id);
    if (!e) throw notFound("Event not found");
    return serializeEvent(e);
  },

  async updateEvent(id: string, patch: Partial<{ title: string; description: string; scopeType: MeetingScope; scopeId: string | null; allDay: boolean; startsAt: string; endsAt: string; location: string | null }>, userId: string) {
    const e = await CalendarEvent.findByPk(id);
    if (!e) throw notFound("Event not found");
    if (e.createdBy !== userId && !(await can({ sub: userId }, "event.edit", scopeOf(e.scopeType, e.scopeId)))) throw forbidden("You can't edit this event");
    const scopeType = patch.scopeType ?? e.scopeType;
    const scopeId = patch.scopeId !== undefined ? patch.scopeId : e.scopeId;
    if (patch.scopeType || patch.scopeId !== undefined) {
      if (scopeType !== "organization" && !scopeId) throw badRequest(`Pick which ${scopeType} this is for`);
      if (!(await can({ sub: userId }, "event.create", scopeOf(scopeType, scopeId)))) throw forbidden("You can't move this event there");
    }
    const startsAt = patch.startsAt ? new Date(patch.startsAt) : e.startsAt;
    const endsAt = patch.endsAt ? new Date(patch.endsAt) : e.endsAt;
    if (endsAt < startsAt) throw badRequest("An event can't end before it starts");
    await e.update({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      scopeType,
      scopeId: scopeType === "organization" ? null : scopeId,
      ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
      startsAt,
      endsAt,
      ...(patch.location !== undefined ? { location: patch.location } : {}),
    });
    return serializeEvent(e);
  },

  async removeEvent(id: string, userId: string): Promise<void> {
    const e = await CalendarEvent.findByPk(id);
    if (!e) throw notFound("Event not found");
    if (e.createdBy !== userId && !(await can({ sub: userId }, "event.delete", scopeOf(e.scopeType, e.scopeId)))) throw forbidden("You can't remove this event");
    await e.destroy();
  },
};
