import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { badRequest } from "../../lib/errors";
import { projectsWith } from "../access/reach";
import { myScopesSql } from "../meetings/meeting.visibility";

// The Activity screen (API-CHANGES A906, HOME-02): what happened on work the person
// can see. Item types are named one by one, so staff queries, appraisals and
// messages can't appear here by accident when they gain activity of their own.

const uuidList = (ids: string[]) => ids.map((id) => sequelize.escape(id)).join(",");

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id]), "utf8").toString("base64url");
}
export function decodeCursor(token: string): { createdAt: Date; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as [string, string];
    const createdAt = new Date(at);
    if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("bad");
    return { createdAt, id };
  } catch {
    throw badRequest("That page marker isn't valid");
  }
}

// Conditions on work items, given the table's alias and its assignee join table.
function workVisibleSql(alias: string, assignees: string, assigneeKey: string, userId: string, projects: "all" | string[], hasReviewer: boolean): string {
  if (projects === "all") return "TRUE";
  const u = sequelize.escape(userId);
  return `(${alias}.reporter_id = ${u}
    ${hasReviewer ? `OR ${alias}.reviewer_id = ${u}` : ""}
    OR ${alias}.id IN (SELECT ${assigneeKey} FROM ${assignees} WHERE user_id = ${u})
    OR ${alias}.project_id IN (SELECT scope_id FROM ${myScopesSql(userId)} s WHERE s.scope_type = 'project')
    ${projects.length ? `OR ${alias}.project_id IN (${uuidList(projects)})` : ""})`;
}

export async function activityFeed(userId: string, q: { productId?: string; kind?: string; before?: string; limit?: number }) {
  const limit = q.limit ?? 30;
  const cursor = q.before ? decodeCursor(q.before) : null;

  // Everywhere with organization-wide assign rights, or the projects they lead.
  const [assign, approve] = await Promise.all([projectsWith(userId, "task.assign"), projectsWith(userId, "task.approve")]);
  const projects: "all" | string[] = assign === "all" ? "all" : [...new Set([...assign, ...(approve === "all" ? [] : approve)])];

  const u = sequelize.escape(userId);
  const taskVisible = workVisibleSql("t", "task_assignees", "task_id", userId, projects, true);
  const issueVisible = workVisibleSql("i", "issue_assignees", "issue_id", userId, projects, false);
  const inProduct = (alias: string) => (q.productId ? `AND ${alias}.product_id = :productId` : "");

  const rows = await sequelize.query<{
    id: string; kind: string; item_type: string; item_id: string; data: Record<string, unknown> | null; created_at: Date; title: string | null;
    actor_id: string | null; actor_name: string | null; actor_avatar: string | null;
  }>(
    `SELECT a.id, a.kind, a.item_type, a.item_id, a.data, a.created_at, x.title,
            a.actor_id, ac.name AS actor_name, ac.avatar_url AS actor_avatar
       FROM activity a
       JOIN (
         SELECT t.id, 'task' AS type, t.title FROM tasks t
           JOIN projects p ON p.id = t.project_id WHERE ${taskVisible} ${inProduct("p")}
         UNION ALL
         SELECT i.id, 'issue', i.title FROM issues i
           JOIN projects p ON p.id = i.project_id WHERE ${issueVisible} ${inProduct("p")}
         ${q.productId ? "" : `UNION ALL
         SELECT m.id, 'meeting', m.title FROM meetings m
          WHERE m.organizer_id = ${u} OR m.id IN (SELECT meeting_id FROM meeting_attendees WHERE user_id = ${u})
         UNION ALL
         SELECT an.id, 'announcement', an.title FROM announcements an
          WHERE an.created_by = ${u} OR an.id IN (SELECT announcement_id FROM announcement_receipts WHERE user_id = ${u})`}
       ) x ON x.id = a.item_id AND x.type = a.item_type::text
       LEFT JOIN users ac ON ac.id = a.actor_id
      WHERE TRUE
        ${q.kind ? "AND a.kind::text = :kind" : ""}
        ${cursor ? "AND (a.created_at, a.id) < (:beforeAt, :beforeId)" : ""}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT :limit`,
    {
      replacements: { productId: q.productId ?? null, kind: q.kind ?? null, beforeAt: cursor?.createdAt ?? null, beforeId: cursor?.id ?? null, limit: limit + 1 },
      type: QueryTypes.SELECT,
    },
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    activity: page.map((r) => ({
      id: r.id,
      kind: r.kind,
      actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? "", avatarUrl: r.actor_avatar ?? null } : null,
      itemType: r.item_type,
      itemId: r.item_id,
      title: r.title ?? "",
      data: r.data ?? {},
      createdAt: new Date(r.created_at).toISOString(),
    })),
    nextBefore: hasMore && last ? encodeCursor(new Date(last.created_at), last.id) : null,
  };
}
