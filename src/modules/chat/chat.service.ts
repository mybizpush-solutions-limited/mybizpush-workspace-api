import { Op, QueryTypes, type Transaction } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { enqueue } from "../../jobs/queues";
import {
  Attachment,
  Conversation,
  ConversationMember,
  Message,
  MessageReaction,
  User,
  type ChannelScope,
  type MemberNotify,
  type MemberRole,
  type MessageType,
} from "../../models";
import { emitToUser } from "../../realtime/events";
import { can } from "../access/engine";
import type { Scope } from "../access/catalog";
import { reachFor, reachIsEmpty } from "../access/reach";
import type { GroupRef } from "../groups/groups.merge";
import { groupsService } from "../groups/groups.service";
import { notify } from "../shared/events";
import { refreshBadges, syncHint } from "../shared/live";
import { buildMeta, directKeyOf, MessageShapeError, previewOf, toSearchQuery, type MetaAttachment } from "./chat.meta";
import { serializeConversations, serializeMember, serializeMessage, unreadCounts } from "./chat.serialize";

// Conversations, channels and messages (API-CHANGES A301, A302).

const CHAT_COLLECTIONS = ["conversations", "conversationMembers", "messages"];

const withReactions = { include: [{ model: MessageReaction, as: "reactions" }] };

export function scopeOfConversation(c: Conversation): Scope {
  if (!c.scope || c.scope === "organization" || c.scope === "private") return { type: "organization", id: null };
  return { type: c.scope, id: c.scopeId };
}

async function loadConversation(id: string): Promise<Conversation> {
  const c = await Conversation.findByPk(id);
  if (!c) throw notFound("Conversation not found");
  return c;
}

async function activeMember(conversationId: string, userId: string): Promise<ConversationMember | null> {
  return ConversationMember.findOne({ where: { conversationId, userId, leftAt: null } });
}

async function requireMember(conversationId: string, userId: string): Promise<ConversationMember> {
  const m = await activeMember(conversationId, userId);
  if (!m) throw forbidden("You're not in this conversation");
  return m;
}

export async function memberIdsOfConversation(conversationId: string): Promise<string[]> {
  const rows = await ConversationMember.findAll({ where: { conversationId, leftAt: null }, attributes: ["userId"] });
  return rows.map((r) => r.userId);
}

const isStaff = (m: ConversationMember | null) => m?.role === "owner" || m?.role === "moderator";

// Members of a channel's scope right now. Private channels have no scope.
async function scopeMemberIds(scope: ChannelScope | null | undefined, scopeId: string | null | undefined): Promise<string[]> {
  if (!scope || scope === "private") return [];
  if (scope === "organization") return (await User.findAll({ where: { status: "active" }, attributes: ["id"] })).map((u) => u.id);
  if (!scopeId) throw badRequest(`Pick which ${scope} this channel is for`);
  return groupsService.expandIds([{ type: scope, id: scopeId }]);
}

async function refreshMemberCount(conversationId: string, tx?: Transaction): Promise<void> {
  const memberCount = await ConversationMember.count({ where: { conversationId, leftAt: null }, transaction: tx });
  await Conversation.update({ memberCount }, { where: { id: conversationId }, transaction: tx });
}

// Add people, bringing back anyone who left. Returns who is new.
async function addMembers(conversationId: string, userIds: string[], opts: { role?: MemberRole; source?: "scope" | "manual"; notifyLevel?: MemberNotify; lastReadSeq?: string | number; tx?: Transaction } = {}): Promise<string[]> {
  const added: string[] = [];
  for (const userId of new Set(userIds)) {
    const existing = await ConversationMember.findOne({ where: { conversationId, userId }, transaction: opts.tx });
    if (existing && !existing.leftAt) {
      if (opts.role && opts.role !== existing.role) await existing.update({ role: opts.role }, { transaction: opts.tx });
      continue;
    }
    if (existing) {
      await existing.update({ leftAt: null, role: opts.role ?? "member", source: opts.source ?? "manual", lastReadSeq: opts.lastReadSeq ?? existing.lastReadSeq }, { transaction: opts.tx });
    } else {
      await ConversationMember.create(
        { conversationId, userId, role: opts.role ?? "member", source: opts.source ?? "manual", notify: opts.notifyLevel ?? "mentions", lastReadSeq: opts.lastReadSeq ?? 0 },
        { transaction: opts.tx },
      );
    }
    added.push(userId);
  }
  await refreshMemberCount(conversationId, opts.tx);
  return added;
}

async function conversationFor(c: Conversation, viewerId: string) {
  const [out] = await serializeConversations([c], viewerId);
  return out!;
}

function emitToMembers(memberIds: string[], event: "message:new" | "message:updated" | "message:deleted", message: Record<string, unknown>): void {
  for (const id of memberIds) emitToUser(id, event, { message });
}

// A line in the conversation saying what happened. Doesn't notify anyone.
async function systemMessage(conversationId: string, actorId: string | null, meta: Record<string, unknown>): Promise<void> {
  const message = await Message.create({ conversationId, senderId: actorId, type: "system", meta });
  await bumpLast(conversationId, message);
  emitToMembers(await memberIdsOfConversation(conversationId), "message:new", serializeMessage(message));
}

async function bumpLast(conversationId: string, m: Message, tx?: Transaction): Promise<void> {
  await Conversation.update(
    { lastSeq: m.seq, lastMessageId: m.id, lastMessageAt: m.createdAt, lastSenderId: m.senderId ?? null, lastMessageType: m.type, lastPreview: previewOf(m.type, m.body) },
    { where: { id: conversationId }, transaction: tx },
  );
}

async function hintMembers(conversationId: string, collections = CHAT_COLLECTIONS): Promise<string[]> {
  const ids = await memberIdsOfConversation(conversationId);
  syncHint(ids, collections);
  return ids;
}

async function loadMessage(id: string): Promise<Message> {
  const m = await Message.findByPk(id, withReactions);
  if (!m) throw notFound("Message not found");
  return m;
}

async function reloadMessage(id: string) {
  return serializeMessage(await loadMessage(id));
}

const canManageMembers = async (c: Conversation, userId: string, me: ConversationMember | null) =>
  isStaff(me) || (await can({ sub: userId }, "channel.manage_members", scopeOfConversation(c)));

export interface ChannelInput {
  id?: string;
  name: string;
  description?: string;
  scope: ChannelScope;
  scopeId?: string | null;
  memberIds?: string[];
  groups?: GroupRef[];
  moderatorIds?: string[];
  posting?: "everyone" | "moderators";
}

export interface SendInput {
  id?: string;
  type?: MessageType;
  body?: string;
  meta?: unknown;
  attachmentIds?: string[];
  parentId?: string | null;
  replyToId?: string | null;
  mentions?: string[];
  clientSentAt?: string | null;
}

export const chatService = {
  async list(userId: string, q: { type?: "direct" | "channel"; archived?: boolean }) {
    const memberships = await ConversationMember.findAll({ where: { userId, leftAt: null }, attributes: ["conversationId", "pinned"] });
    const rows = await Conversation.findAll({
      where: {
        id: memberships.map((m) => m.conversationId),
        ...(q.type ? { type: q.type } : {}),
        archivedAt: q.archived ? { [Op.ne]: null } : null,
      },
    });
    const pinned = new Set(memberships.filter((m) => m.pinned).map((m) => m.conversationId));
    const time = (c: Conversation) => (c.lastMessageAt ?? c.createdAt).getTime();
    rows.sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || time(b) - time(a));
    return serializeConversations(rows, userId);
  },

  // Scoped channels the person belongs to the scope of, but isn't in.
  async joinable(userId: string) {
    const mine = (await ConversationMember.findAll({ where: { userId, leftAt: null }, attributes: ["conversationId"] })).map((m) => m.conversationId);
    const channels = await Conversation.findAll({
      where: { type: "channel", archivedAt: null, scope: { [Op.ne]: "private" }, ...(mine.length ? { id: { [Op.notIn]: mine } } : {}) },
      order: [["name", "ASC"]],
      limit: 200,
    });
    const allowed: Conversation[] = [];
    for (const c of channels) {
      if ((await scopeMemberIds(c.scope, c.scopeId)).includes(userId)) allowed.push(c);
    }
    return serializeConversations(allowed, userId);
  },

  async openDirect(userId: string, otherId: string, id?: string) {
    if (userId === otherId) throw badRequest("Pick someone else to message");
    if (!(await can({ sub: userId }, "message.send"))) throw forbidden("You don't have permission to send messages");
    const other = await User.findByPk(otherId, { attributes: ["id", "status"] });
    if (!other || other.status !== "active") throw badRequest("That person isn't available");

    const directKey = directKeyOf(userId, otherId);
    const existing = await Conversation.findOne({ where: { directKey } });
    if (existing) return { created: false, conversation: await conversationFor(existing, userId) };

    const created = await sequelize
      .transaction(async (tx) => {
        const c = await Conversation.create({ ...(id ? { id } : {}), type: "direct", directKey, createdBy: userId }, { transaction: tx });
        await addMembers(c.id, [userId, otherId], { notifyLevel: "all", tx });
        return c;
      })
      .catch(async (err) => {
        // Both people opened it at the same moment: use the one that won.
        const raced = await Conversation.findOne({ where: { directKey } });
        if (raced) return raced;
        throw err;
      });
    await created.reload();
    syncHint([userId, otherId], CHAT_COLLECTIONS);
    return { created: true, conversation: await conversationFor(created, userId) };
  },

  async createChannel(input: ChannelInput, userId: string) {
    if (input.scope === "private") {
      if (reachIsEmpty(await reachFor(userId, "channel.create"))) throw forbidden("You don't have permission to create channels");
    } else {
      const scope: Scope = input.scope === "organization" ? { type: "organization", id: null } : { type: input.scope, id: input.scopeId ?? null };
      if (!(await can({ sub: userId }, "channel.create", scope))) throw forbidden("You don't have permission to create a channel here");
    }
    const fromScope = await scopeMemberIds(input.scope, input.scopeId);
    const fromGroups = input.groups?.length ? await groupsService.expandIds(input.groups) : [];
    const picked = new Set([...(input.memberIds ?? []), ...fromGroups]);
    const moderators = input.moderatorIds ?? [];

    const conversation = await sequelize.transaction(async (tx) => {
      const c = await Conversation.create(
        {
          ...(input.id ? { id: input.id } : {}),
          type: "channel",
          scope: input.scope,
          scopeId: input.scope === "organization" || input.scope === "private" ? null : (input.scopeId ?? null),
          name: input.name,
          description: input.description ?? "",
          posting: input.posting ?? "everyone",
          createdBy: userId,
        },
        { transaction: tx },
      );
      await addMembers(c.id, fromScope.filter((id) => !picked.has(id)), { source: "scope", tx });
      await addMembers(c.id, [...picked], { source: "manual", tx });
      await addMembers(c.id, moderators, { role: "moderator", source: "manual", tx });
      await addMembers(c.id, [userId], { role: "owner", source: "manual", tx });
      return c;
    });
    await conversation.reload();
    await systemMessage(conversation.id, userId, { event: "created", name: conversation.name });
    await conversation.reload();
    await audit({ actorId: userId, action: "channel.create", target: { type: "conversation", id: conversation.id }, scope: scopeOfConversation(conversation), after: { name: conversation.name, scope: conversation.scope } });
    refreshBadges(await hintMembers(conversation.id));
    return conversationFor(conversation, userId);
  },

  async get(id: string, userId: string) {
    const c = await loadConversation(id);
    await requireMember(id, userId);
    return conversationFor(c, userId);
  },

  async update(id: string, patch: { name?: string; description?: string; avatarUrl?: string | null; posting?: "everyone" | "moderators" }, userId: string) {
    const c = await loadConversation(id);
    if (c.type === "direct") throw badRequest("Direct conversations have no settings");
    const me = await activeMember(id, userId);
    if (!isStaff(me) && !(await can({ sub: userId }, "channel.edit", scopeOfConversation(c)))) throw forbidden("You can't edit this channel");
    const renamed = patch.name !== undefined && patch.name !== c.name;
    await c.update(patch);
    if (renamed) await systemMessage(id, userId, { event: "renamed", name: patch.name });
    await hintMembers(id);
    for (const uid of await memberIdsOfConversation(id)) emitToUser(uid, "conversation:updated", { conversationId: id });
    return conversationFor(c, userId);
  },

  async setArchived(id: string, archived: boolean, userId: string) {
    const c = await loadConversation(id);
    if (c.type === "direct") throw badRequest("Direct conversations can't be archived");
    const me = await activeMember(id, userId);
    if (me?.role !== "owner" && !(await can({ sub: userId }, "channel.archive", scopeOfConversation(c)))) throw forbidden("You can't archive this channel");
    await c.update({ archivedAt: archived ? new Date() : null });
    if (archived) await systemMessage(id, userId, { event: "archived" });
    await audit({ actorId: userId, action: archived ? "channel.archive" : "channel.unarchive", target: { type: "conversation", id }, scope: scopeOfConversation(c) });
    refreshBadges(await hintMembers(id));
    return conversationFor(c, userId);
  },

  async join(id: string, userId: string) {
    const c = await loadConversation(id);
    if (c.type !== "channel" || c.scope === "private") throw forbidden("You need an invitation to join this");
    if (c.archivedAt) throw new AppError(409, "This channel is archived", "archived");
    if (!(await scopeMemberIds(c.scope, c.scopeId)).includes(userId)) throw forbidden("This channel is for another group");
    // History stays readable, but joining shouldn't leave everything marked unread.
    const added = await addMembers(id, [userId], { source: "scope", lastReadSeq: c.lastSeq });
    if (added.length) await systemMessage(id, userId, { event: "joined", userIds: added });
    await hintMembers(id);
    await c.reload();
    return conversationFor(c, userId);
  },

  async leave(id: string, userId: string) {
    const c = await loadConversation(id);
    if (c.type === "direct") throw badRequest("You can't leave a direct conversation");
    const me = await requireMember(id, userId);
    if (me.role === "owner" && c.scope === "private") {
      const owners = await ConversationMember.count({ where: { conversationId: id, role: "owner", leftAt: null } });
      if (owners === 1) throw new AppError(409, "Make someone else an owner before leaving", "last_owner");
    }
    await removeMember(c, me);
    await systemMessage(id, userId, { event: "left", userIds: [userId] });
  },

  async setMyState(id: string, patch: { notify?: MemberNotify; mutedUntil?: string | null; pinned?: boolean }, userId: string) {
    const c = await loadConversation(id);
    const me = await requireMember(id, userId);
    await me.update({
      ...(patch.notify !== undefined ? { notify: patch.notify } : {}),
      ...(patch.mutedUntil !== undefined ? { mutedUntil: patch.mutedUntil ? new Date(patch.mutedUntil) : null } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    });
    syncHint([userId], ["conversationMembers", "conversations"]);
    refreshBadges([userId]);
    return conversationFor(c, userId);
  },

  async read(id: string, seq: number, userId: string) {
    const c = await loadConversation(id);
    const me = await requireMember(id, userId);
    // Never past what exists, and never backwards.
    const target = Math.min(seq, Number(c.lastSeq) || seq);
    if (target > Number(me.lastReadSeq)) {
      await me.update({ lastReadSeq: target, lastReadAt: new Date() });
      // Receipts to everyone only where they can be shown sensibly.
      const others = c.memberCount <= 50 ? await memberIdsOfConversation(id) : [userId];
      for (const uid of others) emitToUser(uid, "read", { conversationId: id, userId, lastReadSeq: target });
      refreshBadges([userId]);
    }
    const counts = await unreadCounts(userId, [id]);
    return { lastReadSeq: Number(me.lastReadSeq), unread: counts.get(id)?.unread ?? 0 };
  },

  async typing(id: string, isTyping: boolean, userId: string) {
    const c = await loadConversation(id);
    await requireMember(id, userId);
    if (c.memberCount > 200) return; // too noisy to be useful
    for (const uid of await memberIdsOfConversation(id)) {
      if (uid !== userId) emitToUser(uid, "typing", { conversationId: id, userId, isTyping });
    }
  },

  async members(id: string, userId: string) {
    await requireMember(id, userId);
    return (await ConversationMember.findAll({ where: { conversationId: id, leftAt: null }, order: [["createdAt", "ASC"]] })).map(serializeMember);
  },

  async addMembers(id: string, input: { userIds?: string[]; groups?: GroupRef[]; role?: MemberRole }, userId: string) {
    const c = await loadConversation(id);
    if (c.type === "direct") throw badRequest("Direct conversations are between two people");
    if (!(await canManageMembers(c, userId, await activeMember(id, userId)))) throw forbidden("You can't manage this channel's members");
    const fromGroups = input.groups?.length ? await groupsService.expandIds(input.groups) : [];
    const wanted = [...new Set([...(input.userIds ?? []), ...fromGroups])];
    const found = await User.count({ where: { id: wanted } });
    if (found !== wanted.length) throw badRequest("One of the people picked no longer exists");
    const added = await addMembers(id, wanted, { role: input.role, source: "manual", lastReadSeq: c.lastSeq });
    if (added.length) {
      await systemMessage(id, userId, { event: "added", userIds: added });
      await audit({ actorId: userId, action: "channel.member.add", target: { type: "conversation", id }, scope: scopeOfConversation(c), after: { userIds: added } });
    }
    await hintMembers(id);
    refreshBadges(added);
    return this.members(id, userId);
  },

  async setMemberRole(id: string, targetId: string, role: MemberRole, userId: string) {
    const c = await loadConversation(id);
    if (c.type === "direct") throw badRequest("Direct conversations have no roles");
    if (!(await canManageMembers(c, userId, await activeMember(id, userId)))) throw forbidden("You can't manage this channel's members");
    const target = await activeMember(id, targetId);
    if (!target) throw notFound("That person isn't in this channel");
    const before = target.role;
    await target.update({ role });
    await audit({ actorId: userId, action: "channel.member.role", target: { type: "conversation", id }, scope: scopeOfConversation(c), before: { userId: targetId, role: before }, after: { userId: targetId, role } });
    await hintMembers(id);
    return serializeMember(target);
  },

  async removeMember(id: string, targetId: string, userId: string) {
    const c = await loadConversation(id);
    if (c.type === "direct") throw badRequest("Direct conversations are between two people");
    if (!(await canManageMembers(c, userId, await activeMember(id, userId)))) throw forbidden("You can't manage this channel's members");
    const target = await activeMember(id, targetId);
    if (!target) throw notFound("That person isn't in this channel");
    await removeMember(c, target);
    await systemMessage(id, userId, { event: "removed", userIds: [targetId] });
    await audit({ actorId: userId, action: "channel.member.remove", target: { type: "conversation", id }, scope: scopeOfConversation(c), before: { userId: targetId } });
  },

  // ---- Messages -------------------------------------------------------------

  async messages(id: string, userId: string, q: { before?: number; after?: number; limit?: number; parentId?: string }) {
    await requireMember(id, userId);
    const limit = q.limit ?? 50;
    const seq: Record<symbol, number> = {};
    if (q.before) seq[Op.lt] = q.before;
    if (q.after) seq[Op.gt] = q.after;
    const rows = await Message.findAll({
      where: { conversationId: id, parentId: q.parentId ?? null, ...(q.before || q.after ? { seq } : {}) },
      ...withReactions,
      // Paging forwards from `after` reads oldest first; otherwise newest first.
      order: [["seq", q.after && !q.before ? "ASC" : "DESC"]],
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    page.sort((a, b) => Number(a.seq) - Number(b.seq));
    return { messages: page.map(serializeMessage), hasMore };
  },

  async send(conversationId: string, input: SendInput, userId: string): Promise<{ created: boolean; message: ReturnType<typeof serializeMessage> }> {
    if (input.id) {
      const existing = await Message.findByPk(input.id, withReactions);
      if (existing) {
        if (existing.conversationId !== conversationId || existing.senderId !== userId) throw badRequest("That message id is already used");
        return { created: false, message: serializeMessage(existing) };
      }
    }
    const c = await loadConversation(conversationId);
    const me = await requireMember(conversationId, userId);
    if (c.archivedAt) throw new AppError(409, "This channel is archived", "archived");
    if (c.posting === "moderators" && !isStaff(me)) throw forbidden("Only moderators can post here");
    if (!(await can({ sub: userId }, "message.send", scopeOfConversation(c)))) throw forbidden("You don't have permission to send messages");

    const type = input.type ?? "text";
    const body = input.body?.trim() ?? "";
    const attachments = await claimAttachments(input.attachmentIds ?? [], input.id, userId);
    let meta: Record<string, unknown>;
    try {
      meta = buildMeta({ type, body, meta: input.meta, attachments });
    } catch (err) {
      if (err instanceof MessageShapeError) throw badRequest(err.message);
      throw err;
    }

    if (input.parentId) {
      const parent = await Message.findByPk(input.parentId, { attributes: ["id", "conversationId", "parentId"] });
      if (!parent || parent.conversationId !== conversationId) throw badRequest("That thread isn't in this conversation");
      if (parent.parentId) throw badRequest("Replies can't have their own threads");
    }
    if (input.replyToId) {
      const target = await Message.findByPk(input.replyToId, { attributes: ["conversationId"] });
      if (!target || target.conversationId !== conversationId) throw badRequest("That message isn't in this conversation");
    }
    // Only people who can read it can be mentioned in it.
    const memberIds = await memberIdsOfConversation(conversationId);
    const mentions = [...new Set(input.mentions ?? [])].filter((id) => memberIds.includes(id) && id !== userId);

    let parentAfter: Message | null = null;
    const message = await sequelize.transaction(async (tx) => {
      const created = await Message.create(
        {
          ...(input.id ? { id: input.id } : {}),
          conversationId,
          senderId: userId,
          type,
          body,
          meta,
          parentId: input.parentId ?? null,
          replyToId: input.replyToId ?? null,
          mentions,
          clientSentAt: input.clientSentAt ? new Date(input.clientSentAt) : null,
        },
        { transaction: tx },
      );
      if (input.parentId) {
        // Lock the parent so that two replies at once both count.
        const parent = await Message.findByPk(input.parentId, { transaction: tx, lock: tx.LOCK.UPDATE });
        await parent!.update(
          {
            threadReplyCount: parent!.threadReplyCount + 1,
            threadLastReplyAt: created.createdAt,
            threadParticipantIds: [...new Set([...parent!.threadParticipantIds, userId])],
          },
          { transaction: tx },
        );
        parentAfter = parent;
      } else {
        await bumpLast(conversationId, created, tx);
        // Sending means you've read up to here.
        await me.update({ lastReadSeq: created.seq, lastReadAt: new Date() }, { transaction: tx });
      }
      return created;
    });

    const out = serializeMessage(message);
    emitToMembers(memberIds, "message:new", out);
    if (parentAfter) emitToMembers(memberIds, "message:updated", await reloadMessage((parentAfter as Message).id));
    syncHint(memberIds, CHAT_COLLECTIONS);
    // Pushes and badges for everyone else happen in the worker, so a large
    // channel can't hold up the sender.
    await enqueue("push", "message-fanout", { messageId: message.id }, { jobId: `message-${message.id}` }).catch((err) => console.error("message fanout not queued", err));
    return { created: true, message: out };
  },

  async edit(id: string, input: { body: string; mentions?: string[] }, userId: string) {
    const m = await loadMessage(id);
    if (m.senderId !== userId) throw forbidden("You can only edit your own messages");
    if (m.deletedAt) throw new AppError(409, "This message was deleted", "deleted");
    if (m.type === "system" || m.type === "location" || m.type === "link") throw badRequest("This message can't be edited");
    const memberIds = await memberIdsOfConversation(m.conversationId);
    if (!memberIds.includes(userId)) throw forbidden("You're not in this conversation");
    const body = input.body.trim();
    if (m.type === "text" && !body) throw badRequest("A message can't be empty");
    const mentions = input.mentions ? [...new Set(input.mentions)].filter((u) => memberIds.includes(u) && u !== userId) : m.mentions;
    const newlyMentioned = mentions.filter((u) => !m.mentions.includes(u));
    await m.update({ body, mentions, editedAt: new Date() });
    await refreshPreview(m);
    const out = await reloadMessage(id);
    emitToMembers(memberIds, "message:updated", out);
    syncHint(memberIds, CHAT_COLLECTIONS);
    for (const uid of newlyMentioned) await notifyMention(m, uid, userId);
    return out;
  },

  async remove(id: string, userId: string) {
    const m = await loadMessage(id);
    if (m.deletedAt) return serializeMessage(m);
    const c = await loadConversation(m.conversationId);
    const me = await activeMember(m.conversationId, userId);
    const own = m.senderId === userId && !!me;
    const moderated = !own && (isStaff(me) || (await can({ sub: userId }, "message.moderate", scopeOfConversation(c))));
    if (!own && !moderated) throw forbidden("You can't delete this message");
    if (m.type === "system") throw badRequest("System messages can't be deleted");
    // The text goes; the row stays so offline clients learn about it and threads hold together.
    await m.update({ body: "", meta: {}, mentions: [], deletedAt: new Date(), deletedBy: userId, pinnedAt: null });
    await MessageReaction.destroy({ where: { messageId: id } });
    await refreshPreview(m);
    if (moderated) await audit({ actorId: userId, action: "message.moderate.delete", target: { type: "message", id }, scope: scopeOfConversation(c), before: { senderId: m.senderId } });
    const out = await reloadMessage(id);
    const memberIds = await memberIdsOfConversation(m.conversationId);
    emitToMembers(memberIds, "message:deleted", out);
    syncHint(memberIds, CHAT_COLLECTIONS);
    refreshBadges(memberIds);
    return out;
  },

  async react(id: string, emoji: string, on: boolean, userId: string) {
    const m = await loadMessage(id);
    await requireMember(m.conversationId, userId);
    if (m.deletedAt) throw new AppError(409, "This message was deleted", "deleted");
    if (on) await MessageReaction.findOrCreate({ where: { messageId: id, userId, emoji } });
    else await MessageReaction.destroy({ where: { messageId: id, userId, emoji } });
    // Reactions live in their own table; offline clients watch the message.
    m.changed("updatedAt", true);
    await m.save();
    const out = await reloadMessage(id);
    const memberIds = await memberIdsOfConversation(m.conversationId);
    emitToMembers(memberIds, "message:updated", out);
    syncHint(memberIds, ["messages"]);
    return out;
  },

  async setPinned(id: string, pinned: boolean, userId: string) {
    const m = await loadMessage(id);
    const c = await loadConversation(m.conversationId);
    const me = await requireMember(m.conversationId, userId);
    if (c.type !== "direct" && !isStaff(me)) throw forbidden("Only moderators can pin messages");
    if (m.deletedAt) throw new AppError(409, "This message was deleted", "deleted");
    await m.update({ pinnedAt: pinned ? new Date() : null });
    const out = await reloadMessage(id);
    const memberIds = await memberIdsOfConversation(m.conversationId);
    emitToMembers(memberIds, "message:updated", out);
    syncHint(memberIds, ["messages"]);
    return out;
  },

  async thread(id: string, userId: string) {
    const parent = await loadMessage(id);
    await requireMember(parent.conversationId, userId);
    const replies = await Message.findAll({ where: { parentId: id }, ...withReactions, order: [["seq", "ASC"]] });
    return { parent: serializeMessage(parent), replies: replies.map(serializeMessage) };
  },

  async pinned(id: string, userId: string) {
    await requireMember(id, userId);
    const rows = await Message.findAll({ where: { conversationId: id, pinnedAt: { [Op.ne]: null } }, ...withReactions, order: [["pinnedAt", "DESC"]] });
    return rows.map(serializeMessage);
  },

  async files(id: string, userId: string, q: { kind?: string; before?: number; limit?: number }) {
    await requireMember(id, userId);
    const types: MessageType[] = q.kind === "audio" ? ["audio", "voice"] : q.kind ? [q.kind as MessageType] : ["image", "video", "audio", "voice", "file"];
    const rows = await Message.findAll({
      where: { conversationId: id, type: types, deletedAt: null, ...(q.before ? { seq: { [Op.lt]: q.before } } : {}) },
      ...withReactions,
      order: [["seq", "DESC"]],
      limit: q.limit ?? 50,
    });
    return rows.map(serializeMessage);
  },

  // Full text over the person's own conversations only.
  async search(userId: string, q: { q: string; conversationId?: string; senderId?: string; type?: string; from?: string; to?: string; limit?: number }) {
    const tsquery = toSearchQuery(q.q);
    if (!tsquery) return [];
    const rows = await sequelize.query<{ id: string; name: string; direct_key: string | null }>(
      `SELECT m.id, c.name, c.direct_key
         FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = :userId AND cm.left_at IS NULL
         JOIN conversations c ON c.id = m.conversation_id
        WHERE to_tsvector('simple', m.body) @@ to_tsquery('simple', :tsquery)
          AND m.deleted_at IS NULL
          ${q.conversationId ? "AND m.conversation_id = :conversationId" : ""}
          ${q.senderId ? "AND m.sender_id = :senderId" : ""}
          ${q.type ? "AND m.type = :type" : ""}
          ${q.from ? "AND m.created_at >= :from" : ""}
          ${q.to ? "AND m.created_at <= :to" : ""}
        ORDER BY m.seq DESC LIMIT :limit`,
      { replacements: { userId, tsquery, limit: q.limit ?? 20, conversationId: q.conversationId ?? null, senderId: q.senderId ?? null, type: q.type ?? null, from: q.from ?? null, to: q.to ?? null }, type: QueryTypes.SELECT },
    );
    if (!rows.length) return [];
    const messages = await Message.findAll({ where: { id: rows.map((r) => r.id) }, ...withReactions });
    const byId = new Map(messages.map((m) => [m.id, m]));
    const directNames = await directNamesFor(rows.map((r) => r.direct_key), userId);
    return rows.map((r) => ({
      message: serializeMessage(byId.get(r.id)!),
      conversationName: r.direct_key ? (directNames.get(r.direct_key) ?? "") : r.name,
    }));
  },

  // Hourly: scoped channels follow their scope. People removed by hand stay out.
  async syncScopes(): Promise<void> {
    const channels = await Conversation.findAll({ where: { type: "channel", archivedAt: null, scope: { [Op.ne]: "private" } } });
    for (const c of channels) {
      const wanted = new Set(await scopeMemberIds(c.scope, c.scopeId).catch(() => [] as string[]));
      const rows = await ConversationMember.findAll({ where: { conversationId: c.id } });
      const known = new Set(rows.map((r) => r.userId));
      const toAdd = [...wanted].filter((id) => !known.has(id));
      const toRemove = rows.filter((r) => !r.leftAt && r.source === "scope" && !wanted.has(r.userId));
      if (toAdd.length) await addMembers(c.id, toAdd, { source: "scope", lastReadSeq: c.lastSeq });
      for (const r of toRemove) await removeMember(c, r);
      if (toAdd.length || toRemove.length) await hintMembers(c.id);
    }
  },
};

async function directNamesFor(keys: (string | null)[], viewerId: string): Promise<Map<string, string>> {
  const otherOf = (k: string) => k.split(":").find((id) => id !== viewerId) ?? "";
  const unique = [...new Set(keys.filter((k): k is string => !!k))];
  if (!unique.length) return new Map();
  const users = await User.findAll({ where: { id: unique.map(otherOf) }, attributes: ["id", "name"] });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return new Map(unique.map((k) => [k, names.get(otherOf(k)) ?? ""]));
}

// Files are uploaded first against the message id the app generated. Only the
// uploader may use them, and only on that message.
async function claimAttachments(ids: string[], messageId: string | undefined, userId: string): Promise<MetaAttachment[]> {
  if (!ids.length) return [];
  if (!messageId) throw badRequest("Send the message id you uploaded the files against");
  const rows = await Attachment.findAll({ where: { id: ids } });
  if (rows.length !== new Set(ids).size) throw badRequest("One of the files is no longer available");
  for (const a of rows) {
    if (a.itemType !== "message" || a.itemId !== messageId || a.uploadedBy !== userId) throw forbidden("One of the files isn't yours to send");
  }
  return rows.map((a) => ({ id: a.id, name: a.name, size: Number(a.size), type: a.type, url: a.url, asset: { publicId: a.publicId ?? null, delivery: a.delivery ?? null, resourceType: a.resourceType ?? null, format: a.format ?? null } }));
}

async function removeMember(c: Conversation, member: ConversationMember): Promise<void> {
  await member.update({ leftAt: new Date(), pinned: false });
  await refreshMemberCount(c.id);
  // Their device drops the conversation on its next pull.
  const { SyncTombstone } = await import("../sync/tombstones");
  await SyncTombstone.create({ collection: "conversations", recordId: c.id, userId: member.userId, deletedAt: new Date() });
  syncHint([member.userId], ["conversations"]);
  refreshBadges([member.userId]);
  await hintMembers(c.id);
}

// Editing or deleting the latest message changes what the list shows.
async function refreshPreview(m: Message): Promise<void> {
  const c = await Conversation.findByPk(m.conversationId, { attributes: ["id", "lastMessageId"] });
  if (c?.lastMessageId !== m.id) return;
  await Conversation.update({ lastPreview: m.deletedAt ? "" : previewOf(m.type, m.body) }, { where: { id: c.id } });
}

async function notifyMention(m: Message, userId: string, fromUserId: string | null): Promise<void> {
  const sender = fromUserId ? await User.findByPk(fromUserId, { attributes: ["name"] }) : null;
  await notify({
    userId,
    fromUserId,
    kind: "mentioned",
    itemId: m.conversationId,
    itemType: "conversation",
    message: `${sender?.name ?? "Someone"} mentioned you: ${previewOf(m.type, m.body)}`,
    data: { conversationId: m.conversationId, messageId: m.id, parentId: m.parentId ?? null },
  });
}

// The worker's half of sending: who hears about this message, and how.
export async function fanOutMessage(messageId: string): Promise<void> {
  const m = await Message.findByPk(messageId);
  if (!m || m.deletedAt || m.type === "system") return;
  const c = await Conversation.findByPk(m.conversationId);
  if (!c) return;
  const members = await ConversationMember.findAll({ where: { conversationId: c.id, leftAt: null } });
  const sender = m.senderId ? await User.findByPk(m.senderId, { attributes: ["name"] }) : null;
  const now = new Date();
  const threadPeople = m.parentId ? ((await Message.findByPk(m.parentId, { attributes: ["senderId", "threadParticipantIds"] })) ?? null) : null;

  for (const member of members) {
    if (member.userId === m.senderId) continue;
    const muted = member.notify === "none" || (!!member.mutedUntil && member.mutedUntil > now);
    if (m.mentions.includes(member.userId)) {
      if (member.notify !== "none") await notifyMention(m, member.userId, m.senderId ?? null);
      continue;
    }
    if (muted) continue;
    const inThread = !!threadPeople && (threadPeople.senderId === member.userId || threadPeople.threadParticipantIds.includes(member.userId));
    // Thread replies only reach the people in that thread, whatever the setting.
    const wants = m.parentId ? inThread : c.type === "direct" || member.notify === "all";
    if (!wants) continue;
    await notify({
      userId: member.userId,
      fromUserId: m.senderId ?? null,
      kind: "message",
      itemId: c.id,
      itemType: "conversation",
      message: `${c.type === "channel" ? `${sender?.name ?? "Someone"} in ${c.name}: ` : ""}${previewOf(m.type, m.body)}`,
      data: { conversationId: c.id, messageId: m.id, parentId: m.parentId ?? null },
    });
  }
  refreshBadges(members.map((x) => x.userId));
}

export async function chatUnreadTotal(userId: string): Promise<number> {
  const counts = await unreadCounts(userId);
  if (!counts.size) return 0;
  const now = new Date();
  const quiet = await ConversationMember.findAll({
    where: { userId, leftAt: null, conversationId: [...counts.keys()], [Op.or]: [{ notify: "none" }, { mutedUntil: { [Op.gt]: now } }] },
    attributes: ["conversationId"],
  });
  const skip = new Set(quiet.map((q) => q.conversationId));
  let total = 0;
  for (const [id, n] of counts) if (!skip.has(id)) total += n.unread;
  return total;
}

// Sync visibility: the conversations a person is in right now.
export function myConversationIds(userId: string) {
  return sequelize.literal(`(SELECT conversation_id FROM conversation_members WHERE user_id = ${sequelize.escape(userId)} AND left_at IS NULL)`);
}
