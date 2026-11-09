import { sequelize } from "../../db/sequelize";
import { QueryTypes } from "sequelize";
import type { Meeting } from "../../models";

// Which scopes a person belongs to, as SQL: used for the calendar, sync and the
// single-meeting check, so that they can't disagree.

// Rows (scope_type, scope_id) for everywhere this person belongs.
export function myScopesSql(userId: string): string {
  const u = sequelize.escape(userId);
  return `(
    SELECT 'department' AS scope_type, department_id AS scope_id FROM department_members WHERE user_id = ${u}
    UNION SELECT 'team', team_id FROM team_members WHERE user_id = ${u}
    UNION SELECT 'product', product_id FROM product_members WHERE user_id = ${u}
    UNION SELECT 'product', id FROM products WHERE owner_id = ${u}
    UNION SELECT 'project', project_id FROM project_members WHERE user_id = ${u}
    UNION SELECT 'project', id FROM projects WHERE manager_id = ${u}
    UNION SELECT 'project', pd.project_id FROM project_departments pd JOIN department_members dm ON dm.department_id = pd.department_id WHERE dm.user_id = ${u}
  )`;
}

// A condition on a table with scope_type and scope_id columns.
export function inMyScopesSql(userId: string, table: string): string {
  return `(${table}.scope_type = 'organization' OR (${table}.scope_type::text, ${table}.scope_id) IN (SELECT scope_type, scope_id FROM ${myScopesSql(userId)} s))`;
}

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
