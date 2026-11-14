// Content workflow (API-CHANGES A603, PRD 16). Pure, and sent to the app.

export const CONTENT_STATUSES = ["idea", "briefed", "in_progress", "in_design", "in_review", "revision_required", "approved", "scheduled", "published", "cancelled"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export type ContentActor = "writer" | "designer" | "reviewer" | "manager";
export type ContentVia = "status" | "review" | "publish";

export interface ContentTransition {
  from: ContentStatus;
  to: ContentStatus;
  actors: ContentActor[];
  via: ContentVia;
}

const MAKERS: ContentActor[] = ["writer", "designer", "manager"];
const t = (from: ContentStatus, to: ContentStatus, actors: ContentActor[], via: ContentVia = "status"): ContentTransition => ({ from, to, actors, via });

export const CONTENT_TRANSITIONS: ContentTransition[] = [
  t("idea", "briefed", ["manager", "writer"]),
  t("idea", "cancelled", ["manager"]),
  t("briefed", "in_progress", MAKERS),
  t("briefed", "cancelled", ["manager"]),
  t("in_progress", "in_design", MAKERS),
  t("in_progress", "in_review", MAKERS),
  t("in_progress", "cancelled", ["manager"]),
  t("in_design", "in_progress", MAKERS),
  t("in_design", "in_review", MAKERS),
  t("in_design", "cancelled", ["manager"]),
  t("in_review", "approved", ["reviewer"], "review"),
  t("in_review", "revision_required", ["reviewer"], "review"),
  t("revision_required", "in_progress", MAKERS),
  t("revision_required", "in_design", MAKERS),
  t("revision_required", "in_review", MAKERS),
  t("revision_required", "cancelled", ["manager"]),
  t("approved", "scheduled", ["manager", "reviewer"]),
  t("approved", "published", ["manager"], "publish"),
  t("approved", "in_progress", ["manager"]),
  t("approved", "cancelled", ["manager"]),
  t("scheduled", "published", ["manager"], "publish"),
  t("scheduled", "approved", ["manager", "reviewer"]),
  t("scheduled", "cancelled", ["manager"]),
  t("cancelled", "idea", ["manager"]),
];

const ENDPOINT_ONLY: Partial<Record<ContentStatus, ContentVia>> = { approved: "review", revision_required: "review", published: "publish" };

export type ContentDecision = { allowed: true } | { allowed: false; code: "invalid_transition" | "not_allowed_transition" | "use_endpoint"; message: string };

export function decideContentMove(input: { from: ContentStatus; to: ContentStatus; roles: ReadonlySet<ContentActor>; via?: ContentVia }): ContentDecision {
  const via = input.via ?? "status";
  if (input.from === input.to) return { allowed: true };
  const endpoint = ENDPOINT_ONLY[input.to];
  // "Back to approved" from scheduled is a plain move, not a new decision.
  if (endpoint && via !== endpoint && !(input.from === "scheduled" && input.to === "approved")) {
    return { allowed: false, code: "use_endpoint", message: `Use the ${endpoint} action to move this to ${input.to}` };
  }
  const match = CONTENT_TRANSITIONS.find((x) => x.from === input.from && x.to === input.to && x.via === via);
  if (!match) return { allowed: false, code: "invalid_transition", message: `Content can't move from ${input.from} to ${input.to}` };
  if (!match.actors.some((a) => input.roles.has(a))) return { allowed: false, code: "not_allowed_transition", message: `You can't move this from ${input.from} to ${input.to}` };
  return { allowed: true };
}

const LABELS: Record<ContentStatus, string> = {
  idea: "Idea",
  briefed: "Briefed",
  in_progress: "In progress",
  in_design: "In design",
  in_review: "In review",
  revision_required: "Revision required",
  approved: "Approved",
  scheduled: "Scheduled",
  published: "Published",
  cancelled: "Cancelled",
};

export const contentWorkflow = () => ({ statuses: CONTENT_STATUSES.map((key) => ({ key, label: LABELS[key] })), transitions: CONTENT_TRANSITIONS });
