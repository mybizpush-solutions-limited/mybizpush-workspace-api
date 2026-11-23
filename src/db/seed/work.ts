import { Activity, Comment, Issue, Task, TaskReview, TaskStatusHistory, TaskSubmission, type Priority, type TaskStatus } from "../../models";
import { setAssociation, type SeedContext } from "./context";
import { PROJECTS, type ProjectSpec } from "./data";
import { addMinutes, dayAt, earliest, hash, minutesAgo, now, pick } from "./time";

const STATUS_CYCLE: TaskStatus[] = [
  "in_progress", "assigned", "submitted", "done", "todo", "in_progress", "approved",
  "blocked", "accepted", "revision_required", "in_progress", "done", "assigned", "approved",
];

const PATHS: Record<string, TaskStatus[]> = {
  todo: ["todo"],
  assigned: ["assigned"],
  accepted: ["assigned", "accepted"],
  in_progress: ["assigned", "accepted", "in_progress"],
  blocked: ["assigned", "in_progress", "blocked"],
  submitted: ["assigned", "in_progress", "submitted"],
  revision_required: ["assigned", "in_progress", "submitted", "revision_required"],
  approved: ["assigned", "in_progress", "submitted", "approved"],
  done: ["assigned", "in_progress", "done"],
};

const OPEN_DUE_OFFSETS = [-3, -1, 0, 0, 1, 2, 3, 4, 7, 8, 9, 11, 14];
const PRIORITIES: Priority[] = ["medium", "high", "medium", "low", "urgent", "high", "medium"];

const BLOCKERS = [
  "Waiting on gateway sandbox credentials from the partner",
  "Needs final copy from marketing before we can ship",
  "Blocked by the Android build failing on CI",
  "Waiting for legal to sign off on the wording",
];

const ASSIGNEE_COMMENTS = [
  "Started on this. First pass should be up for review by tomorrow.",
  "Pushed a draft. The edge cases around empty states still need work.",
  "Quick question: do we support the old flow too or only the new one?",
  "Tested on a Tecno and an iPhone 12, both look fine now.",
  "Linked the doc with the details. Happy to walk anyone through it.",
  "This is bigger than estimated. Splitting the second half into a follow up.",
];

const MANAGER_COMMENTS = [
  "Thanks. Please keep the scope tight, we can iterate after launch.",
  "Looks good overall. Can you add a short note on how to test it?",
  "Let's pair on this after standup if it is still stuck.",
  "Priority bumped, customers have been asking about this.",
  "Please loop in Uche for QA before submitting.",
];

const REVISION_FEEDBACK = "Close. Please handle the error state and add screenshots of the final version.";

function dueFor(status: TaskStatus, seed: string): Date | null {
  if (status === "done" || status === "approved") return dayAt(-1 - (hash(seed) % 10), "17:00");
  if (status === "blocked") return dayAt(-2, "17:00");
  if (status === "submitted") return dayAt(hash(seed) % 3, "17:00");
  if (status === "revision_required") return dayAt(1, "17:00");
  if (hash(`${seed}:nodue`) % 9 === 0) return null;
  return dayAt(pick(OPEN_DUE_OFFSETS, seed), "17:00");
}

function assigneesFor(spec: ProjectSpec, index: number): string[] {
  const pool = spec.members.length ? spec.members : [spec.manager];
  const first = pool[index % pool.length]!;
  const second = pool[(index + 2) % pool.length]!;
  return index % 5 === 0 && second !== first ? [first, second] : [first];
}

export async function seedTasks(ctx: SeedContext): Promise<void> {
  let counter = 0;
  for (const spec of PROJECTS) {
    const project = ctx.project(spec.name);
    for (const [index, title] of spec.tasks.entries()) {
      const status = STATUS_CYCLE[counter % STATUS_CYCLE.length]!;
      counter += 1;
      const assigneeKeys = status === "todo" && index % 2 === 0 ? [] : assigneesFor(spec, index);
      const needsReviewer = ["submitted", "revision_required", "approved"].includes(status) || index % 3 === 0;
      const reviewerKey = needsReviewer ? (assigneeKeys.includes(spec.manager) ? "sam" : spec.manager) : null;
      const dueDate = dueFor(status, title);
      const createdAt = earliest(dayAt(-(12 + (hash(title) % 18)), "10:00"), dueDate ? addMinutes(dueDate, -10 * 24 * 60) : now);

      const [task, created] = await Task.findOrCreate({
        where: { title, projectId: project.id },
        defaults: {
          projectId: project.id,
          departmentId: project.departmentId ?? null,
          productId: project.productId ?? null,
          title,
          description: `${title}. Part of ${spec.name}.`,
          status,
          priority: pick(PRIORITIES, `${title}:priority`),
          reporterId: ctx.id(spec.manager),
          reviewerId: reviewerKey ? ctx.id(reviewerKey) : null,
          dueDate,
          startDate: createdAt,
          expectedDeliverable: status === "todo" ? "" : "Working build or document linked in the task, reviewed by the project manager.",
          blockedReason: status === "blocked" ? pick(BLOCKERS, title) : null,
          revisionCount: status === "revision_required" ? 1 : 0,
          createdAt,
        },
      });
      const assigneeIds = ctx.ids(assigneeKeys);
      if (created) {
        await setAssociation(task, "setAssignees", assigneeIds);
        const label = ctx.labels.get(pick(spec.labels, `${title}:label`));
        if (label) await setAssociation(task, "setLabels", [label.id]);
        await recordWorkflow(ctx, task, spec, assigneeKeys, reviewerKey, createdAt);
        await addComments(ctx, task, spec, assigneeKeys, index);
      }
      ctx.tasks.push({ task, project, assigneeIds: created ? assigneeIds : await assigneeIdsOf(task) });
    }
  }
}

async function assigneeIdsOf(task: Task): Promise<string[]> {
  const rows = await (task as unknown as { getAssignees(o: object): Promise<{ id: string }[]> }).getAssignees({ attributes: ["id"] });
  return rows.map((u) => u.id);
}

async function recordWorkflow(ctx: SeedContext, task: Task, spec: ProjectSpec, assigneeKeys: string[], reviewerKey: string | null, createdAt: Date): Promise<void> {
  const manager = ctx.id(spec.manager);
  const worker = assigneeKeys[0] ? ctx.id(assigneeKeys[0]) : manager;
  const path = PATHS[task.status] ?? [task.status];
  const end = earliest(minutesAgo(90 + (hash(task.title) % 600)), task.dueDate ? addMinutes(task.dueDate, -120) : now);
  const span = Math.max(end.getTime() - createdAt.getTime(), 60 * 60_000);
  const stepAt = (i: number) => new Date(createdAt.getTime() + (span * (i + 1)) / (path.length + 1));

  await Activity.create({ itemId: task.id, itemType: "task", actorId: manager, kind: "created", data: null, createdAt });
  await TaskStatusHistory.create({ taskId: task.id, fromStatus: null, toStatus: path[0]!, actorId: manager, createdAt });
  let from = path[0]!;
  for (const [i, to] of path.slice(1).entries()) {
    const at = stepAt(i);
    const actor = to === "approved" || to === "revision_required" ? ctx.id(reviewerKey ?? spec.manager) : worker;
    await TaskStatusHistory.create({ taskId: task.id, fromStatus: from, toStatus: to, actorId: actor, note: to === "blocked" ? task.blockedReason : null, createdAt: at });
    await Activity.create({ itemId: task.id, itemType: "task", actorId: actor, kind: "status_changed", data: { from, to }, createdAt: at });
    from = to;
  }

  const submittedIndex = path.indexOf("submitted");
  if (submittedIndex < 0) {
    if (task.status === "done") await task.update({ completedAt: stepAt(path.length - 2) });
    return;
  }
  const submittedAt = stepAt(submittedIndex - 1);
  const reviewerId = ctx.id(reviewerKey ?? spec.manager);
  const decided = task.status === "approved" || task.status === "revision_required";
  const submission = await TaskSubmission.create({
    taskId: task.id,
    round: 1,
    submittedBy: worker,
    reviewerId,
    notes: "Ready for review. Summary of changes and how to test are in the linked doc.",
    links: [{ title: "Review notes", url: "https://docs.mybizpush.com/reviews" }],
    evidence: [{ label: "Tested on staging", done: true }, { label: "Screenshots attached", done: task.status === "approved" }],
    status: task.status === "approved" ? "approved" : task.status === "revision_required" ? "revision_required" : "pending",
    createdAt: submittedAt,
  });
  await Activity.create({ itemId: task.id, itemType: "task", actorId: worker, kind: "submitted", data: { submissionId: submission.id }, createdAt: submittedAt });
  if (!decided) {
    await task.update({ submittedAt });
    return;
  }
  const reviewedAt = stepAt(path.length - 2);
  await TaskReview.create({
    taskId: task.id,
    submissionId: submission.id,
    reviewerId,
    decision: task.status === "approved" ? "approve" : "request_revision",
    feedback: task.status === "approved" ? "Approved. Nice work." : REVISION_FEEDBACK,
    createdAt: reviewedAt,
  });
  await Activity.create({ itemId: task.id, itemType: "task", actorId: reviewerId, kind: "reviewed", data: { decision: task.status }, createdAt: reviewedAt });
  await task.update({ submittedAt, reviewedAt, ...(task.status === "approved" ? { completedAt: reviewedAt } : {}) });
}

async function addComments(ctx: SeedContext, task: Task, spec: ProjectSpec, assigneeKeys: string[], index: number): Promise<void> {
  if (index % 3 !== 0 || !assigneeKeys[0]) return;
  const thread = [
    { author: assigneeKeys[0], body: pick(ASSIGNEE_COMMENTS, task.title) },
    ...(index % 2 === 0 ? [{ author: spec.manager, body: pick(MANAGER_COMMENTS, task.title) }] : []),
  ];
  for (const [i, c] of thread.entries()) {
    const at = minutesAgo(60 * 24 * (2 - i) + (hash(`${task.title}:${i}`) % 300));
    const comment = await Comment.create({ itemId: task.id, itemType: "task", authorId: ctx.id(c.author), body: c.body, createdAt: at });
    await Activity.create({ itemId: task.id, itemType: "task", actorId: ctx.id(c.author), kind: "commented", data: { commentId: comment.id }, createdAt: at });
  }
}

export async function seedIssues(ctx: SeedContext): Promise<void> {
  const specs = [
    { project: "Public API", title: "401 returns inconsistent body", status: "todo" as const, priority: "high" as const, severity: "major" as const, reporter: "sam", assignees: ["ngozi"] },
    { project: "Platform", title: "Dock overlaps content on iPhone SE", status: "todo" as const, priority: "high" as const, severity: "minor" as const, reporter: "kola", assignees: ["femi"] },
    { project: "Edge Deploy Pipeline", title: "Build logs cut off after 10,000 lines", status: "in_progress" as const, priority: "medium" as const, severity: "minor" as const, reporter: "uche", assignees: ["halima"] },
    { project: "Workspace Mobile App", title: "Chat badge count stays after reading on web", status: "todo" as const, priority: "medium" as const, severity: "minor" as const, reporter: "uche", assignees: ["zainab"] },
  ];
  for (const spec of specs) {
    const [issue, created] = await Issue.findOrCreate({
      where: { title: spec.title },
      defaults: {
        projectId: ctx.project(spec.project).id,
        title: spec.title,
        status: spec.status,
        priority: spec.priority,
        severity: spec.severity,
        reporterId: ctx.id(spec.reporter),
      },
    });
    if (created) await setAssociation(issue, "setAssignees", ctx.ids(spec.assignees));
  }
}
