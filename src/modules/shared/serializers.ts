import {
  Attachment,
  Comment,
  Department,
  DocumentationLink,
  GithubIssueLink,
  Label,
  Project,
  PullRequest,
  User,
  type Activity,
  type ItemType,
  type Issue,
  type Meeting,
  type MeetingAttendee,
  type Notification,
  type NotificationPreference,
  type Task,
  type TaskGroupAssignment,
  type TaskReview,
  type TaskStatusHistory,
  type TaskSubmission,
  type TaskTemplate,
} from "../../models";
import { Task as TaskModel, TaskGroupAssignment as TaskGroupAssignmentModel } from "../../models";
import { legacyStatusOf } from "../tasks/task.workflow";

const iso = (d: Date | null | undefined): string | undefined => (d ? d.toISOString() : undefined);

// ---- Project --------------------------------------------------------------
// A project is worked on by many departments (the "lanes"). The people on it are
// derived: the manager plus everyone in the involved departments.
export function serializeProject(p: Project) {
  const departments = (p.get("departments") as Department[] | undefined) ?? [];
  const guests = (p.get("members") as User[] | undefined) ?? []; // explicit guests
  const memberSet = new Set<string>();
  if (p.managerId) memberSet.add(p.managerId);
  for (const d of departments) {
    for (const m of (d.get("members") as User[] | undefined) ?? []) memberSet.add(m.id);
  }
  for (const g of guests) memberSet.add(g.id);
  return {
    id: p.id,
    departmentId: p.departmentId ?? null, // legacy "home" department
    departmentIds: departments.map((d) => d.id), // involved departments (lanes)
    name: p.name,
    description: p.description,
    techStack: p.techStack ?? "",
    managerId: p.managerId ?? null,
    productId: p.productId ?? null, // A101
    memberIds: [...memberSet], // everyone: PM + involved-dept members + guests
    guestIds: guests.map((g) => g.id), // individuals added on top of the departments
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

export function serializeDoc(doc: DocumentationLink) {
  return { id: doc.id, title: doc.title, url: doc.url, addedBy: doc.addedBy ?? null };
}

// ---- Work item (task | issue) --------------------------------------------
export function serializeWorkItem(item: Task | Issue, type: ItemType) {
  const assignees = (item.get("assignees") as User[] | undefined) ?? [];
  const labels = (item.get("labels") as Label[] | undefined) ?? [];
  const attachments = (item.get("attachments") as Attachment[] | undefined) ?? [];
  const pullRequests = (item.get("pullRequests") as PullRequest[] | undefined) ?? [];
  const docs = (item.get("docs") as DocumentationLink[] | undefined) ?? [];
  const githubIssue = item.get("githubIssue") as GithubIssueLink | undefined;

  const base = {
    id: item.id,
    type,
    projectId: item.projectId,
    departmentId: item.departmentId ?? null,
    title: item.title,
    description: item.description,
    status: item.status,
    priority: item.priority,
    assigneeIds: assignees.map((u) => u.id),
    reporterId: item.reporterId ?? null,
    labelIds: labels.map((l) => l.id),
    attachments: attachments.map(serializeAttachment),
    pullRequests: pullRequests.map(serializePullRequest),
    docs: docs.map(serializeDoc),
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
  const task = item as Task;
  const groups = (task.get("groupAssignments") as TaskGroupAssignment[] | undefined) ?? [];
  return {
    ...base,
    legacyStatus: legacyStatusOf(task.status),
    reviewerId: task.reviewerId ?? null,
    productId: task.productId ?? null,
    teamId: task.teamId ?? null,
    startDate: task.startDate?.toISOString() ?? null,
    expectedDeliverable: task.expectedDeliverable ?? "",
    templateId: task.templateId ?? null,
    blockedReason: task.blockedReason ?? null,
    dependsOnIds: ((task.get("dependencies") as Task[] | undefined) ?? []).map((d) => d.id),
    groupAssignments: groups.map((g) => ({ id: g.id, type: g.groupType, groupId: g.groupId, userIds: g.userIds })),
    revisionCount: task.revisionCount ?? 0,
    submittedAt: task.submittedAt?.toISOString() ?? null,
    reviewedAt: task.reviewedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    sourceType: task.sourceType ?? null,
    sourceId: task.sourceId ?? null,
  };
}

export function serializeTaskSubmission(s: TaskSubmission) {
  return {
    id: s.id,
    taskId: s.taskId,
    round: s.round,
    submittedBy: s.submittedBy ?? null,
    reviewerId: s.reviewerId ?? null,
    notes: s.notes,
    links: s.links,
    evidence: s.evidence,
    attachmentIds: s.attachmentIds,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function serializeTaskReview(r: TaskReview) {
  return {
    id: r.id,
    taskId: r.taskId,
    submissionId: r.submissionId ?? null,
    reviewerId: r.reviewerId ?? null,
    decision: r.decision,
    feedback: r.feedback,
    newReviewerId: r.newReviewerId ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function serializeTaskStatusHistory(h: TaskStatusHistory) {
  return {
    id: h.id,
    taskId: h.taskId,
    fromStatus: h.fromStatus ?? null,
    toStatus: h.toStatus,
    actorId: h.actorId ?? null,
    note: h.note ?? null,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}

export function serializeTaskTemplate(t: TaskTemplate) {
  return {
    id: t.id,
    name: t.name,
    title: t.title,
    description: t.description,
    expectedDeliverable: t.expectedDeliverable,
    priority: t.priority ?? null,
    productId: t.productId ?? null,
    projectId: t.projectId ?? null,
    departmentId: t.departmentId ?? null,
    reviewerId: t.reviewerId ?? null,
    defaultDueDays: t.defaultDueDays ?? null,
    checklist: t.checklist,
    labelIds: t.labelIds,
    createdBy: t.createdBy ?? null,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
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
    data: n.data ?? null,
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
    externalEmails: m.externalEmails ?? [],
    organizerId: m.organizerId ?? null,
    startsAt: m.startsAt.toISOString(),
    endsAt: m.endsAt.toISOString(),
    meetUrl: m.meetUrl,
    recurrence: m.recurrence ?? null,
    type: m.type,
    scopeType: m.scopeType ?? null,
    scopeId: m.scopeId ?? null,
    status: m.status,
    locationType: m.locationType,
    location: m.location ?? null,
    hasMeetLink: m.hasMeetLink,
    agenda: m.agenda ?? [],
    reminderMinutes: m.reminderMinutes ?? [],
    groups: m.groups ?? [],
    cancelReason: m.cancelReason ?? null,
    cancelledAt: m.cancelledAt?.toISOString() ?? null,
    syncState: m.syncState,
    updatedAt: m.updatedAt.toISOString(),
  };
}

export function serializeMeetingAttendee(a: MeetingAttendee) {
  return {
    id: a.id,
    meetingId: a.meetingId,
    userId: a.userId,
    rsvp: a.rsvp,
    rsvpNote: a.rsvpNote ?? null,
    respondedAt: a.respondedAt?.toISOString() ?? null,
    attendance: a.attendance,
    attendanceMarkedBy: a.attendanceMarkedBy ?? null,
    updatedAt: a.updatedAt.toISOString(),
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
  { model: DocumentationLink, as: "docs" },
  { model: GithubIssueLink, as: "githubIssue", required: false },
];

// Tasks also carry their dependencies and group assignments.
export const taskInclude = [
  ...workItemInclude,
  { model: TaskModel, as: "dependencies", attributes: ["id"], through: { attributes: [] } },
  { model: TaskGroupAssignmentModel, as: "groupAssignments" },
];
