// Task statuses (API-CHANGES A201). No imports, so pure code and tests can use
// them without loading the database layer. The first five are the original
// values the web app knows; issues still only use those.
export const LEGACY_STATUSES = ["todo", "in_progress", "in_review", "blocked", "done"] as const;
export type LegacyStatus = (typeof LEGACY_STATUSES)[number];

export const TASK_STATUSES = [
  ...LEGACY_STATUSES,
  "draft",
  "assigned",
  "accepted",
  "submitted",
  "revision_required",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// Task lists that mean "still work to do" compare against this, never just "done".
export const CLOSED_TASK_STATUSES: TaskStatus[] = ["done", "approved", "rejected", "cancelled"];
export const REVIEW_TASK_STATUSES: TaskStatus[] = ["submitted", "in_review"];
export const OPEN_TASK_STATUSES: TaskStatus[] = ["todo", "assigned", "accepted", "in_progress", "blocked", "revision_required"];
