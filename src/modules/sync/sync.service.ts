import { Op, type ModelStatic, type Model } from "sequelize";
import { z } from "zod";
import { badRequest } from "../../lib/errors";
import { sequelize } from "../../db/sequelize";
import { redis } from "../../redis/client";
import { ContentEvent, ContentItem, SocialAccount, Appraisal, AppraisalCycle, StaffQuery, Target, TargetAssignment, TargetProgress, CalendarEvent, MeetingActionItem, MeetingAttendee, MeetingNote, Announcement, AnnouncementReceipt, Conversation, ConversationMember, Message, MessageReaction, Comment, Issue, Label, Meeting, Notification, Task, TaskReview, TaskStatusHistory, TaskSubmission, TaskTemplate, User, type ItemType } from "../../models";
import {
  serializeComment,
  serializeLabel,
  serializeMeeting,
  serializeMeetingAttendee,
  serializeNotification,
  serializeTaskReview,
  serializeTaskStatusHistory,
  serializeTaskSubmission,
  serializeTaskTemplate,
  serializeWorkItem,
  taskInclude,
  workItemInclude,
} from "../shared/serializers";
import { announcementsService, serializeAnnouncement, serializeReceipt } from "../announcements/announcements.service";
import { editSchema, emojiSchema, readSchema, sendSchema } from "../chat/chat.routes";
import { serializeConversations, serializeMember, serializeMessage } from "../chat/chat.serialize";
import { chatService, myConversationIds, type SendInput } from "../chat/chat.service";
import { contentService, contentVisibleWhere, serializeContent, serializeContentEvent, serializeSocial } from "../content/content.service";
import { contentCreateSchema, contentReviewSchema, contentStatusSchema, contentUpdateSchema } from "../marketing/marketing.routes";
import { calendarService, serializeActionItem, serializeEvent, serializeNote } from "../meetings/calendar.service";
import { inMyScopesSql, visibleMeetingIds, visibleMeetingsSql } from "../meetings/meeting.visibility";
import { actionItemSchema, actionItemUpdateSchema, noteSchema, rsvpSchema } from "../meetings/meetings.routes";
import { meetingsService } from "../meetings/meetings.service";
import { appraisalsService, serializeAppraisal, serializeCycle } from "../performance/appraisals.service";
import { managerSchema, progressSchema, respondSchema, selfSchema } from "../performance/performance.routes";
import { queriesService, queriesVisibleTo, seesAllQueries, serializeQuery } from "../performance/queries.service";
import { serializeProgress, serializeTarget, targetsService, targetsVisibleWhere } from "../performance/targets.service";
import { reviewSchema, submitSchema, taskStatusSchema } from "../tasks/tasks.schemas";
import { tasksWorkflow } from "../tasks/tasks.service";
import { usersRepo } from "../users/users.repo";
import { departmentsService } from "../departments/departments.service";
import { projectsService } from "../projects/projects.service";
import { issuesService, tasksService, type WorkItemCreateInput, type WorkItemUpdateInput } from "../workitems/workitems.service";
import { buildSchemas, statusSchema } from "../workitems/workitems.routes";
import { commentsService } from "../comments/comments.service";
import { notificationsService } from "../notifications/notifications.service";
import { SyncTombstone } from "./tombstones";

// Offline sync (API-CHANGES A006).
//
// PULL: the app sends its opaque cursor and gets everything that changed since.
//   - Reference collections (users, departments, projects, labels) are small and
//     derived from several tables (a project's members come from department
//     membership), so they are returned in full on every pull.
//   - Delta collections (tasks, issues, comments, notifications, meetings) return
//     rows with updated_at after the cursor, plus deleted ids from tombstones.
// PUSH: the app replays writes it made offline, in order. Each carries a
//   client mutation id, so a retried push never applies a write twice, and an
//   optional baseUpdatedAt so concurrent edits come back as conflicts.

export const DELTA_COLLECTIONS = [
  "tasks", "issues", "comments", "notifications", "meetings",
  "taskSubmissions", "taskReviews", "taskStatusHistory", "taskTemplates",
  "conversations", "conversationMembers", "messages", "announcements", "announcementReceipts",
  "meetingAttendees", "meetingNotes", "meetingActionItems", "calendarEvents",
  "staffQueries", "targets", "targetProgress", "appraisals", "appraisalCycles",
  "contentItems", "contentEvents", "socialAccounts",
] as const;
export const REFERENCE_COLLECTIONS = ["users", "departments", "projects", "labels"] as const;
type DeltaCollection = (typeof DELTA_COLLECTIONS)[number];
type ReferenceCollection = (typeof REFERENCE_COLLECTIONS)[number];
type Collection = DeltaCollection | ReferenceCollection;

const PAGE_SIZE = 500;
// Rows committed slightly after we read can carry an updated_at just before our
// read time. Overlapping the cursor by this window means they are picked up on
// the next pull; the app upserts by id, so repeats are harmless.
const SAFETY_WINDOW_MS = 5_000;

interface Cursor {
  v: 1;
  t: Partial<Record<DeltaCollection, string>>;
}

function decodeCursor(token: string | undefined): Cursor {
  if (!token) return { v: 1, t: {} };
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Cursor;
    if (parsed.v !== 1 || typeof parsed.t !== "object") throw new Error("bad cursor");
    return parsed;
  } catch {
    throw badRequest("Invalid sync cursor");
  }
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");

interface DeltaSource {
  model: ModelStatic<Model>;
  include?: unknown[];
  serialize?: (row: Model) => unknown;
  // For rows whose shape depends on who is reading.
  serializeAll?: (rows: Model[], userId: string) => Promise<unknown[]>;
  ownerOnly?: boolean; // rows have userId and belong to one user
  // Limits rows to what this person may see.
  visibleTo?: (userId: string) => Record<string | symbol, unknown> | Promise<Record<string | symbol, unknown>>;
}

const DELTA: Record<DeltaCollection, DeltaSource> = {
  tasks: { model: Task, include: taskInclude, serialize: (r) => serializeWorkItem(r as Task, "task") },
  taskSubmissions: { model: TaskSubmission, serialize: (r) => serializeTaskSubmission(r as TaskSubmission) },
  taskReviews: { model: TaskReview, serialize: (r) => serializeTaskReview(r as TaskReview) },
  taskStatusHistory: { model: TaskStatusHistory, serialize: (r) => serializeTaskStatusHistory(r as TaskStatusHistory) },
  taskTemplates: { model: TaskTemplate, serialize: (r) => serializeTaskTemplate(r as TaskTemplate) },
  conversations: {
    model: Conversation,
    visibleTo: (userId) => ({ id: { [Op.in]: myConversationIds(userId) } }),
    serializeAll: (rows, userId) => serializeConversations(rows as Conversation[], userId, { withCounts: false }),
  },
  conversationMembers: {
    model: ConversationMember,
    visibleTo: (userId) => ({ conversationId: { [Op.in]: myConversationIds(userId) }, leftAt: null }),
    serialize: (r) => serializeMember(r as ConversationMember),
  },
  messages: {
    model: Message,
    include: [{ model: MessageReaction, as: "reactions" }],
    visibleTo: (userId) => ({ conversationId: { [Op.in]: myConversationIds(userId) } }),
    serialize: (r) => serializeMessage(r as Message),
  },
  announcements: {
    model: Announcement,
    visibleTo: (userId) => ({
      [Op.or]: [
        { createdBy: userId },
        { id: { [Op.in]: sequelize.literal(`(SELECT announcement_id FROM announcement_receipts WHERE user_id = ${sequelize.escape(userId)})`) } },
      ],
    }),
    serialize: (r) => serializeAnnouncement(r as Announcement),
  },
  announcementReceipts: { model: AnnouncementReceipt, ownerOnly: true, serialize: (r) => serializeReceipt(r as AnnouncementReceipt) },
  issues: { model: Issue, include: workItemInclude, serialize: (r) => serializeWorkItem(r as Issue, "issue") },
  comments: {
    model: Comment,
    include: [{ model: User, as: "mentions", attributes: ["id"], through: { attributes: [] } }],
    serialize: (r) => serializeComment(r as Comment),
  },
  notifications: { model: Notification, serialize: (r) => serializeNotification(r as Notification), ownerOnly: true },
  meetings: {
    model: Meeting,
    include: [{ model: User, as: "attendees", attributes: ["id"], through: { attributes: [] } }],
    visibleTo: (userId) => ({ [Op.and]: [sequelize.literal(visibleMeetingsSql(userId))] }),
    serialize: (r) => serializeMeeting(r as Meeting),
  },
  meetingAttendees: {
    model: MeetingAttendee,
    visibleTo: (userId) => ({ meetingId: { [Op.in]: sequelize.literal(visibleMeetingIds(userId)) } }),
    serialize: (r) => serializeMeetingAttendee(r as MeetingAttendee),
  },
  meetingNotes: {
    model: MeetingNote,
    visibleTo: (userId) => ({ meetingId: { [Op.in]: sequelize.literal(visibleMeetingIds(userId)) } }),
    serialize: (r) => serializeNote(r as MeetingNote),
  },
  meetingActionItems: {
    model: MeetingActionItem,
    visibleTo: (userId) => ({ meetingId: { [Op.in]: sequelize.literal(visibleMeetingIds(userId)) } }),
    serialize: (r) => serializeActionItem(r as MeetingActionItem),
  },
  staffQueries: {
    model: StaffQuery,
    visibleTo: async (userId) => queriesVisibleTo(userId, await seesAllQueries(userId)) as Record<string | symbol, unknown>,
    serialize: (r) => serializeQuery(r as StaffQuery),
  },
  targets: {
    model: Target,
    include: [{ model: TargetAssignment, as: "assignments" }],
    visibleTo: (userId) => targetsVisibleWhere(userId) as Record<string | symbol, unknown>,
    serialize: (r) => serializeTarget(r as Target),
  },
  targetProgress: {
    model: TargetProgress,
    visibleTo: (userId) => ({
      targetId: {
        [Op.in]: sequelize.literal(
          `(SELECT t.id FROM targets t WHERE t.reviewer_id = ${sequelize.escape(userId)} OR t.created_by = ${sequelize.escape(userId)}
            OR t.id IN (SELECT target_id FROM target_assignments WHERE user_id = ${sequelize.escape(userId)}))`,
        ),
      },
    }),
    serialize: (r) => serializeProgress(r as TargetProgress),
  },
  appraisals: {
    model: Appraisal,
    visibleTo: (userId) => ({ [Op.or]: [{ userId }, { managerId: userId }] }),
    serializeAll: async (rows, userId) => (rows as Appraisal[]).map((a) => serializeAppraisal(a, userId)),
  },
  appraisalCycles: {
    model: AppraisalCycle,
    visibleTo: () => ({ status: { [Op.ne]: "draft" } }),
    serialize: (r) => serializeCycle(r as AppraisalCycle),
  },
  contentItems: {
    model: ContentItem,
    visibleTo: async (userId) => (await contentVisibleWhere(userId)) as Record<string | symbol, unknown>,
    serialize: (r) => serializeContent(r as ContentItem),
  },
  contentEvents: {
    model: ContentEvent,
    visibleTo: async (userId) => {
      const visible = await contentVisibleWhere(userId);
      const ids = (await ContentItem.findAll({ where: visible, attributes: ["id"] })).map((c) => c.id);
      return { contentId: ids };
    },
    serialize: (r) => serializeContentEvent(r as ContentEvent),
  },
  socialAccounts: { model: SocialAccount, serialize: (r) => serializeSocial(r as SocialAccount) },
  calendarEvents: {
    model: CalendarEvent,
    visibleTo: (userId) => ({ [Op.and]: [sequelize.literal(inMyScopesSql(userId, '"CalendarEvent"'))] }),
    serialize: (r) => serializeEvent(r as CalendarEvent),
  },
};

const REFERENCE: Record<ReferenceCollection, () => Promise<unknown[]>> = {
  users: () => usersRepo.list(),
  departments: () => departmentsService.list(),
  projects: () => projectsService.list(),
  labels: async () => (await Label.findAll({ order: [["name", "ASC"]] })).map(serializeLabel),
};

export interface CollectionChanges {
  upserted: unknown[];
  deleted: string[];
  full?: boolean; // true: replace the local collection with `upserted`
}

export async function pull(
  userId: string,
  cursorToken: string | undefined,
  requested?: string[],
): Promise<{ changes: Partial<Record<Collection, CollectionChanges>>; cursor: string; hasMore: boolean; serverTime: string }> {
  const startedAt = Date.now();
  const cursor = decodeCursor(cursorToken);
  const wanted = new Set<string>(requested?.length ? requested : [...DELTA_COLLECTIONS, ...REFERENCE_COLLECTIONS]);
  const changes: Partial<Record<Collection, CollectionChanges>> = {};
  const next: Cursor = { v: 1, t: { ...cursor.t } };
  let hasMore = false;

  for (const name of DELTA_COLLECTIONS) {
    if (!wanted.has(name)) continue;
    const source = DELTA[name];
    const since = cursor.t[name] ? new Date(cursor.t[name]!) : new Date(0);
    const where: Record<string | symbol, unknown> = { updatedAt: { [Op.gt]: since } };
    if (source.ownerOnly) where.userId = userId;
    if (source.visibleTo) Object.assign(where, await source.visibleTo(userId));

    const rows = await source.model.findAll({
      where,
      include: source.include as never,
      order: [["updatedAt", "ASC"]],
      limit: PAGE_SIZE + 1,
    });
    const more = rows.length > PAGE_SIZE;
    const page = more ? rows.slice(0, PAGE_SIZE) : rows;

    const tombstones = await SyncTombstone.findAll({
      where: {
        collection: name,
        deletedAt: { [Op.gt]: since },
        // A tombstone with a user is for that person alone, such as someone
        // removed from a conversation that carries on without them.
        userId: source.ownerOnly ? userId : { [Op.or]: [null, userId] },
      },
      attributes: ["recordId"],
      order: [["deletedAt", "ASC"]],
      limit: 5_000,
    });

    const upserted = source.serializeAll ? await source.serializeAll(page, userId) : page.map((r) => source.serialize!(r));
    changes[name] = { upserted, deleted: tombstones.map((t) => t.recordId) };

    if (more) {
      hasMore = true;
      next.t[name] = (page[page.length - 1]!.get("updatedAt") as Date).toISOString();
    } else {
      const safe = new Date(startedAt - SAFETY_WINDOW_MS);
      next.t[name] = (safe > since ? safe : since).toISOString();
    }
  }

  for (const name of REFERENCE_COLLECTIONS) {
    if (!wanted.has(name)) continue;
    changes[name] = { upserted: await REFERENCE[name](), deleted: [], full: true };
  }

  return { changes, cursor: encodeCursor(next), hasMore, serverTime: new Date(startedAt).toISOString() };
}

// ---- Push --------------------------------------------------------------------

export const mutationSchema = z.object({
  mutationId: z.string().uuid(),
  type: z.enum([
    "task.create",
    "task.update",
    "task.status",
    "task.submit",
    "task.review",
    "issue.create",
    "issue.update",
    "issue.status",
    "comment.create",
    "notification.read",
    "conversation.direct",
    "conversation.read",
    "message.send",
    "message.edit",
    "message.delete",
    "message.react",
    "message.unreact",
    "announcement.read",
    "announcement.acknowledge",
    "meeting.rsvp",
    "meeting.note",
    "meeting.actionItem",
    "meeting.actionItemUpdate",
    "query.respond",
    "target.progress",
    "appraisal.self",
    "appraisal.manager",
    "content.create",
    "content.update",
    "content.status",
    "content.review",
  ]),
  recordId: z.string().uuid().optional(),
  payload: z.record(z.unknown()).default({}),
  // The record's updatedAt the device last saw. When the server copy is newer,
  // the write is not applied and the server copy is returned as a conflict.
  baseUpdatedAt: z.string().datetime().optional(),
});
export type Mutation = z.infer<typeof mutationSchema>;

export interface MutationResult {
  mutationId: string;
  status: "applied" | "conflict" | "rejected";
  record?: unknown;
  error?: string;
}

const MUTATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const mutationKey = (userId: string, id: string) => `sync:mut:${userId}:${id}`;

const commentCreateSchema = z.object({
  id: z.string().uuid().optional(),
  itemId: z.string().uuid(),
  itemType: z.enum(["task", "issue"]),
  body: z.string().trim().min(1).max(8000),
  mentions: z.array(z.string().uuid()).optional(),
});

function workItem(type: ItemType) {
  return type === "task"
    ? { service: tasksService, model: Task as ModelStatic<Model>, schemas: buildSchemas(false) }
    : { service: issuesService, model: Issue as ModelStatic<Model>, schemas: buildSchemas(true) };
}

async function conflictIfStale(
  model: ModelStatic<Model>,
  recordId: string,
  baseUpdatedAt: string | undefined,
  serialize: () => Promise<unknown>,
): Promise<MutationResult | null> {
  if (!baseUpdatedAt) return null;
  const row = await model.findByPk(recordId, { attributes: ["id", "updatedAt"] });
  if (!row) return null; // let the write itself report not found
  const serverUpdated = row.get("updatedAt") as Date;
  if (serverUpdated.getTime() > new Date(baseUpdatedAt).getTime()) {
    return { mutationId: "", status: "conflict", record: await serialize() };
  }
  return null;
}

async function apply(userId: string, m: Mutation): Promise<MutationResult> {
  const [resource, action] = m.type.split(".") as [string, string];

  if (resource === "task" || resource === "issue") {
    const { service, model, schemas } = workItem(resource);
    if (action === "create") {
      // Validated by the same schema the REST endpoint uses.
      const input = schemas.create
        .extend({ id: z.string().uuid().optional() })
        .parse({ ...m.payload, id: m.recordId ?? m.payload.id }) as WorkItemCreateInput;
      return { mutationId: m.mutationId, status: "applied", record: await service.create(input, userId, { strict: true }) };
    }
    if (!m.recordId) throw badRequest("recordId is required");
    const stale = await conflictIfStale(model, m.recordId, m.baseUpdatedAt, () => service.byId(m.recordId!));
    if (stale) return { ...stale, mutationId: m.mutationId };
    if (action === "update") {
      const patch = schemas.update.parse(m.payload) as WorkItemUpdateInput;
      return { mutationId: m.mutationId, status: "applied", record: await service.update(m.recordId, patch, userId, { strict: true }) };
    }
    if (action === "submit") {
      const out = await tasksWorkflow.submit(m.recordId, submitSchema.parse(m.payload), userId);
      return { mutationId: m.mutationId, status: "applied", record: out.item };
    }
    if (action === "review") {
      const out = await tasksWorkflow.review(m.recordId, reviewSchema.parse(m.payload), userId);
      return { mutationId: m.mutationId, status: "applied", record: out.item };
    }
    const { status, note, blockedReason } = (resource === "task" ? taskStatusSchema : statusSchema.extend({ note: z.string().optional(), blockedReason: z.string().optional() })).parse(m.payload);
    return { mutationId: m.mutationId, status: "applied", record: await service.setStatus(m.recordId, status, userId, { note, blockedReason }) };
  }

  if (m.type === "comment.create") {
    const input = commentCreateSchema.parse({ ...m.payload, id: m.recordId ?? m.payload.id });
    return { mutationId: m.mutationId, status: "applied", record: await commentsService.add({ ...input, authorId: userId }) };
  }

  if (m.type === "notification.read") {
    if (!m.recordId) throw badRequest("recordId is required");
    return { mutationId: m.mutationId, status: "applied", record: await notificationsService.markRead(m.recordId, userId) };
  }

  const needRecord = (): string => {
    if (!m.recordId) throw badRequest("recordId is required");
    return m.recordId;
  };
  const applied = (record: unknown): MutationResult => ({ mutationId: m.mutationId, status: "applied", record });
  switch (m.type) {
    case "conversation.direct": {
      const { userId: other } = z.object({ userId: z.string().uuid() }).parse(m.payload);
      return applied((await chatService.openDirect(userId, other, m.recordId)).conversation);
    }
    case "conversation.read":
      return applied(await chatService.read(needRecord(), readSchema.parse(m.payload).seq, userId));
    case "message.send": {
      const { conversationId, ...rest } = sendSchema.extend({ conversationId: z.string().uuid() }).parse({ ...m.payload, id: m.recordId ?? m.payload.id });
      return applied((await chatService.send(conversationId, rest as SendInput, userId)).message);
    }
    case "message.edit":
      return applied(await chatService.edit(needRecord(), editSchema.parse(m.payload), userId));
    case "message.delete":
      return applied(await chatService.remove(needRecord(), userId));
    case "message.react":
      return applied(await chatService.react(needRecord(), emojiSchema.parse(m.payload).emoji, true, userId));
    case "message.unreact":
      return applied(await chatService.react(needRecord(), emojiSchema.parse(m.payload).emoji, false, userId));
    case "announcement.read":
      return applied(await announcementsService.markRead(needRecord(), userId));
    case "announcement.acknowledge":
      return applied(await announcementsService.acknowledge(needRecord(), userId));
    case "content.create":
      return applied(await contentService.create(contentCreateSchema.parse({ ...m.payload, id: m.recordId ?? m.payload.id }), userId));
    case "content.update":
      return applied(await contentService.update(needRecord(), contentUpdateSchema.parse(m.payload), userId));
    case "content.status": {
      const { status, note } = contentStatusSchema.parse(m.payload);
      return applied(await contentService.setStatus(needRecord(), status, note, userId));
    }
    case "content.review":
      return applied((await contentService.review(needRecord(), contentReviewSchema.parse(m.payload), userId)).item);
    case "query.respond":
      return applied(await queriesService.respond(needRecord(), respondSchema.parse(m.payload), userId));
    case "target.progress":
      return applied((await targetsService.addProgress(needRecord(), progressSchema.parse(m.payload), userId)).target);
    case "appraisal.self":
      return applied(await appraisalsService.saveSelf(needRecord(), selfSchema.parse(m.payload), userId));
    case "appraisal.manager":
      return applied(await appraisalsService.saveManager(needRecord(), managerSchema.parse(m.payload), userId));
    case "meeting.rsvp": {
      const { response, note } = rsvpSchema.parse(m.payload);
      return applied(await meetingsService.rsvp(needRecord(), userId, response, note));
    }
    case "meeting.note":
      return applied(await calendarService.addNote(needRecord(), noteSchema.parse(m.payload), userId));
    case "meeting.actionItem":
      return applied(await calendarService.addActionItem(needRecord(), actionItemSchema.parse(m.payload), userId));
    case "meeting.actionItemUpdate": {
      const { meetingId, ...patch } = actionItemUpdateSchema.extend({ meetingId: z.string().uuid() }).parse(m.payload);
      return applied(await calendarService.updateActionItem(meetingId, needRecord(), patch, userId));
    }
  }

  throw badRequest(`Unsupported mutation ${m.type}`);
}

// Applies mutations in order. A rejected mutation does not stop the batch: the
// app shows it in "Needs your decision" (SYS-15) and the rest still sync.
export async function push(userId: string, mutations: Mutation[]): Promise<MutationResult[]> {
  const results: MutationResult[] = [];
  for (const m of mutations) {
    const key = mutationKey(userId, m.mutationId);
    const seen = await redis.get(key);
    if (seen) {
      results.push(JSON.parse(seen) as MutationResult);
      continue;
    }
    let result: MutationResult;
    try {
      result = await apply(userId, m);
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (err as Error).message;
      result = { mutationId: m.mutationId, status: "rejected", error: message };
    }
    // Conflicts are not remembered: once the user decides, the app resends the
    // write with a fresh baseUpdatedAt under the same mutation id.
    if (result.status !== "conflict") {
      await redis.set(key, JSON.stringify(result), "EX", MUTATION_TTL_SECONDS);
    }
    results.push(result);
  }
  return results;
}
