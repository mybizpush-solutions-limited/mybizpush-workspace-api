import type { Request } from "express";
import type { Transaction } from "sequelize";
import { AuditLog } from "../models";

// Records administrative and permission changes (API-CHANGES A007).
//
// Naming: `action` is "<resource>.<verb>" (user.access_level.change,
// role.assign, report.export). `target` is what changed; `scope` is where the
// change applies (organization, department, team, product, project).
//
// Pass `tx` when the change runs in a transaction so the audit row commits or
// rolls back with it. Without a transaction, audit failures are logged and
// never fail the action itself.

export interface AuditEntry {
  action: string;
  target: { type: string; id?: string | null };
  scope?: { type: string; id?: string | null } | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  actorId?: string | null; // defaults to the authenticated user on `req`
  req?: Request;
  tx?: Transaction;
}

export async function audit(entry: AuditEntry): Promise<void> {
  const row = {
    actorId: entry.actorId ?? entry.req?.auth?.sub ?? null,
    action: entry.action,
    targetType: entry.target.type,
    targetId: entry.target.id ?? null,
    scopeType: entry.scope?.type ?? null,
    scopeId: entry.scope?.id ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: entry.req?.ip ?? null,
    userAgent: entry.req?.get("user-agent")?.slice(0, 400) ?? null,
  };
  if (entry.tx) {
    await AuditLog.create(row, { transaction: entry.tx });
    return;
  }
  try {
    await AuditLog.create(row);
  } catch (err) {
    console.error(`[audit] ${entry.action} not recorded`, err);
  }
}
