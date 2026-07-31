import { Op, type WhereOptions } from "sequelize";
import { z } from "zod";
import type { ToolDefinition } from "../../lib/openrouter";
import { badRequest, notFound } from "../../lib/errors";
import {
  Comment,
  Department,
  Issue,
  Meeting,
  Project,
  Task,
  User,
  type ItemType,
} from "../../models";
import { serializeWorkItem, workItemInclude } from "../shared/serializers";
import { commentsService } from "../comments/comments.service";
import { issuesService, tasksService } from "../workitems/workitems.service";
import { meService } from "../me/me.service";
import { blogsService } from "../blogs/blogs.service";
import type { ActorContext } from "./ai.context";

// A tool the model may call. `mutates` is the security-relevant bit: mutating
// tools are never executed inside the reasoning loop — they are staged and
// replayed only after the person clicks confirm (see ai.actions.ts).
export interface Tool {
  name: string;
  description: string;
  parameters: z.ZodType<any>;
  jsonSchema: Record<string, unknown>;
  mutates: boolean;
  /** One line shown on the confirmation card. Mutating tools only. */
  preview?: (args: any, actor: ActorContext) => Promise<string> | string;
  run: (args: any, actor: ActorContext) => Promise<unknown>;
}

const uuid = z.string().uuid();
const ITEM_TYPE = z.enum(["task", "issue"]);
const STATUS = z.enum(["todo", "in_progress", "in_review", "blocked", "done"]);
const PRIORITY = z.enum(["low", "medium", "high", "urgent"]);

const serviceFor = (type: ItemType) => (type === "task" ? tasksService : issuesService);
const modelFor = (type: ItemType) => (type === "task" ? Task : Issue);

// Tool results are fed back to the model as JSON, so they must stay small.
// Trimming here is much cheaper than paying for the tokens twice (once in the
// tool turn, once in everything that follows it).
function briefItem(item: Task | Issue, type: ItemType) {
  const assignees = (item.get("assignees") as User[] | undefined) ?? [];
  return {
    id: item.id,
    type,
    title: item.title,
    status: item.status,
    priority: item.priority,
    projectId: item.projectId,
    assigneeIds: assignees.map((u) => u.id),
    dueDate: item.dueDate ? item.dueDate.toISOString() : null,
  };
}

async function findItem(itemId: string, itemType: ItemType) {
  const item = await modelFor(itemType).findByPk(itemId, { include: workItemInclude });
  if (!item) throw notFound(`${itemType} not found`);
  return item;
}

// Resolve a project by id or by (case-insensitive) name, so the model can act
// on "the Hyparrow project" without a lookup round trip.
async function resolveProject(ref: string): Promise<Project> {
  const byId = uuid.safeParse(ref).success ? await Project.findByPk(ref) : null;
  if (byId) return byId;
  const byName = await Project.findOne({ where: { name: { [Op.iLike]: ref } } });
  if (byName) return byName;
  const fuzzy = await Project.findAll({ where: { name: { [Op.iLike]: `%${ref}%` } }, limit: 5 });
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length > 1) {
    throw badRequest(`"${ref}" matches several projects: ${fuzzy.map((p) => p.name).join(", ")}`);
  }
  throw notFound(`No project matching "${ref}"`);
}

async function resolveUser(ref: string): Promise<User> {
  const byId = uuid.safeParse(ref).success ? await User.findByPk(ref) : null;
  if (byId) return byId;
  const match = await User.findAll({
    where: {
      [Op.or]: [{ name: { [Op.iLike]: `%${ref}%` } }, { email: { [Op.iLike]: `%${ref}%` } }],
    },
    limit: 5,
  });
  if (match.length === 1) return match[0]!;
  if (match.length > 1) {
    throw badRequest(`"${ref}" matches several people: ${match.map((u) => u.name).join(", ")}`);
  }
  throw notFound(`No person matching "${ref}"`);
}

// ---- Read tools ------------------------------------------------------------

const readTools: Tool[] = [
  {
    name: "get_my_work",
    description:
      "The signed-in person's own work: items assigned to them, items due soon, items " +
      "waiting on their feedback, or items they reported. Use this for 'what do I have " +
      "today', 'what's on my plate', 'what's due this week'.",
    parameters: z.object({
      bucket: z.enum(["assigned", "due_soon", "awaiting_my_feedback", "reported"]),
      withinDays: z.number().int().min(1).max(90).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        bucket: {
          type: "string",
          enum: ["assigned", "due_soon", "awaiting_my_feedback", "reported"],
          description: "Which slice of their work to return.",
        },
        withinDays: {
          type: "integer",
          description: "Only for bucket=due_soon. Defaults to 7.",
        },
      },
      required: ["bucket"],
    },
    mutates: false,
    async run(args, actor) {
      switch (args.bucket) {
        case "assigned":
          return meService.assigned(actor.id);
        case "due_soon":
          return meService.dueSoon(actor.id, args.withinDays ?? 7);
        case "awaiting_my_feedback":
          return meService.awaitingFeedback(actor.id);
        default:
          return meService.reported(actor.id);
      }
    },
  },

  {
    name: "search_work_items",
    description:
      "Search tasks and issues across the workspace by any combination of text, project, " +
      "department, status, priority, and assignee. Returns compact rows — call " +
      "get_work_item for the full record of one.",
    parameters: z.object({
      query: z.string().trim().min(1).max(200).optional(),
      itemType: ITEM_TYPE.optional(),
      project: z.string().trim().min(1).optional(),
      assignee: z.string().trim().min(1).optional(),
      status: STATUS.optional(),
      priority: PRIORITY.optional(),
      overdue: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text matched against title and description." },
        itemType: { type: "string", enum: ["task", "issue"], description: "Omit to search both." },
        project: { type: "string", description: "Project id or name." },
        assignee: { type: "string", description: "User id, name, or email." },
        status: { type: "string", enum: ["todo", "in_progress", "in_review", "blocked", "done"] },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        overdue: { type: "boolean", description: "Only items past their due date and not done." },
        limit: { type: "integer", description: "Max rows per type. Defaults to 20." },
      },
      required: [],
    },
    mutates: false,
    async run(args) {
      const where: Record<string | symbol, unknown> = {};
      if (args.query) {
        where[Op.or] = [
          { title: { [Op.iLike]: `%${args.query}%` } },
          { description: { [Op.iLike]: `%${args.query}%` } },
        ];
      }
      if (args.project) where.projectId = (await resolveProject(args.project)).id;
      if (args.status) where.status = args.status;
      if (args.priority) where.priority = args.priority;
      if (args.overdue) {
        where.dueDate = { [Op.ne]: null, [Op.lt]: new Date() };
        if (!args.status) where.status = { [Op.ne]: "done" };
      }

      // Filtering by assignee means constraining the assignees join rather than
      // adding a column predicate, so it replaces that one include.
      const include = args.assignee
        ? [
            {
              model: User,
              as: "assignees",
              attributes: ["id"],
              where: { id: (await resolveUser(args.assignee)).id },
              through: { attributes: [] },
            },
            ...workItemInclude.slice(1),
          ]
        : workItemInclude;

      const limit = args.limit ?? 20;
      const types: ItemType[] = args.itemType ? [args.itemType] : ["task", "issue"];
      const results = await Promise.all(
        types.map((type) =>
          modelFor(type)
            .findAll({
              where: where as WhereOptions,
              include,
              order: [["updatedAt", "DESC"]],
              limit,
            })
            .then((rows) => rows.map((r) => briefItem(r, type))),
        ),
      );
      return results.flat();
    },
  },

  {
    name: "get_work_item",
    description:
      "The full record of one task or issue — description, assignees, labels, linked PRs " +
      "and GitHub issue, plus its comment thread.",
    parameters: z.object({ itemId: uuid, itemType: ITEM_TYPE }),
    jsonSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The item's UUID." },
        itemType: { type: "string", enum: ["task", "issue"] },
      },
      required: ["itemId", "itemType"],
    },
    mutates: false,
    async run(args) {
      const item = await findItem(args.itemId, args.itemType);
      const comments = await Comment.findAll({
        where: { itemId: args.itemId },
        order: [["createdAt", "ASC"]],
        limit: 50,
      });
      const authors = await User.findAll({
        where: { id: [...new Set(comments.map((c) => c.authorId).filter(Boolean))] as string[] },
        attributes: ["id", "name"],
      });
      const nameById = new Map(authors.map((u) => [u.id, u.name]));
      return {
        item: serializeWorkItem(item, args.itemType),
        comments: comments.map((c) => ({
          author: c.authorId ? (nameById.get(c.authorId) ?? "unknown") : "unknown",
          body: c.body,
          at: c.createdAt.toISOString(),
        })),
      };
    },
  },

  {
    name: "list_projects",
    description:
      "Every project in the workspace with its manager, declared tech stack, and progress. " +
      "Use it to turn a project name into an id.",
    parameters: z.object({ query: z.string().trim().min(1).optional() }),
    jsonSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Filter by name substring." } },
      required: [],
    },
    mutates: false,
    async run(args) {
      const projects = await Project.findAll({
        where: args.query ? { name: { [Op.iLike]: `%${args.query}%` } } : undefined,
        order: [["name", "ASC"]],
      });
      return projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        techStack: p.techStack || null,
        managerId: p.managerId ?? null,
        progress: p.progress,
      }));
    },
  },

  {
    name: "list_departments",
    description: "Every department with its head and member ids.",
    parameters: z.object({}),
    jsonSchema: { type: "object", properties: {}, required: [] },
    mutates: false,
    async run() {
      const depts = await Department.findAll({
        include: [{ model: User, as: "members", attributes: ["id", "name"], through: { attributes: [] } }],
        order: [["name", "ASC"]],
      });
      return depts.map((d) => ({
        id: d.id,
        name: d.name,
        slug: d.slug,
        description: d.description,
        headId: d.headId ?? null,
        members: ((d.get("members") as User[] | undefined) ?? []).map((m) => ({
          id: m.id,
          name: m.name,
        })),
      }));
    },
  },

  {
    name: "list_people",
    description:
      "The team roster — names, emails, roles, access level, and department membership. " +
      "Use it to turn a person's name into a user id.",
    parameters: z.object({ query: z.string().trim().min(1).optional() }),
    jsonSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Filter by name or email substring." } },
      required: [],
    },
    mutates: false,
    async run(args) {
      const where = args.query
        ? {
            [Op.or]: [
              { name: { [Op.iLike]: `%${args.query}%` } },
              { email: { [Op.iLike]: `%${args.query}%` } },
            ],
          }
        : undefined;
      const users = await User.findAll({
        where,
        attributes: ["id", "name", "email", "roles", "accessLevel"],
        include: [
          { model: Department, as: "departments", attributes: ["id", "name"], through: { attributes: [] } },
        ],
        order: [["name", "ASC"]],
      });
      return users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        roles: u.roles ?? [],
        accessLevel: u.accessLevel,
        departments: ((u.get("departments") as Department[] | undefined) ?? []).map((d) => d.name),
      }));
    },
  },

  {
    name: "list_meetings",
    description: "Meetings in a time window, with their attendees and Meet links.",
    parameters: z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      mineOnly: z.boolean().optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO timestamp. Defaults to now." },
        to: { type: "string", description: "ISO timestamp. Defaults to 14 days after `from`." },
        mineOnly: { type: "boolean", description: "Only meetings this person attends or organizes." },
      },
      required: [],
    },
    mutates: false,
    async run(args, actor) {
      const from = args.from ? new Date(args.from) : new Date();
      const to = args.to ? new Date(args.to) : new Date(from.getTime() + 14 * 86_400_000);
      const meetings = await Meeting.findAll({
        where: { startsAt: { [Op.gte]: from, [Op.lte]: to } },
        include: [{ model: User, as: "attendees", attributes: ["id", "name"], through: { attributes: [] } }],
        order: [["startsAt", "ASC"]],
        limit: 100,
      });
      return meetings
        .map((m) => ({
          id: m.id,
          title: m.title,
          startsAt: m.startsAt.toISOString(),
          endsAt: m.endsAt.toISOString(),
          meetUrl: m.meetUrl,
          organizerId: m.organizerId ?? null,
          attendees: ((m.get("attendees") as User[] | undefined) ?? []).map((a) => ({
            id: a.id,
            name: a.name,
          })),
        }))
        .filter(
          (m) =>
            !args.mineOnly ||
            m.organizerId === actor.id ||
            m.attendees.some((a) => a.id === actor.id),
        );
    },
  },

  {
    name: "list_blog_posts",
    description:
      "Blog posts for a project's channel. Posts live in the connected publishing system, " +
      "not in the Dev Space, so this reads them over its API.",
    parameters: z.object({
      project: z.string().trim().min(1),
      status: z.enum(["draft", "pending", "approved", "rejected"]).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id or name." },
        status: { type: "string", enum: ["draft", "pending", "approved", "rejected"] },
      },
      required: ["project"],
    },
    mutates: false,
    async run(args, actor) {
      const project = await resolveProject(args.project);
      return blogsService.listPosts(project.id, actor.auth, args.status);
    },
  },

  {
    name: "get_blog_post",
    description:
      "One blog post in full, including its body, SEO fields, and the latest automated " +
      "pre-publication review if one has been run.",
    parameters: z.object({ project: z.string().trim().min(1), postId: z.string().trim().min(1) }),
    jsonSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id or name." },
        postId: { type: "string", description: "The post's id in the publishing system." },
      },
      required: ["project", "postId"],
    },
    mutates: false,
    async run(args, actor) {
      const project = await resolveProject(args.project);
      const [post, review] = await Promise.all([
        blogsService.getPost(project.id, args.postId, actor.auth),
        blogsService.getReview(project.id, args.postId, actor.auth).catch(() => null),
      ]);
      return { post, review };
    },
  },
];

// ---- Write tools -----------------------------------------------------------
// Everything below is staged and confirmed before it runs. `preview` is what the
// person actually reads before approving, so it must describe the real effect —
// resolved names, not raw ids.

const writeTools: Tool[] = [
  {
    name: "create_work_item",
    description:
      "Create a task or issue. Prefer assigning it to someone explicitly; if the person " +
      "says 'for me', use their own user id.",
    parameters: z.object({
      itemType: ITEM_TYPE,
      project: z.string().trim().min(1),
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(8000).optional(),
      status: STATUS.optional(),
      priority: PRIORITY.optional(),
      assignees: z.array(z.string().trim().min(1)).max(10).optional(),
      dueDate: z.string().datetime().optional(),
      severity: z.enum(["minor", "major", "critical"]).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        itemType: { type: "string", enum: ["task", "issue"] },
        project: { type: "string", description: "Project id or name." },
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["todo", "in_progress", "in_review", "blocked", "done"] },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "User ids, names, or emails.",
        },
        dueDate: { type: "string", description: "ISO timestamp." },
        severity: {
          type: "string",
          enum: ["minor", "major", "critical"],
          description: "Issues only.",
        },
      },
      required: ["itemType", "project", "title"],
    },
    mutates: true,
    async preview(args) {
      const project = await resolveProject(args.project);
      const who = args.assignees?.length
        ? ` assigned to ${(await Promise.all(args.assignees.map((a: string) => resolveUser(a)))).map((u) => u.name).join(", ")}`
        : " unassigned";
      return `Create ${args.itemType} "${args.title}" in ${project.name}${who}`;
    },
    async run(args, actor) {
      const project = await resolveProject(args.project);
      const assigneeIds = args.assignees?.length
        ? (await Promise.all(args.assignees.map((a: string) => resolveUser(a)))).map((u) => u.id)
        : undefined;
      return serviceFor(args.itemType).create(
        {
          projectId: project.id,
          title: args.title,
          description: args.description,
          status: args.status,
          priority: args.priority,
          assigneeIds,
          dueDate: args.dueDate,
          severity: args.severity,
        },
        actor.id,
      );
    },
  },

  {
    name: "update_work_item",
    description:
      "Change a task or issue's title, description, priority, due date, severity, or " +
      "assignees. Only send the fields that should change. Assignees are replaced " +
      "wholesale, so include everyone who should end up on the item.",
    parameters: z.object({
      itemId: uuid,
      itemType: ITEM_TYPE,
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().trim().max(8000).optional(),
      priority: PRIORITY.optional(),
      assignees: z.array(z.string().trim().min(1)).max(10).optional(),
      dueDate: z.string().datetime().nullable().optional(),
      severity: z.enum(["minor", "major", "critical"]).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        itemType: { type: "string", enum: ["task", "issue"] },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "Replaces the current assignee list. User ids, names, or emails.",
        },
        dueDate: { type: "string", description: "ISO timestamp, or null to clear." },
        severity: { type: "string", enum: ["minor", "major", "critical"] },
      },
      required: ["itemId", "itemType"],
    },
    mutates: true,
    async preview(args) {
      const item = await findItem(args.itemId, args.itemType);
      const changes: string[] = [];
      if (args.title !== undefined) changes.push(`title → "${args.title}"`);
      if (args.description !== undefined) changes.push("description rewritten");
      if (args.priority !== undefined) changes.push(`priority → ${args.priority}`);
      if (args.severity !== undefined) changes.push(`severity → ${args.severity}`);
      if (args.dueDate !== undefined) {
        changes.push(`due date → ${args.dueDate ? args.dueDate.slice(0, 10) : "cleared"}`);
      }
      if (args.assignees !== undefined) {
        const names = (await Promise.all(args.assignees.map((a: string) => resolveUser(a)))).map(
          (u) => u.name,
        );
        changes.push(`assignees → ${names.join(", ") || "nobody"}`);
      }
      return `Update ${args.itemType} "${item.title}": ${changes.join("; ") || "no changes"}`;
    },
    async run(args, actor) {
      const assigneeIds = args.assignees
        ? (await Promise.all(args.assignees.map((a: string) => resolveUser(a)))).map((u) => u.id)
        : undefined;
      return serviceFor(args.itemType).update(
        args.itemId,
        {
          title: args.title,
          description: args.description,
          priority: args.priority,
          assigneeIds,
          dueDate: args.dueDate,
          severity: args.severity,
        },
        actor.id,
      );
    },
  },

  {
    name: "set_work_item_status",
    description:
      "Move a task or issue to a different status. For an issue linked to GitHub this " +
      "also opens or closes the GitHub issue.",
    parameters: z.object({ itemId: uuid, itemType: ITEM_TYPE, status: STATUS }),
    jsonSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        itemType: { type: "string", enum: ["task", "issue"] },
        status: { type: "string", enum: ["todo", "in_progress", "in_review", "blocked", "done"] },
      },
      required: ["itemId", "itemType", "status"],
    },
    mutates: true,
    async preview(args) {
      const item = await findItem(args.itemId, args.itemType);
      return `Move ${args.itemType} "${item.title}" from ${item.status} to ${args.status}`;
    },
    run: (args, actor) => serviceFor(args.itemType).setStatus(args.itemId, args.status, actor.id),
  },

  {
    name: "add_comment",
    description:
      "Post a comment on a task or issue as the signed-in person. On an issue linked to " +
      "GitHub the comment is mirrored there too.",
    parameters: z.object({
      itemId: uuid,
      itemType: ITEM_TYPE,
      body: z.string().trim().min(1).max(8000),
      mentions: z.array(z.string().trim().min(1)).max(10).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        itemType: { type: "string", enum: ["task", "issue"] },
        body: { type: "string", description: "Markdown is supported." },
        mentions: {
          type: "array",
          items: { type: "string" },
          description: "People to notify. User ids, names, or emails.",
        },
      },
      required: ["itemId", "itemType", "body"],
    },
    mutates: true,
    async preview(args) {
      const item = await findItem(args.itemId, args.itemType);
      const excerpt = args.body.length > 120 ? `${args.body.slice(0, 120)}…` : args.body;
      return `Comment on "${item.title}": ${excerpt}`;
    },
    async run(args, actor) {
      const mentions = args.mentions?.length
        ? (await Promise.all(args.mentions.map((m: string) => resolveUser(m)))).map((u) => u.id)
        : undefined;
      return commentsService.add({
        itemId: args.itemId,
        itemType: args.itemType,
        authorId: actor.id,
        body: args.body,
        mentions,
      });
    },
  },

  {
    name: "request_feedback",
    description: "Ask a specific person for feedback on a task or issue, and notify them.",
    parameters: z.object({ itemId: uuid, itemType: ITEM_TYPE, from: z.string().trim().min(1) }),
    jsonSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        itemType: { type: "string", enum: ["task", "issue"] },
        from: { type: "string", description: "Who to ask. User id, name, or email." },
      },
      required: ["itemId", "itemType", "from"],
    },
    mutates: true,
    async preview(args) {
      const [item, user] = await Promise.all([
        findItem(args.itemId, args.itemType),
        resolveUser(args.from),
      ]);
      return `Request feedback from ${user.name} on "${item.title}"`;
    },
    async run(args, actor) {
      const user = await resolveUser(args.from);
      return serviceFor(args.itemType).requestFeedback(args.itemId, user.id, actor.id);
    },
  },

  {
    name: "create_blog_post",
    description:
      "Create a draft blog post on a project's channel. Drafts are safe — publishing " +
      "still requires the normal review and approval flow.",
    parameters: z.object({
      project: z.string().trim().min(1),
      title: z.string().trim().min(1).max(300),
      content: z.string().trim().min(1).max(100_000),
      subtitle: z.string().trim().max(500).optional(),
      seoTitle: z.string().trim().max(300).optional(),
      seoDescription: z.string().trim().max(500).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id or name." },
        title: { type: "string" },
        content: { type: "string", description: "The post body, in Markdown." },
        subtitle: { type: "string" },
        seoTitle: { type: "string" },
        seoDescription: { type: "string" },
      },
      required: ["project", "title", "content"],
    },
    mutates: true,
    async preview(args) {
      const project = await resolveProject(args.project);
      const words = args.content.trim().split(/\s+/).length;
      return `Create draft post "${args.title}" (~${words} words) on ${project.name}'s blog`;
    },
    async run(args, actor) {
      const project = await resolveProject(args.project);
      return blogsService.createPost(
        project.id,
        {
          title: args.title,
          content: args.content,
          subtitle: args.subtitle,
          seoTitle: args.seoTitle,
          seoDescription: args.seoDescription,
          status: "draft",
        },
        actor.auth,
      );
    },
  },

  {
    name: "update_blog_post",
    description:
      "Edit an existing blog post — body, title, subtitle, or SEO fields. Editing a post " +
      "invalidates any automated review it already passed, so it will need re-reviewing.",
    parameters: z.object({
      project: z.string().trim().min(1),
      postId: z.string().trim().min(1),
      title: z.string().trim().min(1).max(300).optional(),
      content: z.string().trim().min(1).max(100_000).optional(),
      subtitle: z.string().trim().max(500).optional(),
      seoTitle: z.string().trim().max(300).optional(),
      seoDescription: z.string().trim().max(500).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id or name." },
        postId: { type: "string" },
        title: { type: "string" },
        content: { type: "string", description: "Replaces the whole body." },
        subtitle: { type: "string" },
        seoTitle: { type: "string" },
        seoDescription: { type: "string" },
      },
      required: ["project", "postId"],
    },
    mutates: true,
    async preview(args, actor) {
      const project = await resolveProject(args.project);
      const post = await blogsService.getPost(project.id, args.postId, actor.auth);
      const fields = ["title", "content", "subtitle", "seoTitle", "seoDescription"].filter(
        (f) => args[f] !== undefined,
      );
      return `Edit post "${post.title}" on ${project.name}'s blog (${fields.join(", ") || "no fields"})`;
    },
    async run(args, actor) {
      const project = await resolveProject(args.project);
      return blogsService.updatePost(
        project.id,
        args.postId,
        {
          title: args.title,
          content: args.content,
          subtitle: args.subtitle,
          seoTitle: args.seoTitle,
          seoDescription: args.seoDescription,
        },
        actor.auth,
      );
    },
  },

  {
    name: "run_blog_ai_review",
    description:
      "Run the automated safety/SEO pre-publication review on a post. This is the " +
      "publishing system's own reviewer, not this assistant — it returns a verdict, " +
      "scores, and findings. Slow (up to two minutes).",
    parameters: z.object({ project: z.string().trim().min(1), postId: z.string().trim().min(1) }),
    jsonSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id or name." },
        postId: { type: "string" },
      },
      required: ["project", "postId"],
    },
    mutates: true,
    async preview(args, actor) {
      const project = await resolveProject(args.project);
      const post = await blogsService.getPost(project.id, args.postId, actor.auth);
      return `Run the pre-publication review on "${post.title}"`;
    },
    async run(args, actor) {
      const project = await resolveProject(args.project);
      return blogsService.runAIReview(project.id, args.postId, actor.auth);
    },
  },
];

export const TOOLS: Tool[] = [...readTools, ...writeTools];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const getTool = (name: string): Tool | undefined => BY_NAME.get(name);

export const toolDefinitions = (): ToolDefinition[] =>
  TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.jsonSchema },
  }));

// Validate model-supplied arguments before anything touches the database. The
// model is untrusted input: it hallucinates field names, invents ids, and
// occasionally sends a string where an array belongs.
export function parseToolArgs(tool: Tool, raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw badRequest(`${tool.name} was called with arguments that aren't valid JSON`);
  }
  const result = tool.parameters.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw badRequest(`${tool.name} was called with invalid arguments — ${detail}`);
  }
  return result.data;
}
