import { z } from "zod";

// The operations voice and text commands can start (API-CHANGES A801). One entry
// per operation: the form fields the app shows, and the schema a confirmed command
// must pass before it runs. Pure, with no database.

export type FieldType =
  | "text" | "longtext" | "datetime" | "date" | "number" | "boolean" | "choice"
  | "staff" | "staff[]" | "product" | "project" | "department" | "team" | "group[]" | "conversation" | "audience" | "task" | "scope";

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: readonly string[];
  future?: boolean; // a date in the past is invalid
  contextKey?: "productId" | "projectId" | "departmentId" | "teamId"; // fills from where the user is
  scopeFrom?: string; // for type "scope": the field naming what kind of record this is
  // Required only when another field has one of these values.
  requiredWhen?: { field: string; notIn: readonly string[] };
}

export interface OperationDef {
  key: string;
  label: string;
  description: string; // for the model
  consequential: boolean;
  permission: string;
  fields: FieldDef[];
  schema: z.ZodTypeAny;
}

const uuid = z.string().uuid();
const iso = z.string().datetime();
const PRIORITY = ["low", "medium", "high", "urgent"] as const;
const SCOPES = ["organization", "department", "team", "product", "project"] as const;
const OWNER_TYPES = ["user", "team", "department", "product", "project"] as const;
const AUDIENCES = ["organization", "department", "team", "product", "project", "users"] as const;
const groupRef = z.object({ type: z.enum(["team", "department", "product", "project"]), id: uuid });

export const OPERATIONS: OperationDef[] = [
  {
    key: "create_task",
    label: "Create task",
    description: "Create or assign a piece of work",
    consequential: false,
    permission: "task.create",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "description", label: "Description", type: "longtext" },
      { name: "projectId", label: "Project", type: "project", required: true, contextKey: "projectId" },
      { name: "assigneeIds", label: "Assignee", type: "staff[]" },
      { name: "reviewerId", label: "Reviewer", type: "staff" },
      { name: "priority", label: "Priority", type: "choice", options: PRIORITY },
      { name: "dueDate", label: "Due", type: "datetime", future: true },
      { name: "startDate", label: "Start", type: "datetime" },
      { name: "productId", label: "Product", type: "product", contextKey: "productId" },
      { name: "teamId", label: "Team", type: "team", contextKey: "teamId" },
      { name: "expectedDeliverable", label: "Expected deliverable", type: "longtext" },
    ],
    schema: z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(8000).optional(),
      projectId: uuid,
      assigneeIds: z.array(uuid).max(50).optional(),
      reviewerId: uuid.optional(),
      priority: z.enum(PRIORITY).optional(),
      dueDate: iso.optional(),
      startDate: iso.optional(),
      productId: uuid.optional(),
      teamId: uuid.optional(),
      expectedDeliverable: z.string().trim().max(4000).optional(),
    }),
  },
  {
    key: "update_task_status",
    label: "Update task",
    description: "Change the status of an existing task",
    consequential: false,
    permission: "task.submit",
    fields: [
      { name: "taskId", label: "Task", type: "task", required: true },
      { name: "status", label: "Status", type: "choice", required: true, options: ["todo", "assigned", "accepted", "in_progress", "blocked", "in_review", "done", "cancelled"] },
      { name: "note", label: "Note", type: "longtext" },
    ],
    schema: z.object({ taskId: uuid, status: z.enum(["todo", "assigned", "accepted", "in_progress", "blocked", "in_review", "done", "cancelled"]), note: z.string().trim().max(2000).optional() }),
  },
  {
    key: "schedule_meeting",
    label: "Schedule meeting",
    description: "Book a meeting with people or groups",
    consequential: true,
    permission: "meeting.create",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "startsAt", label: "When", type: "datetime", required: true, future: true },
      { name: "durationMinutes", label: "Duration in minutes", type: "number" },
      { name: "attendeeIds", label: "People", type: "staff[]" },
      { name: "groups", label: "Groups", type: "group[]" },
      { name: "type", label: "Type", type: "choice", options: ["standup", "one_on_one", "review", "planning", "client", "training", "all_hands", "other"] },
      { name: "location", label: "Location", type: "text" },
      { name: "agendaText", label: "Agenda", type: "longtext" },
      { name: "meetLink", label: "Meet link", type: "boolean" },
    ],
    schema: z.object({
      title: z.string().trim().min(1).max(200),
      startsAt: iso,
      durationMinutes: z.number().int().min(1).max(1440).optional(),
      attendeeIds: z.array(uuid).max(500).optional(),
      groups: z.array(groupRef).max(20).optional(),
      type: z.enum(["standup", "one_on_one", "review", "planning", "client", "training", "all_hands", "other"]).optional(),
      location: z.string().trim().max(300).optional(),
      agendaText: z.string().trim().max(4000).optional(),
      meetLink: z.boolean().optional(),
    }),
  },
  {
    key: "create_event",
    label: "Add calendar event",
    description: "A calendar entry that isn't a meeting, such as a holiday or launch",
    consequential: false,
    permission: "event.create",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "scopeType", label: "For", type: "choice", required: true, options: SCOPES },
      { name: "scopeId", label: "Which one", type: "scope", scopeFrom: "scopeType", requiredWhen: { field: "scopeType", notIn: ["organization"] } },
      { name: "startsAt", label: "Starts", type: "datetime", required: true },
      { name: "endsAt", label: "Ends", type: "datetime" },
      { name: "allDay", label: "All day", type: "boolean" },
      { name: "location", label: "Location", type: "text" },
    ],
    schema: z.object({ title: z.string().trim().min(1).max(200), scopeType: z.enum(SCOPES), scopeId: uuid.optional(), startsAt: iso, endsAt: iso.optional(), allDay: z.boolean().optional(), location: z.string().trim().max(300).optional() }),
  },
  {
    key: "send_message",
    label: "Send message",
    description: "Send a chat message to people or a channel",
    consequential: true,
    permission: "message.send",
    fields: [
      { name: "recipientIds", label: "To", type: "staff[]" },
      { name: "conversationId", label: "Channel", type: "conversation" },
      { name: "body", label: "Message", type: "longtext", required: true },
    ],
    schema: z
      .object({ recipientIds: z.array(uuid).max(50).optional(), conversationId: uuid.optional(), body: z.string().trim().min(1).max(20000) })
      .refine((v) => !!v.conversationId || !!v.recipientIds?.length, { message: "Say who this goes to", path: ["recipientIds"] }),
  },
  {
    key: "announce",
    label: "Publish announcement",
    description: "Announce something to a group or the whole company",
    consequential: true,
    permission: "announcement.draft",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "body", label: "Body", type: "longtext", required: true },
      { name: "audience", label: "Audience", type: "audience", required: true },
      { name: "requireAck", label: "Require acknowledgement", type: "boolean" },
      { name: "publishAt", label: "Publish at", type: "datetime", future: true },
      { name: "expiresAt", label: "Expires", type: "datetime", future: true },
    ],
    schema: z.object({
      title: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(20000),
      audience: z.object({ type: z.enum(AUDIENCES), ids: z.array(uuid).max(500).optional() }),
      requireAck: z.boolean().optional(),
      publishAt: iso.optional(),
      expiresAt: iso.optional(),
    }),
  },
  {
    key: "issue_query",
    label: "Issue staff query",
    description: "Issue a formal HR query to a staff member",
    consequential: true,
    permission: "query.issue",
    fields: [
      { name: "staffId", label: "Staff member", type: "staff", required: true },
      { name: "category", label: "Category", type: "choice", required: true, options: ["attendance", "conduct", "performance", "policy", "other"] },
      { name: "subject", label: "Subject", type: "text", required: true },
      { name: "body", label: "Details", type: "longtext", required: true },
      { name: "deadlineAt", label: "Respond by", type: "datetime", required: true, future: true },
    ],
    schema: z.object({ staffId: uuid, category: z.enum(["attendance", "conduct", "performance", "policy", "other"]), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20000), deadlineAt: iso }),
  },
  {
    key: "create_target",
    label: "Create target",
    description: "Set a measurable target for a person or group",
    consequential: false,
    permission: "target.create",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "ownerType", label: "Owner type", type: "choice", required: true, options: OWNER_TYPES },
      { name: "ownerId", label: "Owner", type: "scope", required: true, scopeFrom: "ownerType" },
      { name: "targetValue", label: "Target value", type: "number", required: true },
      { name: "unit", label: "Unit", type: "choice", options: ["count", "percent", "currency", "hours", "custom"] },
      { name: "period", label: "Period", type: "choice", options: ["month", "quarter", "year", "custom"] },
      { name: "startDate", label: "Starts", type: "date", required: true },
      { name: "endDate", label: "Ends", type: "date", required: true },
    ],
    schema: z.object({
      name: z.string().trim().min(1).max(200),
      ownerType: z.enum(OWNER_TYPES),
      ownerId: uuid,
      targetValue: z.number().finite(),
      unit: z.enum(["count", "percent", "currency", "hours", "custom"]).optional(),
      period: z.enum(["month", "quarter", "year", "custom"]).optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  },
];

export const operationByKey = (key: string) => OPERATIONS.find((o) => o.key === key);

export const describeOperations = () =>
  OPERATIONS.map(({ key, label, consequential, permission, fields }) => ({ key, label, consequential, permission, fields: fields.map(({ contextKey: _c, future: _f, ...f }) => f) }));
