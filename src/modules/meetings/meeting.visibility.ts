import { sequelize } from "../../db/sequelize";
import { QueryTypes } from "sequelize";
import type { Meeting } from "../../models";
import { inMyScopesSql, myScopesSql } from "../access/visibility.rules";

export { inMyScopesSql, myScopesSql };

// Which scopes a person belongs to, as SQL: used for the calendar, sync and the
// single-meeting check, so that they can't disagree.

// Meetings someone can see: theirs, or set for a scope they're in.
export function visibleMeetingsSql(userId: string, table = '"Meeting"'): string {
  const u = sequelize.escape(userId);
  return `(${table}.organizer_id = ${u}
    OR ${table}.id IN (SELECT meeting_id FROM meeting_attendees WHERE user_id = ${u})
    OR ${inMyScopesSql(userId, table)})`;
}

export function visibleMeetingIds(userId: string): string {
  return `(SELECT m.id FROM meetings m WHERE ${visibleMeetingsSql(userId, "m")})`;
}

export async function isInMeetingScope(meeting: Pick<Meeting, "scopeType" | "scopeId">, userId: string): Promise<boolean> {
  if (!meeting.scopeType) return false;
  if (meeting.scopeType === "organization") return true;
  const rows = await sequelize.query(`SELECT 1 FROM ${myScopesSql(userId)} s WHERE s.scope_type = :type AND s.scope_id = :id LIMIT 1`, {
    replacements: { type: meeting.scopeType, id: meeting.scopeId },
    type: QueryTypes.SELECT,
  });
  return rows.length > 0;
}
