import {
  Attachment,
  Comment,
  GithubIssueLink,
  Label,
  Project,
  PullRequest,
  User,
  type Activity,
  type ItemType,
  type Issue,
  type Meeting,
  type Notification,
  type NotificationPreference,
  type Task,
} from "../../models";

const iso = (d: Date | null | undefined): string | undefined => (d ? d.toISOString() : undefined);

// ---- Project --------------------------------------------------------------
export function serializeProject(p: Project) {
  const members = (p.get("members") as User[] | undefined) ?? [];
  return {
    id: p.id,
    departmentId: p.departmentId,
    name: p.name,
    description: p.description,
    managerId: p.managerId ?? null,
    memberIds: members.map((m) => m.id),
    progress: p.progress,
    avatarUrl: p.avatarUrl ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

// ---- Attachment / PullRequest --------------------------------------------
export function serializeAttachment(a: Attachment) {
  return { id: a.id, name: a.name, size: Number(a.size), type: a.type, url: a.url };
}

export function serializePullRequest(pr: PullRequest) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    status: pr.status,
    authorId: pr.authorId ?? null,
    checkState: pr.checkState ?? null,
    reviewDecision: pr.reviewDecision ?? null,
  };
}

// ---- Work item (task | issue) --------------------------------------------
export function serializeWorkItem(item: Task | Issue, type: ItemType) {
  const assignees = (item.get("assignees") as User[] | undefined) ?? [];
  const labels = (item.get("labels") as Label[] | undefined) ?? [];
  const attachments = (item.get("attachments") as Attachment[] | undefined) ?? [];
  const pullRequests = (item.get("pullRequests") as PullRequest[] | undefined) ?? [];
  const githubIssue = item.get("githubIssue") as GithubIssueLink | undefined;

  const base = {
    id: item.id,
    type,
    projectId: item.projectId,
    title: item.title,
    description: item.description,
    status: item.status,
    priority: item.priority,
    assigneeIds: assignees.map((u) => u.id),
    reporterId: item.reporterId ?? null,
    labelIds: labels.map((l) => l.id),
    attachments: attachments.map(serializeAttachment),
    pullRequests: pullRequests.map(serializePullRequest),
    githubIssue: githubIssue
      ? {
          number: githubIssue.number,
          url: githubIssue.url,
          repoFullName: githubIssue.fullName,
          state: githubIssue.state,
        }
      : null,
    feedback: {
      awaitingFrom: item.feedbackAwaitingFrom ?? null,
      requestedById: item.feedbackRequestedBy ?? undefined,
      requestedAt: iso(item.feedbackRequestedAt),
    },
    dueDate: iso(item.dueDate),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
  if (type === "issue") {
    return { ...base, severity: (item as Issue).severity ?? undefined };
  }
  return base;
}

// ---- Label ----------------------------------------------------------------
export function serializeLabel(l: Label) {
  return { id: l.id, name: l.name, color: l.color };
}

// ---- Comment --------------------------------------------------------------
export function serializeComment(c: Comment) {
  const mentions = (c.get("mentions") as User[] | undefined) ?? [];
  return {
    id: c.id,
    itemId: c.itemId,
    itemType: c.itemType,
    authorId: c.authorId ?? null,
    body: c.body,
    mentions: mentions.map((m) => m.id),
    createdAt: c.createdAt.toISOString(),
  };
}

// ---- Activity -------------------------------------------------------------
export function serializeActivity(a: Activity) {
  return {
    id: a.id,
    itemId: a.itemId,
    itemType: a.itemType,
    actorId: a.actorId ?? null,
    kind: a.kind,
    data: a.data ?? undefined,
    createdAt: a.createdAt.toISOString(),
  };
}

// ---- Notification ---------------------------------------------------------
export function serializeNotification(n: Notification) {
  return {
    id: n.id,
    userId: n.userId,
    kind: n.kind,
    itemId: n.itemId,
    itemType: n.itemType,
    fromUserId: n.fromUserId ?? null,
    message: n.message,
    read: n.read,
    createdAt: n.createdAt.toISOString(),
  };
}

// ---- Meeting --------------------------------------------------------------
export function serializeMeeting(m: Meeting) {
  const attendees = (m.get("attendees") as User[] | undefined) ?? [];
  return {
    id: m.id,
    title: m.title,
    description: m.description ?? undefined,
    attendeeIds: attendees.map((u) => u.id),
    organizerId: m.organizerId ?? null,
    startsAt: m.startsAt.toISOString(),
    endsAt: m.endsAt.toISOString(),
    meetUrl: m.meetUrl,
  };
}

// ---- Notification preferences (mirrors UI's nested channel shape) ---------
export function serializePreferences(p: NotificationPreference) {
  return {
    userId: p.userId,
    channels: {
      meetingReminders: p.meetingReminders,
      pendingTasks: p.pendingTasks,
      feedbackRequests: p.feedbackRequests,
      mentions: p.mentions,
      events: p.events,
    },
    digestFrequency: p.digestFrequency,
  };
}

// Shared includes for loading a work item with everything the UI needs.
export const workItemInclude = [
  { model: User, as: "assignees", attributes: ["id"], through: { attributes: [] } },
  { model: Label, as: "labels", attributes: ["id"], through: { attributes: [] } },
  { model: Attachment, as: "attachments" },
  { model: PullRequest, as: "pullRequests" },
  { model: GithubIssueLink, as: "githubIssue", required: false },
];
