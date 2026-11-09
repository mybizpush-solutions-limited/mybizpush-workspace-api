import { Emitter } from "@socket.io/redis-emitter";
import Redis from "ioredis";
import { env } from "../config/env";

// Server-to-client events and how to send them. Uses the Redis emitter, so it
// works from the API, a separate worker process, or a script alike: anything
// that can reach Redis can reach every connected client.

export const userRoom = (userId: string) => `user:${userId}`;

// Event names and payloads the app listens for. Keep in sync with app/src/realtime.
export interface ServerEvents {
  // A new in-app notification for this user (same shape as GET /notifications).
  "notification:new": { notification: Record<string, unknown> };
  // Tab bar and home badge counts. Sent whenever one may have changed.
  badges: { notifications: number };
  // Records in these collections changed: the app runs a sync pull (A006).
  "sync:changed": { collections: string[] };
}

let emitter: Emitter | null = null;
let connection: Redis | null = null;

function getEmitter(): Emitter {
  if (!emitter) {
    connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    emitter = new Emitter(connection);
  }
  return emitter;
}

// Fire-and-forget: realtime is a hint layered on top of the API. A missed event
// is recovered by the app's next sync, so failures are logged, never thrown.
export function emitToUser<E extends keyof ServerEvents>(userId: string, event: E, payload: ServerEvents[E]): void {
  try {
    getEmitter().to(userRoom(userId)).emit(event, payload);
  } catch (err) {
    console.error(`[realtime] ${event} to ${userId} failed`, err);
  }
}

export async function closeEmitter(): Promise<void> {
  await connection?.quit().catch(() => undefined);
  connection = null;
  emitter = null;
}
