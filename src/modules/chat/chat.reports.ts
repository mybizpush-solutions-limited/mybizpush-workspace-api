import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { Conversation, ConversationMember } from "../../models";
import { can } from "../access/engine";
import { scopeOfConversation } from "./chat.service";

// Channel reporting (API-CHANGES A305). Counts and timings only: nothing here
// reads a message's text, so reporting can't expose private conversations.

const q = <T extends object>(sql: string, replacements: Record<string, unknown>) => sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });

export async function channelReport(conversationId: string, userId: string, range: { from?: string; to?: string }) {
  const c = await Conversation.findByPk(conversationId);
  if (!c) throw notFound("Conversation not found");
  if (c.type === "direct") throw badRequest("Direct conversations aren't reported on");
  const me = await ConversationMember.findOne({ where: { conversationId, userId, leftAt: null } });
  const staff = me?.role === "owner" || me?.role === "moderator";
  if (!staff && !(await can({ sub: userId }, "report.view", scopeOfConversation(c)))) throw forbidden("You can't see reports for this channel");

  const to = range.to ? new Date(range.to) : new Date();
  const from = range.from ? new Date(range.from) : new Date(to.getTime() - 30 * 86_400_000);
  const args = { id: conversationId, from, to };
  const inRange = `conversation_id = :id AND created_at BETWEEN :from AND :to AND deleted_at IS NULL AND type <> 'system'`;

  const [totals, byDay, byType, top, response] = await Promise.all([
    q<{ messages: string; threads: string; active: string }>(
      `SELECT COUNT(*) AS messages, COUNT(*) FILTER (WHERE thread_reply_count > 0) AS threads, COUNT(DISTINCT sender_id) AS active FROM messages WHERE ${inRange}`,
      args,
    ),
    q<{ date: string; messages: string }>(`SELECT to_char(created_at, 'YYYY-MM-DD') AS date, COUNT(*) AS messages FROM messages WHERE ${inRange} GROUP BY 1 ORDER BY 1`, args),
    q<{ type: string; messages: string }>(`SELECT type, COUNT(*) AS messages FROM messages WHERE ${inRange} GROUP BY 1`, args),
    q<{ sender_id: string; messages: string }>(`SELECT sender_id, COUNT(*) AS messages FROM messages WHERE ${inRange} AND sender_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, args),
    // A response is a message from someone else after the previous one.
    q<{ minutes: string | null }>(
      `SELECT AVG(EXTRACT(EPOCH FROM (created_at - prev_at)) / 60) AS minutes FROM (
         SELECT created_at, sender_id,
                LAG(created_at) OVER (ORDER BY seq) AS prev_at,
                LAG(sender_id) OVER (ORDER BY seq) AS prev_sender
           FROM messages WHERE ${inRange}
       ) gaps WHERE prev_sender IS NOT NULL AND sender_id IS DISTINCT FROM prev_sender`,
      args,
    ),
  ]);

  const activeMembers = Number(totals[0]?.active ?? 0);
  return {
    conversationId,
    range: { from: from.toISOString(), to: to.toISOString() },
    memberCount: c.memberCount,
    messages: Number(totals[0]?.messages ?? 0),
    threads: Number(totals[0]?.threads ?? 0),
    activeMembers,
    participationRate: c.memberCount ? activeMembers / c.memberCount : 0,
    avgResponseMinutes: response[0]?.minutes != null ? Math.round(Number(response[0].minutes) * 10) / 10 : null,
    byDay: byDay.map((d) => ({ date: d.date, messages: Number(d.messages) })),
    byType: Object.fromEntries(byType.map((t) => [t.type, Number(t.messages)])),
    topParticipants: top.map((t) => ({ userId: t.sender_id, messages: Number(t.messages) })),
  };
}
