import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { Conversation, ConversationMember, Message, MessageReaction, User } from "../../models";

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export function serializeMessage(m: Message) {
  const reactions = (m.get("reactions") as MessageReaction[] | undefined) ?? [];
  const grouped = new Map<string, string[]>();
  for (const r of reactions) grouped.set(r.emoji, [...(grouped.get(r.emoji) ?? []), r.userId]);
  return {
    id: m.id,
    conversationId: m.conversationId,
    seq: Number(m.seq),
    senderId: m.senderId ?? null,
    type: m.type,
    body: m.body,
    meta: m.meta,
    parentId: m.parentId ?? null,
    replyToId: m.replyToId ?? null,
    threadReplyCount: m.threadReplyCount,
    threadLastReplyAt: iso(m.threadLastReplyAt),
    threadParticipantIds: m.threadParticipantIds,
    mentions: m.mentions,
    reactions: [...grouped].map(([emoji, userIds]) => ({ emoji, userIds })),
    pinnedAt: iso(m.pinnedAt),
    editedAt: iso(m.editedAt),
    deletedAt: iso(m.deletedAt),
    clientSentAt: iso(m.clientSentAt),
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export function serializeMember(m: ConversationMember) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    userId: m.userId,
    role: m.role,
    lastReadSeq: Number(m.lastReadSeq),
    lastReadAt: iso(m.lastReadAt),
    notify: m.notify,
    mutedUntil: iso(m.mutedUntil),
    pinned: m.pinned,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export interface UnreadCounts {
  unread: number;
  mentions: number;
}

// Per conversation counts for one person. Replies in threads and system lines
// don't count as unread; a mention anywhere does count as a mention.
export async function unreadCounts(userId: string, conversationIds?: string[]): Promise<Map<string, UnreadCounts>> {
  if (conversationIds && !conversationIds.length) return new Map();
  const rows = await sequelize.query<{ conversation_id: string; unread: string; mentions: string }>(
    `SELECT cm.conversation_id,
            COUNT(*) FILTER (WHERE m.parent_id IS NULL AND m.type <> 'system') AS unread,
            COUNT(*) FILTER (WHERE :userId = ANY(m.mentions)) AS mentions
       FROM conversation_members cm
       JOIN messages m ON m.conversation_id = cm.conversation_id AND m.seq > cm.last_read_seq
      WHERE cm.user_id = :userId AND cm.left_at IS NULL
        AND m.deleted_at IS NULL AND m.sender_id IS DISTINCT FROM :userId
        ${conversationIds ? "AND cm.conversation_id IN (:conversationIds)" : ""}
      GROUP BY cm.conversation_id`,
    { replacements: { userId, conversationIds: conversationIds ?? [] }, type: QueryTypes.SELECT },
  );
  return new Map(rows.map((r) => [r.conversation_id, { unread: Number(r.unread), mentions: Number(r.mentions) }]));
}

// A viewer's copy of conversations: names for direct ones and their own state.
// `withCounts: false` is for sync, where the app computes unread itself.
export async function serializeConversations(rows: Conversation[], viewerId: string, opts: { withCounts?: boolean } = {}) {
  if (!rows.length) return [];
  const ids = rows.map((c) => c.id);
  const [members, counts] = await Promise.all([
    ConversationMember.findAll({ where: { conversationId: ids, userId: viewerId } }),
    opts.withCounts === false ? Promise.resolve(new Map<string, UnreadCounts>()) : unreadCounts(viewerId, ids),
  ]);
  const mine = new Map(members.map((m) => [m.conversationId, m]));
  const otherIds = new Set<string>();
  for (const c of rows) for (const id of c.directKey?.split(":") ?? []) if (id !== viewerId) otherIds.add(id);
  const people = otherIds.size ? await User.findAll({ where: { id: [...otherIds] }, attributes: ["id", "name", "avatarUrl"] }) : [];
  const byId = new Map(people.map((u) => [u.id, u]));

  return rows.map((c) => {
    const directUserIds = c.directKey?.split(":") ?? [];
    const other = byId.get(directUserIds.find((id) => id !== viewerId) ?? "");
    const me = mine.get(c.id);
    const n = counts.get(c.id);
    return {
      id: c.id,
      type: c.type,
      scope: c.scope ?? null,
      scopeId: c.scopeId ?? null,
      name: c.type === "direct" ? (other?.name ?? "") : c.name,
      description: c.description,
      avatarUrl: c.type === "direct" ? (other?.avatarUrl ?? null) : (c.avatarUrl ?? null),
      posting: c.posting,
      createdBy: c.createdBy ?? null,
      memberCount: c.memberCount,
      directUserIds,
      lastMessageAt: iso(c.lastMessageAt),
      lastMessage: c.lastMessageId
        ? { id: c.lastMessageId, senderId: c.lastSenderId ?? null, type: c.lastMessageType, preview: c.lastPreview ?? "", createdAt: iso(c.lastMessageAt) }
        : null,
      lastSeq: Number(c.lastSeq),
      archivedAt: iso(c.archivedAt),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      me: me && !me.leftAt
        ? {
            role: me.role,
            lastReadSeq: Number(me.lastReadSeq),
            notify: me.notify,
            mutedUntil: iso(me.mutedUntil),
            pinned: me.pinned,
            ...(opts.withCounts === false ? {} : { unread: n?.unread ?? 0, mentions: n?.mentions ?? 0 }),
          }
        : null,
    };
  });
}
