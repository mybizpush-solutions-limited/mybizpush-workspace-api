import { Queue, type JobsOptions } from "bullmq";
import Redis from "ioredis";
import { env } from "../config/env";

// Background jobs (API-CHANGES A005). Every slow or retryable piece of work
// (push, email, imports, exports, reminders) goes through a BullMQ queue on the
// same Redis the API already uses, so failures retry with backoff and stay
// visible instead of disappearing inside a request or a cron tick.

export const QUEUE_NAMES = ["push", "email", "imports", "exports", "reminders", "maintenance"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

// BullMQ needs its own connections (blocking commands) with retries disabled
// per request, so it never shares the API's general-purpose client.
export function createJobConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 }, // 5s, 10s, 20s, 40s, 80s
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 }, // keep a day of history
  removeOnFail: { age: 14 * 24 * 60 * 60 }, // keep failures two weeks for review
};

let producerConnection: Redis | null = null;
const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    producerConnection ??= createJobConnection();
    queue = new Queue(name, { connection: producerConnection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    queues.set(name, queue);
  }
  return queue;
}

// Add a job. `jobId` makes it idempotent: enqueueing the same id twice while the
// first is still known to BullMQ is a no-op (used to deduplicate pushes per event).
export async function enqueue<T extends object>(
  queue: QueueName,
  name: string,
  data: T,
  options: JobsOptions & { jobId?: string } = {},
): Promise<void> {
  await getQueue(queue).add(name, data, options);
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
  await producerConnection?.quit().catch(() => undefined);
  producerConnection = null;
}
