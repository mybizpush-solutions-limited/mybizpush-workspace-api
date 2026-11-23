import { CalendarEvent, Meeting, MeetingAttendee, MeetingNote, type AttendanceStatus, type MeetingScope, type MeetingType, type RsvpResponse } from "../../models";
import { groupsService } from "../../modules/groups/groups.service";
import type { SeedContext } from "./context";
import { addMinutes, hash, now, pick, weekSlot } from "./time";

type GroupKind = "department" | "team" | "product" | "project";

interface MeetingSpec {
  title: string;
  description: string;
  week: 0 | 1;
  day: number;
  time: string;
  minutes: number;
  type: MeetingType;
  organizer: string;
  scope?: { type: GroupKind; ref: string } | { type: "organization" };
  people?: string[];
  locationType?: "online" | "in_person" | "hybrid";
  location?: string;
  agenda?: string[];
  note?: string;
}

const MEETINGS: MeetingSpec[] = [
  { title: "Engineering standup", description: "Yesterday, today, blockers.", week: 0, day: 0, time: "09:30", minutes: 15, type: "standup", organizer: "sam", scope: { type: "department", ref: "dev" }, note: "Android 10 crash is the top priority for mobile." },
  { title: "Workspace mobile sprint review", description: "Demo of build 1.2.0 and QA status.", week: 0, day: 1, time: "11:00", minutes: 45, type: "review", organizer: "femi", scope: { type: "project", ref: "Workspace Mobile App" }, agenda: ["Demo: chat threads", "Demo: QR check-in", "QA status", "Release scope for 1.2"] },
  { title: "Hyparrow beta go or no go", description: "Decide on the public beta date.", week: 0, day: 2, time: "14:00", minutes: 60, type: "planning", organizer: "ngozi", scope: { type: "product", ref: "hyparrow" }, agenda: ["Custom domains", "Status page", "Invite batches", "Decision"] },
  { title: "Marketing content planning", description: "Content calendar for December.", week: 0, day: 3, time: "12:00", minutes: 45, type: "planning", organizer: "chiamaka", scope: { type: "department", ref: "marketing" }, locationType: "in_person", location: "Lagos HQ, Ocean room" },
  { title: "Ada and Sam 1:1", description: "Weekly one on one.", week: 0, day: 3, time: "10:00", minutes: 30, type: "one_on_one", organizer: "ada", people: ["sam"] },
  { title: "Q4 all hands", description: "Quarter review, wins and plans for Q1.", week: 0, day: 4, time: "15:00", minutes: 90, type: "all_hands", organizer: "ada", scope: { type: "organization" }, locationType: "hybrid", location: "Lagos HQ, main hall", agenda: ["Q4 numbers", "Product updates", "People updates", "Questions"] },
  { title: "BizPush Pay gateway partner call", description: "Sandbox access, settlement timelines and pricing.", week: 1, day: 0, time: "11:00", minutes: 45, type: "client", organizer: "esther", people: ["daniel", "yusuf", "grace"] },
  { title: "Engineering standup", description: "Yesterday, today, blockers.", week: 1, day: 0, time: "09:30", minutes: 15, type: "standup", organizer: "sam", scope: { type: "department", ref: "dev" } },
  { title: "Workspace mobile sprint planning", description: "Plan the 1.3 sprint.", week: 1, day: 1, time: "10:00", minutes: 60, type: "planning", organizer: "femi", scope: { type: "team", ref: "mobile-squad" }, people: ["esther"] },
  { title: "BizPush Pay leadership demo", description: "Invoice editor and payment link walkthrough.", week: 1, day: 1, time: "14:00", minutes: 45, type: "review", organizer: "esther", people: ["ada", "sam", "tunde", "daniel", "zainab"] },
  { title: "New leave policy training", description: "What changed and how to request leave in Workspace.", week: 1, day: 2, time: "14:00", minutes: 45, type: "training", organizer: "funke", scope: { type: "organization" }, locationType: "hybrid", location: "Lagos HQ, Ocean room" },
  { title: "Brand refresh design critique", description: "Final review of guidelines and icon set.", week: 1, day: 3, time: "13:00", minutes: 60, type: "review", organizer: "kola", scope: { type: "project", ref: "Brand Refresh" } },
  { title: "Chiamaka and Seyi 1:1", description: "Monthly check in.", week: 1, day: 4, time: "11:00", minutes: 30, type: "one_on_one", organizer: "chiamaka", people: ["seyi"] },
  { title: "Abuja sales pipeline review", description: "Merchant pipeline and December targets.", week: 1, day: 4, time: "10:00", minutes: 45, type: "review", organizer: "yusuf", scope: { type: "department", ref: "sales" }, locationType: "in_person", location: "Abuja Hub" },
];

const FUTURE_RSVPS: RsvpResponse[] = ["accepted", "accepted", "accepted", "pending", "pending", "tentative", "declined"];

function meetUrlFor(seed: string): string {
  const letters = "abcdefghijkmnopqrstuvwxyz";
  const chunk = (n: number, salt: string) => Array.from({ length: n }, (_, i) => letters[hash(`${seed}:${salt}:${i}`) % letters.length]).join("");
  return `https://meet.google.com/${chunk(3, "a")}-${chunk(4, "b")}-${chunk(3, "c")}`;
}

function scopeIdOf(ctx: SeedContext, scope: { type: GroupKind; ref: string }): string {
  if (scope.type === "department") return ctx.department(scope.ref).id;
  if (scope.type === "team") return ctx.team(scope.ref).id;
  if (scope.type === "product") return ctx.product(scope.ref).id;
  return ctx.project(scope.ref).id;
}

export async function seedMeetings(ctx: SeedContext): Promise<void> {
  const everyone = [...ctx.users.values()].map((u) => u.id);
  for (const spec of MEETINGS) {
    const startsAt = weekSlot(spec.week, spec.day, spec.time);
    const endsAt = addMinutes(startsAt, spec.minutes);
    const group = spec.scope && spec.scope.type !== "organization" ? { type: spec.scope.type, id: scopeIdOf(ctx, spec.scope) } : null;
    const fromGroup = spec.scope?.type === "organization" ? everyone : group ? await groupsService.expandIds([group]) : [];
    const organizerId = ctx.id(spec.organizer);
    const attendeeIds = [...new Set([organizerId, ...fromGroup, ...ctx.ids(spec.people ?? [])])];
    const past = endsAt < now;
    const online = (spec.locationType ?? "online") !== "in_person";

    const [meeting, created] = await Meeting.findOrCreate({
      where: { title: spec.title, startsAt },
      defaults: {
        title: spec.title,
        description: spec.description,
        organizerId,
        startsAt,
        endsAt,
        meetUrl: online ? meetUrlFor(`${spec.title}:${startsAt.toISOString()}`) : "",
        hasMeetLink: online,
        type: spec.type,
        scopeType: (spec.scope?.type ?? null) as MeetingScope | null,
        scopeId: group?.id ?? null,
        status: past ? "completed" : "scheduled",
        locationType: spec.locationType ?? "online",
        location: spec.location ?? null,
        agenda: (spec.agenda ?? []).map((title) => ({ title, durationMinutes: Math.round(spec.minutes / (spec.agenda!.length || 1)) })),
        groups: group ? [group] : [],
        createdAt: addMinutes(startsAt, -60 * 24 * 5),
      },
    });
    if (!created) continue;

    await MeetingAttendee.bulkCreate(
      attendeeIds.map((userId) => {
        const seed = `${meeting.id}:${userId}`;
        const rsvp: RsvpResponse = userId === organizerId ? "accepted" : past ? (hash(seed) % 9 === 0 ? "declined" : "accepted") : pick(FUTURE_RSVPS, seed);
        const attendance: AttendanceStatus = !past ? "unknown" : rsvp === "declined" ? "absent" : hash(`${seed}:late`) % 7 === 0 ? "late" : "present";
        return {
          meetingId: meeting.id,
          userId,
          rsvp,
          rsvpNote: rsvp === "declined" ? "Clashes with a customer call, will catch up on the notes." : null,
          respondedAt: rsvp === "pending" ? null : addMinutes(startsAt, -60 * 24 * 2),
          attendance,
          attendanceMarkedBy: past ? organizerId : null,
        };
      }),
    );
    if (past && spec.note) await MeetingNote.create({ meetingId: meeting.id, kind: "decision", body: spec.note, createdBy: organizerId, createdAt: endsAt });
  }
}

export async function seedCalendarEvents(ctx: SeedContext): Promise<void> {
  const events = [
    { title: "Hyparrow public beta launch", description: "Public beta opens to the waitlist.", scopeType: "product" as const, scopeId: ctx.product("hyparrow").id, allDay: true, startsAt: weekSlot(1, 0, "00:00"), minutes: 24 * 60, by: "ngozi" },
    { title: "Workspace mobile 1.2 release", description: "Store submission for iOS and Android.", scopeType: "project" as const, scopeId: ctx.project("Workspace Mobile App").id, allDay: true, startsAt: weekSlot(1, 4, "00:00"), minutes: 24 * 60, by: "femi" },
    { title: "November expense claims deadline", description: "Upload receipts in the finance form.", scopeType: "organization" as const, scopeId: null, allDay: false, startsAt: weekSlot(0, 4, "17:00"), minutes: 30, by: "grace" },
  ];
  for (const e of events) {
    await CalendarEvent.findOrCreate({
      where: { title: e.title, startsAt: e.startsAt },
      defaults: { title: e.title, description: e.description, scopeType: e.scopeType, scopeId: e.scopeId, allDay: e.allDay, startsAt: e.startsAt, endsAt: addMinutes(e.startsAt, e.minutes), createdBy: ctx.id(e.by) },
    });
  }
}
