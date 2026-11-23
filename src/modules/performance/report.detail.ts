import { Op, type WhereOptions } from "sequelize";
import { CLOSED_TASK_STATUSES, ContentItem, Meeting, MeetingAttendee, Project, Task, User } from "../../models";

// The "what was actually done" half of a report: named work items and plain-language
// highlights, so a reader sees the work and not only counts. Built only from rows the
// caller already scoped, so it can't widen what a report shows.

type Range = { from: Date; to: Date };

const LIST_LIMIT = 40;
const DONE_TASK = ["done", "approved"];
const DONE_CONTENT = ["approved", "scheduled", "published"];

const day = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const human = (value: string) => value.replace(/_/g, " ");

function listNames(names: string[], max = 3) {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= max) return unique.join(", ").replace(/, ([^,]*)$/, " and $1");
  return `${unique.slice(0, max).join(", ")} and ${unique.length - max} more`;
}

export async function workDetail(where: WhereOptions, range: Range) {
  const now = new Date();
  const projectName = (t: Task) => (t.get("Project") as Project | null)?.name ?? "";
  const include = [{ model: Project, attributes: ["id", "name"] }];

  const [completed, open] = await Promise.all([
    Task.findAll({ where: { [Op.and]: [where, { status: DONE_TASK, completedAt: { [Op.between]: [range.from, range.to] } }] }, include, order: [["completedAt", "DESC"]], limit: LIST_LIMIT }),
    Task.findAll({ where: { [Op.and]: [where, { status: { [Op.notIn]: CLOSED_TASK_STATUSES }, createdAt: { [Op.lte]: range.to } }] }, include, order: [["dueDate", "ASC"]], limit: LIST_LIMIT * 2 }),
  ]);
  const overdue = open.filter((t) => t.dueDate && new Date(t.dueDate) < now);
  const inProgress = open.filter((t) => !overdue.includes(t));

  return {
    completedWork: completed.map((t) => ({ id: t.id, itemType: "task", task: t.title, project: projectName(t), completedOn: day(t.completedAt) })),
    inProgressWork: inProgress.slice(0, LIST_LIMIT).map((t) => ({ id: t.id, itemType: "task", task: t.title, project: projectName(t), status: human(t.status), due: day(t.dueDate ? new Date(t.dueDate) : null) })),
    overdueWork: overdue.slice(0, LIST_LIMIT).map((t) => ({ id: t.id, itemType: "task", task: t.title, project: projectName(t), due: day(t.dueDate ? new Date(t.dueDate) : null) })),
    projects: [...new Set(completed.map(projectName))],
  };
}

// Designs, videos and posts a person delivered, from the content plan.
export async function creativeOutput(userId: string, range: Range, productIds?: string[]) {
  const items = await ContentItem.findAll({
    where: {
      [Op.or]: [{ writerId: userId }, { designerId: userId }],
      status: DONE_CONTENT,
      updatedAt: { [Op.between]: [range.from, range.to] },
      ...(productIds ? { productId: productIds } : {}),
    },
    order: [["updatedAt", "DESC"]],
    limit: 200,
  });
  const designs = items.filter((i) => i.designerId === userId);
  const written = items.filter((i) => i.writerId === userId);
  const published = items.filter((i) => i.status === "published");
  const byPlatform = new Map<string, number>();
  for (const item of published) byPlatform.set(item.platform ?? "other", (byPlatform.get(item.platform ?? "other") ?? 0) + 1);

  return {
    totals: {
      designsDelivered: designs.filter((i) => i.type !== "video").length,
      videosDelivered: designs.filter((i) => i.type === "video").length + written.filter((i) => i.type === "video" && i.designerId !== userId).length,
      piecesWritten: written.length,
      postsPublished: published.length,
    },
    byPlatform: [...byPlatform].map(([platform, posts]) => ({ platform, posts })),
    items: items.slice(0, LIST_LIMIT).map((i) => ({
      id: i.id,
      itemType: "content",
      title: i.title,
      type: human(i.type),
      role: i.designerId === userId && i.writerId === userId ? "writer and designer" : i.designerId === userId ? "designer" : "writer",
      platform: i.platform ?? "",
      status: human(i.status),
      date: day(i.publishedAt ?? i.updatedAt),
    })),
  };
}

export async function meetingsAttended(userId: string, range: Range) {
  const rows = await MeetingAttendee.findAll({ where: { userId, attendance: ["present", "late"] }, attributes: ["meetingId"] });
  if (!rows.length) return [];
  const meetings = await Meeting.findAll({
    where: { id: rows.map((row) => row.meetingId), startsAt: { [Op.between]: [range.from, range.to] }, status: { [Op.ne]: "cancelled" } },
    attributes: ["id", "title", "startsAt"],
    order: [["startsAt", "DESC"]],
    limit: LIST_LIMIT,
  });
  return meetings.map((m) => ({ id: m.id, itemType: "meeting", meeting: m.title, date: day(m.startsAt) }));
}

type TaskTotals = { created?: number; completed?: number; overdue?: number; open?: number };

export function staffHighlights(input: {
  name: string;
  tasks: TaskTotals;
  work: Awaited<ReturnType<typeof workDetail>>;
  creative: Awaited<ReturnType<typeof creativeOutput>> | null;
  meetings: { invited: number; attended: number };
  approvals: { reviewed: number; avgHours: number | null };
  targets?: { total?: number; achieved?: number } | null;
}) {
  const { work, creative, meetings, approvals } = input;
  const lines: string[] = [];
  const first = input.name.split(" ")[0] ?? input.name;
  const done = work.completedWork.length;
  if (done) {
    const examples = work.completedWork.slice(0, 3).map((w) => w.task);
    lines.push(`${first} completed ${plural(done, "task")}${work.projects.length ? ` across ${listNames(work.projects)}` : ""}, including ${listNames(examples)}.`);
  } else {
    lines.push(`${first} has no completed tasks in this period.`);
  }
  if (work.inProgressWork.length) lines.push(`${plural(work.inProgressWork.length, "task")} in progress, such as ${listNames(work.inProgressWork.slice(0, 2).map((w) => w.task))}.`);
  if (work.overdueWork.length) lines.push(`${plural(work.overdueWork.length, "task")} overdue: ${listNames(work.overdueWork.map((w) => w.task))}.`);
  if (creative) {
    const t = creative.totals;
    const parts = [
      t.designsDelivered ? plural(t.designsDelivered, "design") : "",
      t.videosDelivered ? plural(t.videosDelivered, "video") : "",
      t.piecesWritten ? `${plural(t.piecesWritten, "piece")} written` : "",
      t.postsPublished ? `${plural(t.postsPublished, "post")} published` : "",
    ].filter(Boolean);
    if (parts.length) {
      const platforms = creative.byPlatform.map((p) => `${p.posts} on ${p.platform}`);
      lines.push(`Creative output: ${listNames(parts, 4)}${platforms.length ? ` (${listNames(platforms, 4)})` : ""}.`);
    }
  }
  if (meetings.invited) lines.push(`Attended ${meetings.attended} of ${plural(meetings.invited, "meeting")}.`);
  if (approvals.reviewed) lines.push(`Reviewed ${plural(approvals.reviewed, "submission")}${approvals.avgHours !== null ? `, answering in about ${approvals.avgHours} hours on average` : ""}.`);
  if (input.targets?.total) lines.push(`Met ${input.targets.achieved ?? 0} of ${plural(input.targets.total, "target")}.`);
  return lines.map((summary) => ({ summary }));
}

export function teamHighlights(label: string, tasks: TaskTotals, work: Awaited<ReturnType<typeof workDetail>>) {
  const lines: string[] = [];
  const done = work.completedWork.length;
  lines.push(done ? `${label} completed ${plural(done, "task")}, including ${listNames(work.completedWork.slice(0, 3).map((w) => w.task))}.` : `${label} has no completed tasks in this period.`);
  if (tasks.created) lines.push(`${plural(tasks.completed ?? 0, "task")} completed out of ${tasks.created} worked on (${Math.round(((tasks.completed ?? 0) / tasks.created) * 100)} percent).`);
  if (work.inProgressWork.length) lines.push(`${plural(work.inProgressWork.length, "task")} in progress.`);
  if (work.overdueWork.length) lines.push(`${plural(work.overdueWork.length, "task")} overdue, the oldest being ${work.overdueWork[0]!.task} (due ${work.overdueWork[0]!.due}).`);
  return lines.map((summary) => ({ summary }));
}

export async function nameOf(userId: string) {
  return (await User.findByPk(userId, { attributes: ["name"] }))?.name ?? "This person";
}
