import { Conversation, ConversationMember, Message, MessageReaction, User, type MemberRole } from "../../models";
import { directKeyOf, previewOf } from "../../modules/chat/chat.meta";
import { groupsService } from "../../modules/groups/groups.service";
import type { SeedContext } from "./context";
import { CHANNELS, DIRECTS, type ChannelSpec, type ScriptLine } from "./conversations";
import { addMinutes, clock, dayAt, earliest, hash, minutesAgo, workingDaysBack } from "./time";

interface TimedMessage {
  at: Date;
  from: string;
  body: string;
  mentions: string[];
  reactions: Record<string, string[]>;
  parent?: number;
}

// Spreads a script over the last working days, inside office hours, and never in the future.
function timeline(script: ScriptLine[], spanDays: number): TimedMessage[] {
  const days = workingDaysBack(spanDays);
  const perDay = new Map<number, number>();
  const dayOf = script.map((_, i) => days[Math.floor((i * days.length) / script.length)]!);
  for (const d of dayOf) perDay.set(d, (perDay.get(d) ?? 0) + 1);
  const seen = new Map<number, number>();
  const out: TimedMessage[] = [];

  script.forEach((l, i) => {
    const day = dayOf[i]!;
    const slot = seen.get(day) ?? 0;
    seen.set(day, slot + 1);
    const count = perDay.get(day)!;
    const minutes = 8 * 60 + 40 + ((slot + 1) * 9 * 60) / (count + 1) + (hash(l.body) % 20);
    const at = earliest(dayAt(day, clock(minutes)), minutesAgo((count - slot) * 6));
    const index = out.push({ at, from: l.from, body: l.body, mentions: l.mentions ?? [], reactions: l.reactions ?? {} }) - 1;
    (l.replies ?? []).forEach(([from, body], r) => {
      out.push({ at: earliest(addMinutes(at, (r + 1) * 7), minutesAgo(1)), from, body, mentions: [], reactions: {}, parent: index });
    });
  });
  return out;
}

async function membersOf(ctx: SeedContext, spec: ChannelSpec): Promise<{ fromScope: string[]; manual: string[] }> {
  const manual = new Set(ctx.ids([spec.owner, ...(spec.moderators ?? []), ...(spec.members ?? []), ...spec.script.flatMap((l) => [l.from, ...(l.replies ?? []).map(([f]) => f)])]));
  let fromScope: string[] = [];
  if (spec.scope === "organization") fromScope = (await User.findAll({ where: { status: "active" }, attributes: ["id"] })).map((u) => u.id);
  else if (spec.scope !== "private") fromScope = await groupsService.expandIds([{ type: spec.scope, id: scopeIdOf(ctx, spec)! }]);
  return { fromScope: fromScope.filter((id) => !manual.has(id)), manual: [...manual] };
}

function scopeIdOf(ctx: SeedContext, spec: ChannelSpec): string | null {
  if (!spec.scopeRef) return null;
  if (spec.scope === "department") return ctx.department(spec.scopeRef).id;
  if (spec.scope === "team") return ctx.team(spec.scopeRef).id;
  if (spec.scope === "product") return ctx.product(spec.scopeRef).id;
  if (spec.scope === "project") return ctx.project(spec.scopeRef).id;
  return null;
}

async function writeMessages(ctx: SeedContext, conversation: Conversation, timed: TimedMessage[]): Promise<Message[]> {
  const sorted = timed.map((m, i) => ({ m, i })).sort((a, b) => a.m.at.getTime() - b.m.at.getTime());
  const created = new Map<number, Message>();
  for (const { m, i } of sorted) {
    const parent = m.parent !== undefined ? created.get(m.parent) : undefined;
    const message = await Message.create({
      conversationId: conversation.id,
      senderId: ctx.id(m.from),
      type: "text",
      body: m.body,
      meta: {},
      parentId: parent?.id ?? null,
      mentions: ctx.ids(m.mentions),
      createdAt: m.at,
    });
    created.set(i, message);
    if (parent) {
      await parent.update({
        threadReplyCount: parent.threadReplyCount + 1,
        threadLastReplyAt: m.at,
        threadParticipantIds: [...new Set([...parent.threadParticipantIds, ctx.id(m.from)])],
      });
    }
    for (const [emoji, people] of Object.entries(m.reactions)) {
      await MessageReaction.bulkCreate(ctx.ids(people).map((userId) => ({ messageId: message.id, userId, emoji })), { ignoreDuplicates: true });
    }
  }
  return sorted.map(({ i }) => created.get(i)!);
}

async function finish(conversation: Conversation, messages: Message[], unread: Record<string, number>, ctx: SeedContext): Promise<void> {
  const topLevel = messages.filter((m) => !m.parentId);
  const last = topLevel[topLevel.length - 1];
  if (!last) return;
  await conversation.update({
    lastSeq: last.seq,
    lastMessageId: last.id,
    lastMessageAt: last.createdAt,
    lastSenderId: last.senderId ?? null,
    lastMessageType: last.type,
    lastPreview: previewOf(last.type, last.body),
  });
  await ConversationMember.update({ lastReadSeq: last.seq, lastReadAt: last.createdAt }, { where: { conversationId: conversation.id } });
  for (const [key, count] of Object.entries(unread)) {
    const othersMessages = topLevel.filter((m) => m.senderId !== ctx.id(key));
    const firstUnread = othersMessages[othersMessages.length - count];
    if (!firstUnread) continue;
    const readUpTo = topLevel.filter((m) => Number(m.seq) < Number(firstUnread.seq)).pop();
    await ConversationMember.update({ lastReadSeq: readUpTo?.seq ?? 0, lastReadAt: readUpTo?.createdAt ?? null }, { where: { conversationId: conversation.id, userId: ctx.id(key) } });
  }
  const memberCount = await ConversationMember.count({ where: { conversationId: conversation.id, leftAt: null } });
  await conversation.update({ memberCount });
}

async function seedChannel(ctx: SeedContext, spec: ChannelSpec): Promise<void> {
  const existing = await Conversation.findOne({ where: { type: "channel", name: spec.name } });
  if (existing) return;
  const timed = timeline(spec.script, spec.spanDays);
  const createdAt = addMinutes(timed[0]!.at, -60 * 24 * 14);
  const conversation = await Conversation.create({
    type: "channel",
    scope: spec.scope,
    scopeId: scopeIdOf(ctx, spec),
    name: spec.name,
    description: spec.description,
    posting: spec.posting ?? "everyone",
    createdBy: ctx.id(spec.owner),
    createdAt,
  });
  const { fromScope, manual } = await membersOf(ctx, spec);
  const roleOf = (id: string): MemberRole => (id === ctx.id(spec.owner) ? "owner" : ctx.ids(spec.moderators ?? []).includes(id) ? "moderator" : "member");
  await ConversationMember.bulkCreate([
    ...fromScope.map((userId) => ({ conversationId: conversation.id, userId, role: "member" as const, source: "scope" as const, createdAt })),
    ...manual.map((userId) => ({ conversationId: conversation.id, userId, role: roleOf(userId), source: "manual" as const, createdAt })),
  ]);
  await Message.create({ conversationId: conversation.id, senderId: ctx.id(spec.owner), type: "system", meta: { event: "created", name: spec.name }, createdAt });
  await finish(conversation, await writeMessages(ctx, conversation, timed), spec.unread ?? {}, ctx);
}

export async function seedChat(ctx: SeedContext): Promise<void> {
  for (const spec of CHANNELS) await seedChannel(ctx, spec);

  for (const spec of DIRECTS) {
    const [a, b] = ctx.ids(spec.between) as [string, string];
    const directKey = directKeyOf(a, b);
    if (await Conversation.findOne({ where: { directKey } })) continue;
    const timed = timeline(spec.script.map(([from, body]) => ({ from, body })), spec.spanDays);
    const createdAt = addMinutes(timed[0]!.at, -5);
    const conversation = await Conversation.create({ type: "direct", directKey, createdBy: ctx.id(spec.script[0]![0]), createdAt });
    await ConversationMember.bulkCreate([a, b].map((userId) => ({ conversationId: conversation.id, userId, notify: "all" as const, createdAt })));
    await finish(conversation, await writeMessages(ctx, conversation, timed), spec.unreadFor ? { [spec.unreadFor]: 1 } : {}, ctx);
  }
}
