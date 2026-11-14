import { Router } from "express";
import { asyncHandler, badRequest, notFound } from "../../lib/errors";
import { requireAccessLevel, requireAuth } from "../../middleware/auth";
import { enqueue, getQueue, QUEUE_NAMES, type QueueName } from "../../jobs";

// Operational view of background jobs for admins: queue health, recent
// failures, retry. Keeps failed integrations observable (PRD 25, Reliability).
export const jobsRouter = Router();
jobsRouter.use(requireAuth, requireAccessLevel("admin", "chief"));

function queueParam(value: unknown): QueueName {
  const name = String(value ?? "");
  if (!(QUEUE_NAMES as readonly string[]).includes(name)) throw badRequest(`Unknown queue: ${name}`);
  return name as QueueName;
}

jobsRouter.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const queues = await Promise.all(
      QUEUE_NAMES.map(async (name) => {
        const counts = await getQueue(name).getJobCounts("waiting", "active", "delayed", "failed", "completed");
        return { name, ...counts };
      }),
    );
    res.json({ queues });
  }),
);

jobsRouter.get(
  "/failed",
  asyncHandler(async (req, res) => {
    const queue = queueParam(req.query.queue);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const jobs = await getQueue(queue).getFailed(0, limit - 1);
    res.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        attemptsMade: j.attemptsMade,
        failedReason: j.failedReason,
        finishedOn: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
      })),
    });
  }),
);

jobsRouter.post(
  "/:queue/:id/retry",
  asyncHandler(async (req, res) => {
    const job = await getQueue(queueParam(req.params.queue)).getJob(String(req.params.id));
    if (!job) throw notFound("Job not found");
    await job.retry();
    res.status(202).json({ ok: true });
  }),
);

// Health check for the whole pipeline: enqueue a no-op job.
jobsRouter.post(
  "/ping",
  asyncHandler(async (req, res) => {
    await enqueue("maintenance", "ping", { requestedBy: req.auth!.email });
    res.status(202).json({ ok: true });
  }),
);
