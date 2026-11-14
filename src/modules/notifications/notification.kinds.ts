// How notifications are grouped, defaulted and routed (API-CHANGES A304). Pure.

export const CATEGORIES = [
  "assignment", "deadline", "submission", "approval", "mention", "comment", "status",
  "message", "announcement", "meeting", "query", "target", "appraisal", "campaign", "content", "integration",
] as const;
export type Category = (typeof CATEGORIES)[number];

const KIND_CATEGORY: Record<string, Category> = {
  assigned: "assignment",
  reviewer_assigned: "assignment",
  feedback_requested: "assignment",
  deadline: "deadline",
  submitted: "submission",
  approved: "approval",
  rejected: "approval",
  revision_requested: "approval",
  mentioned: "mention",
  commented: "comment",
  status_changed: "status",
  blocked: "status",
  message: "message",
  announcement: "announcement",
  meeting: "meeting",
  query: "query",
  target: "target",
  appraisal: "appraisal",
  campaign: "campaign",
  content: "content",
  integration_failure: "integration",
};
export const categoryOf = (kind: string): Category => KIND_CATEGORY[kind] ?? "status";

export const CATEGORY_LABELS: Record<Category, string> = {
  assignment: "Assignments",
  deadline: "Deadlines",
  submission: "Submissions to review",
  approval: "Approvals",
  mention: "Mentions",
  comment: "Comments",
  status: "Status changes",
  message: "Messages",
  announcement: "Announcements",
  meeting: "Meetings",
  query: "Staff queries",
  target: "Targets",
  appraisal: "Appraisals",
  campaign: "Campaigns",
  content: "Content",
  integration: "Integration problems",
};

export interface Channels {
  inApp: boolean;
  push: boolean;
  email: boolean;
}

// A chat message pushes but doesn't sit in the notification list; everything
// else appears in both. Email stays off unless an older preference turns it on.
export function defaultChannels(category: Category): Channels {
  if (category === "message") return { inApp: false, push: true, email: false };
  return { inApp: true, push: true, email: false };
}

// The web app's older email switches still decide email until the person sets a
// category themselves.
export const LEGACY_EMAIL_FLAG: Partial<Record<Category, "pendingTasks" | "feedbackRequests" | "mentions" | "events" | "meetingReminders">> = {
  assignment: "pendingTasks",
  deadline: "pendingTasks",
  submission: "pendingTasks",
  approval: "pendingTasks",
  mention: "mentions",
  comment: "events",
  status: "events",
  meeting: "meetingReminders",
};
export const LEGACY_EMAIL_DEFAULT = { pendingTasks: true, feedbackRequests: true, mentions: true, events: true, meetingReminders: true } as const;

// HR content never shows on a lock screen.
export const isSensitiveKind = (kind: string) => kind === "query" || kind === "appraisal";

const PLURAL: Record<string, string> = {
  task: "tasks",
  issue: "issues",
  meeting: "meetings",
  announcement: "announcements",
  query: "queries",
  content: "content",
  campaign: "campaigns",
  target: "targets",
  appraisal: "appraisals",
  project: "projects",
  product: "products",
  conversation: "conversations",
};

// Where tapping the push goes. A message opens its conversation.
export function deepLink(itemType: string, itemId: string, data?: Record<string, unknown> | null): string {
  if (itemType === "message" && typeof data?.conversationId === "string") return `mybizpush://conversations/${data.conversationId}`;
  return `mybizpush://${PLURAL[itemType] ?? `${itemType}s`}/${itemId}`;
}

export interface QuietHours {
  enabled: boolean;
  start: string; // HH:MM
  end: string; // HH:MM
  timezone: string;
}

function minutesIn(timezone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return get("hour") * 60 + get("minute");
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes(); // unknown time zone name
  }
}
const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

// Handles ranges that cross midnight (22:00 to 07:00). Start is inside, end isn't.
export function isQuietNow(q: QuietHours, at: Date = new Date()): boolean {
  if (!q.enabled) return false;
  const now = minutesIn(q.timezone, at);
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}
