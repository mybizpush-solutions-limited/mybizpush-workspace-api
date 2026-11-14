import { z } from "zod";
import { TASK_STATUSES } from "../../models/task-status";
import { REVIEW_DECISIONS } from "../../models";
import { GROUP_TYPES } from "../groups/groups.merge";

const uuid = z.string().uuid();
const groupRef = z.object({ type: z.enum(GROUP_TYPES), id: uuid });

// A task can start in these. Submitted and decided states are only reached
// through their own actions, so that a record exists.
const INITIAL = z.enum(["draft", "todo", "assigned", "in_progress", "in_review", "blocked", "done"]);

export const taskCreateFields = {
  id: uuid.optional(),
  status: INITIAL.optional(),
  reviewerId: uuid.nullable().optional(),
  productId: uuid.nullable().optional(),
  teamId: uuid.nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  expectedDeliverable: z.string().trim().max(4000).optional(),
  templateId: uuid.nullable().optional(),
  dependsOnIds: z.array(uuid).max(50).optional(),
  assignGroups: z.array(groupRef).max(20).optional(),
  sourceType: z.string().trim().max(30).nullable().optional(),
  sourceId: z.string().trim().max(80).nullable().optional(),
};

export const taskUpdateFields = {
  reviewerId: uuid.nullable().optional(),
  productId: uuid.nullable().optional(),
  teamId: uuid.nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  expectedDeliverable: z.string().trim().max(4000).optional(),
  dependsOnIds: z.array(uuid).max(50).optional(),
  assignGroups: z.array(groupRef).max(20).optional(),
};

export const taskStatusSchema = z.object({
  status: z.enum(TASK_STATUSES),
  note: z.string().trim().max(2000).optional(),
  blockedReason: z.string().trim().max(500).optional(),
});

export const submitSchema = z
  .object({
    id: uuid.optional(),
    notes: z.string().trim().max(8000).optional(),
    links: z.array(z.object({ title: z.string().trim().max(200).optional(), url: z.string().url().max(2000) })).max(20).optional(),
    evidence: z.array(z.object({ label: z.string().trim().min(1).max(200), done: z.boolean() })).max(30).optional(),
    attachmentIds: z.array(uuid).max(30).optional(),
  })
  .refine((v) => !!v.notes || !!v.links?.length || !!v.attachmentIds?.length, { message: "Add notes, a link or a file" });
export type SubmitInput = z.infer<typeof submitSchema>;

export const reviewSchema = z
  .object({
    id: uuid.optional(),
    decision: z.enum(REVIEW_DECISIONS),
    feedback: z.string().trim().max(4000).optional(),
    newReviewerId: uuid.optional(),
    submissionId: uuid.optional(),
  })
  .refine((v) => !(v.decision === "reject" || v.decision === "request_revision") || !!v.feedback, { message: "Feedback is required", path: ["feedback"] })
  .refine((v) => v.decision !== "reassign" || !!v.newReviewerId, { message: "Pick the new reviewer", path: ["newReviewerId"] });
export type ReviewInput = z.infer<typeof reviewSchema>;

const csv = <T extends [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)));

export const listQuerySchema = z.object({
  segment: z.enum(["mine", "review", "created", "all"]).optional(),
  status: csv([...TASK_STATUSES] as [string, ...string[]]).optional(),
  priority: csv(["low", "medium", "high", "urgent"]).optional(),
  projectId: uuid.optional(),
  departmentId: uuid.optional(),
  assigneeId: uuid.optional(),
  reviewerId: uuid.optional(),
  productId: uuid.optional(),
  teamId: uuid.optional(),
  dueFrom: z.string().datetime().optional(),
  dueTo: z.string().datetime().optional(),
  overdue: z.enum(["true", "false"]).optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type TaskListQuery = z.infer<typeof listQuerySchema>;

const templateFields = {
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(8000).optional(),
  expectedDeliverable: z.string().trim().max(4000).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullable().optional(),
  productId: uuid.nullable().optional(),
  projectId: uuid.nullable().optional(),
  departmentId: uuid.nullable().optional(),
  reviewerId: uuid.nullable().optional(),
  defaultDueDays: z.number().int().min(0).max(365).nullable().optional(),
  checklist: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  labelIds: z.array(uuid).max(20).optional(),
};
export const templateCreateSchema = z.object({ id: uuid.optional(), name: z.string().trim().min(1).max(120), ...templateFields });
export const templateUpdateSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), ...templateFields });

export const reportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  productId: uuid.optional(),
  projectId: uuid.optional(),
  departmentId: uuid.optional(),
  teamId: uuid.optional(),
  assigneeId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  format: z.enum(["xlsx", "csv"]).optional(),
});
export type TaskReportQuery = z.infer<typeof reportQuerySchema>;
