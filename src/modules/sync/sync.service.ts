import { Op, type ModelStatic, type Model } from "sequelize";
import { z } from "zod";
import { badRequest } from "../../lib/errors";
import { redis } from "../../redis/client";
import { Comment, Issue, Label, Meeting, Notification, Task, User, type ItemType } from "../../models";
import {
  serializeComment,
  serializeLabel,
  serializeMeeting,
  serializeNotification,
  serializeWorkItem,
  workItemInclude,
} from "../shared/serializers";
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

export const DELTA_COLLECTIONS = ["tasks", "issues", "comments", "notifications", "meetings"] as const;
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
  serialize: (row: Model) => unknown;
  ownerOnly?: boolean; // rows have userId and belong to one user
}

const DELTA: Record<DeltaCollection, DeltaSource> = {
  tasks: { model: Task, include: workItemInclude, serialize: (r) => serializeWorkItem(r as Task, "task") },
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
    serialize: (r) => serializeMeeting(r as Meeting),
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
        ...(source.ownerOnly ? { userId } : {}),
      },
      attributes: ["recordId"],
      order: [["deletedAt", "ASC"]],
      limit: 5_000,
    });

    changes[name] = { upserted: page.map(source.serialize), deleted: tombstones.map((t) => t.recordId) };

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
    "issue.create",
    "issue.update",
    "issue.status",
    "comment.create",
    "notification.read",
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
      return { mutationId: m.mutationId, status: "applied", record: await service.create(input, userId) };
    }
    if (!m.recordId) throw badRequest("recordId is required");
    const stale = await conflictIfStale(model, m.recordId, m.baseUpdatedAt, () => service.byId(m.recordId!));
    if (stale) return { ...stale, mutationId: m.mutationId };
    if (action === "update") {
      const patch = schemas.update.parse(m.payload) as WorkItemUpdateInput;
      return { mutationId: m.mutationId, status: "applied", record: await service.update(m.recordId, patch, userId) };
    }
    const { status } = statusSchema.parse(m.payload);
    return { mutationId: m.mutationId, status: "applied", record: await service.setStatus(m.recordId, status, userId) };
  }

  if (m.type === "comment.create") {
    const input = commentCreateSchema.parse({ ...m.payload, id: m.recordId ?? m.payload.id });
    return { mutationId: m.mutationId, status: "applied", record: await commentsService.add({ ...input, authorId: userId }) };
  }

  if (m.type === "notification.read") {
    if (!m.recordId) throw badRequest("recordId is required");
    return { mutationId: m.mutationId, status: "applied", record: await notificationsService.markRead(m.recordId, userId) };
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
