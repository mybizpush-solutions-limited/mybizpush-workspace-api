import { Worker, type Job } from "bullmq";
import { createJobConnection, QUEUE_NAMES, type QueueName } from "./queues";

// Job handlers register here by queue and job name; startWorkers() runs one
// BullMQ worker per queue that dispatches to them. Feature modules call
// registerJob() at import time (see src/jobs/index.ts).

export type JobHandler<T = unknown> = (data: T, job: Job) => Promise<void>;

const handlers = new Map<string, JobHandler>();
const key = (queue: QueueName, name: string) => `${queue}:${name}`;

export function registerJob<T>(queue: QueueName, name: string, handler: JobHandler<T>): void {
  handlers.set(key(queue, name), handler as JobHandler);
}

// Concurrency per queue: pushes and email are I/O bound and cheap; imports and
// exports are heavy, so they run one or two at a time.
const CONCURRENCY: Record<QueueName, number> = {
  push: 10,
  email: 5,
  imports: 1,
  exports: 2,
  reminders: 5,
  maintenance: 1,
};

let running: Worker[] = [];

export function startWorkers(): void {
  if (running.length) return;
  running = QUEUE_NAMES.map((queue) => {
    const worker = new Worker(
      queue,
      async (job) => {
        const handler = handlers.get(key(queue, job.name));
        // Unknown job names fail loudly so they show up in /jobs/failed instead
        // of being silently dropped.
        if (!handler) throw new Error(`No handler registered for ${queue}:${job.name}`);
        await handler(job.data, job);
      },
      { connection: createJobConnection(), concurrency: CONCURRENCY[queue] },
    );
    worker.on("failed", (job, err) => {
      const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
      console.error(`[jobs] ${queue}:${job?.name} ${job?.id} failed${final ? " (giving up)" : ""}:`, err.message);
    });
    worker.on("error", (err) => console.error(`[jobs] ${queue} worker error:`, err.message));
    return worker;
  });
  console.info(`✓ Job workers running (${QUEUE_NAMES.join(", ")})`);
}

export async function stopWorkers(): Promise<void> {
  await Promise.allSettled(running.map((w) => w.close()));
  running = [];
}
