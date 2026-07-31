import { randomUUID } from "node:crypto";
import { redis } from "../../redis/client";
import { badRequest, forbidden, notFound } from "../../lib/errors";

// A write the model proposed, held until the person approves it.
//
// The arguments live in Redis rather than being handed to the browser and sent
// back on confirm. If the client supplied them, anyone could approve a card that
// says "add a comment" while posting arguments that reassign someone else's
// work — the confirmation would be describing a different action than the one
// that runs. Here the client only ever names an id it cannot forge, and the
// staged entry is bound to the user who created it.
export interface PendingAction {
  id: string;
  tool: string;
  /** Validated arguments, exactly as the tool will receive them. */
  args: unknown;
  /** The one-line description shown on the confirmation card. */
  preview: string;
  userId: string;
}

/** What the client sees — never the arguments. */
export type PendingActionView = Pick<PendingAction, "id" | "tool" | "preview">;

const TTL_SECONDS = 15 * 60;
const key = (id: string) => `ai:action:${id}`;

export async function stageAction(
  input: Omit<PendingAction, "id">,
): Promise<PendingAction> {
  const action: PendingAction = { ...input, id: randomUUID() };
  await redis.set(key(action.id), JSON.stringify(action), "EX", TTL_SECONDS);
  return action;
}

// Fetch and delete in one step: an approved action must run at most once, so a
// double-click can't post the same comment twice.
export async function claimAction(actionId: string, userId: string): Promise<PendingAction> {
  const raw = await redis.get(key(actionId));
  if (!raw) throw notFound("That action expired or was already run");

  let action: PendingAction;
  try {
    action = JSON.parse(raw) as PendingAction;
  } catch {
    await redis.del(key(actionId));
    throw badRequest("That action is no longer readable");
  }

  if (action.userId !== userId) throw forbidden("That action belongs to someone else");
  await redis.del(key(actionId));
  return action;
}

export async function discardAction(actionId: string, userId: string): Promise<void> {
  const raw = await redis.get(key(actionId));
  if (!raw) return; // already gone — nothing to cancel

  let owner: string | undefined;
  try {
    owner = (JSON.parse(raw) as PendingAction).userId;
  } catch {
    await redis.del(key(actionId)); // unreadable and unrunnable — just drop it
    return;
  }
  if (owner !== userId) throw forbidden("That action belongs to someone else");
  await redis.del(key(actionId));
}

export const toView = (a: PendingAction): PendingActionView => ({
  id: a.id,
  tool: a.tool,
  preview: a.preview,
});
