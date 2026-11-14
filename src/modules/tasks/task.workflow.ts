import { LEGACY_STATUSES, TASK_STATUSES, type LegacyStatus, type TaskStatus } from "../../models/task-status";

// Task transition rules (API-CHANGES A201, PRD 7.4). Pure so they can be unit
// tested and sent to the app, which needs them to show allowed moves offline.

export type TaskActor = "assignee" | "reviewer" | "reporter" | "manager";
export type TransitionVia = "status" | "submit" | "review";

export interface Transition {
  from: TaskStatus;
  to: TaskStatus;
  actors: TaskActor[];
  via: TransitionVia;
}

const STAFF: TaskActor[] = ["reporter", "manager"];
const WORKER: TaskActor[] = ["assignee", "manager"];
const ANYONE_ON_IT: TaskActor[] = ["assignee", "reporter", "manager"];

const rule = (from: TaskStatus, to: TaskStatus, actors: TaskActor[], via: TransitionVia = "status"): Transition => ({ from, to, actors, via });
const decisions = (from: TaskStatus): Transition[] => [
  rule(from, "approved", ["reviewer"], "review"),
  rule(from, "rejected", ["reviewer"], "review"),
  rule(from, "revision_required", ["reviewer"], "review"),
];

export const TRANSITIONS: Transition[] = [
  rule("draft", "todo", STAFF),
  rule("draft", "assigned", STAFF),
  rule("draft", "cancelled", STAFF),

  rule("todo", "assigned", STAFF),
  rule("todo", "accepted", ["assignee"]),
  rule("todo", "in_progress", ANYONE_ON_IT),
  rule("todo", "blocked", ANYONE_ON_IT),
  rule("todo", "submitted", WORKER, "submit"),
  rule("todo", "cancelled", STAFF),

  rule("assigned", "accepted", ["assignee"]),
  rule("assigned", "in_progress", WORKER),
  rule("assigned", "blocked", WORKER),
  rule("assigned", "todo", STAFF),
  rule("assigned", "submitted", WORKER, "submit"),
  rule("assigned", "cancelled", STAFF),

  rule("accepted", "in_progress", WORKER),
  rule("accepted", "blocked", WORKER),
  rule("accepted", "submitted", WORKER, "submit"),
  rule("accepted", "cancelled", STAFF),

  rule("in_progress", "blocked", ANYONE_ON_IT),
  rule("in_progress", "submitted", WORKER, "submit"),
  rule("in_progress", "in_review", ["reviewer", "manager"]),
  rule("in_progress", "todo", STAFF),
  rule("in_progress", "cancelled", STAFF),

  rule("blocked", "in_progress", ANYONE_ON_IT),
  rule("blocked", "todo", STAFF),
  rule("blocked", "assigned", STAFF),
  rule("blocked", "cancelled", STAFF),

  rule("submitted", "in_review", ["reviewer"]),
  rule("submitted", "in_progress", WORKER), // withdraw the submission
  ...decisions("submitted"),

  rule("in_review", "in_progress", ["reviewer", "manager"]),
  ...decisions("in_review"),

  rule("revision_required", "in_progress", WORKER),
  rule("revision_required", "blocked", WORKER),
  rule("revision_required", "submitted", WORKER, "submit"),
  rule("revision_required", "cancelled", STAFF),

  rule("approved", "done", ["reviewer", "reporter", "manager"]),
  rule("approved", "in_progress", ["manager"]),

  rule("rejected", "in_progress", STAFF),
  rule("rejected", "assigned", STAFF),
  rule("rejected", "cancelled", STAFF),

  rule("done", "in_progress", STAFF),
  rule("done", "todo", STAFF),

  rule("cancelled", "todo", STAFF),
  rule("cancelled", "assigned", STAFF),
];

// These can only be reached through their own endpoints, so every decision and
// submission leaves a record.
const ENDPOINT_ONLY: Partial<Record<TaskStatus, TransitionVia>> = {
  submitted: "submit",
  approved: "review",
  rejected: "review",
  revision_required: "review",
};

const isLegacy = (s: TaskStatus): s is LegacyStatus => (LEGACY_STATUSES as readonly string[]).includes(s);

export type TransitionDecision =
  | { allowed: true; via: TransitionVia }
  | { allowed: false; code: "invalid_transition" | "not_allowed_transition" | "use_endpoint"; message: string };

export function decideTransition(input: {
  from: TaskStatus;
  to: TaskStatus;
  roles: ReadonlySet<TaskActor>;
  hasReviewer: boolean;
  via?: TransitionVia;
}): TransitionDecision {
  const { from, to, roles, hasReviewer } = input;
  const via = input.via ?? "status";
  if (from === to) return { allowed: true, via };

  const endpoint = ENDPOINT_ONLY[to];
  if (endpoint && via !== endpoint) {
    return { allowed: false, code: "use_endpoint", message: `Use the ${endpoint} action to move a task to ${to}` };
  }
  // Tasks without a reviewer keep the free movement the web app relies on.
  if (via === "status" && !hasReviewer && isLegacy(from) && isLegacy(to)) return { allowed: true, via };

  const match = TRANSITIONS.find((t) => t.from === from && t.to === to && t.via === via);
  if (!match) return { allowed: false, code: "invalid_transition", message: `A task can't move from ${from} to ${to}` };
  if (!match.actors.some((a) => roles.has(a))) {
    return { allowed: false, code: "not_allowed_transition", message: `You can't move this task from ${from} to ${to}` };
  }
  return { allowed: true, via };
}

// What the Change status sheet offers (TASK-06).
export function allowedMoves(from: TaskStatus, roles: ReadonlySet<TaskActor>, hasReviewer: boolean): { status: TaskStatus; via: TransitionVia }[] {
  const moves = new Map<TaskStatus, TransitionVia>();
  for (const t of TRANSITIONS) {
    if (t.from === from && t.actors.some((a) => roles.has(a))) moves.set(t.to, t.via);
  }
  if (!hasReviewer && isLegacy(from)) {
    for (const s of LEGACY_STATUSES) if (s !== from) moves.set(s, "status");
  }
  return [...moves].map(([status, via]) => ({ status, via }));
}

// The closest original value, for clients that only understand those five.
export function legacyStatusOf(status: TaskStatus): LegacyStatus {
  switch (status) {
    case "draft":
    case "assigned":
    case "accepted":
      return "todo";
    case "revision_required":
      return "in_progress";
    case "submitted":
      return "in_review";
    case "approved":
    case "rejected":
    case "cancelled":
      return "done";
    default:
      return status;
  }
}

const LABELS: Record<TaskStatus, string> = {
  draft: "Draft",
  todo: "To do",
  assigned: "Assigned",
  accepted: "Accepted",
  in_progress: "In progress",
  blocked: "Blocked",
  submitted: "Submitted",
  in_review: "In review",
  revision_required: "Revision required",
  approved: "Approved",
  rejected: "Rejected",
  done: "Done",
  cancelled: "Cancelled",
};

export function statusGroup(status: TaskStatus): "draft" | "open" | "review" | "closed" {
  if (status === "draft") return "draft";
  if (status === "submitted" || status === "in_review") return "review";
  if (status === "approved" || status === "rejected" || status === "done" || status === "cancelled") return "closed";
  return "open";
}

export const workflowDescription = () => ({
  statuses: TASK_STATUSES.map((key) => ({ key, label: LABELS[key], group: statusGroup(key) })),
  transitions: TRANSITIONS,
  legacyFree: LEGACY_STATUSES,
});

// Would making `taskId` wait for `dependsOnId` create a loop? `edges` maps a task
// to the tasks it already waits for.
export function wouldCreateCycle(edges: ReadonlyMap<string, readonly string[]>, taskId: string, dependsOnId: string): boolean {
  if (taskId === dependsOnId) return true;
  const stack = [dependsOnId];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(edges.get(current) ?? []));
  }
  return false;
}
