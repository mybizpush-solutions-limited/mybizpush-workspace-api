import { Op } from "sequelize";
import { CLOSED_TASK_STATUSES, Task } from "../../models";
import { redis } from "../../redis/client";
import { notify } from "../../modules/shared/events";
import { assigneeIdsOf } from "../../modules/tasks/tasks.service";
import { registerJob, registerSchedule } from "../workers";

// Deadline reminders (P2). Runs hourly. Each task gets one "due soon" and one
// "overdue" reminder per due date; moving the date allows new ones.

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_SECONDS = 60 * 24 * 60 * 60;

async function firstTime(taskId: string, kind: "soon" | "overdue", due: Date): Promise<boolean> {
  const ok = await redis.set(`task:deadline:${taskId}:${kind}:${due.getTime()}`, "1", "EX", TTL_SECONDS, "NX");
  return ok === "OK";
}

registerJob("reminders", "task-deadlines", async () => {
  const now = new Date();
  const open = { [Op.notIn]: [...CLOSED_TASK_STATUSES, "draft"] };

  const soon = await Task.findAll({ where: { status: open, dueDate: { [Op.gte]: now, [Op.lt]: new Date(now.getTime() + DAY_MS) } }, attributes: ["id", "title", "dueDate", "reporterId"] });
  for (const task of soon) {
    if (!(await firstTime(task.id, "soon", task.dueDate!))) continue;
    for (const userId of await assigneeIdsOf(task.id)) {
      await notify({ userId, fromUserId: null, kind: "deadline", itemId: task.id, itemType: "task", message: `Due within a day: ${task.title}` });
    }
  }

  const overdue = await Task.findAll({ where: { status: open, dueDate: { [Op.lt]: now } }, attributes: ["id", "title", "dueDate", "reporterId"] });
  for (const task of overdue) {
    if (!(await firstTime(task.id, "overdue", task.dueDate!))) continue;
    const people = new Set(await assigneeIdsOf(task.id));
    if (task.reporterId) people.add(task.reporterId);
    for (const userId of people) {
      await notify({ userId, fromUserId: null, kind: "deadline", itemId: task.id, itemType: "task", message: `Overdue: ${task.title}` });
    }
  }
});

registerSchedule("reminders", "task-deadlines", "5 * * * *");
