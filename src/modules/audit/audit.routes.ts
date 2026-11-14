import { Router } from "express";
import { Op, type WhereOptions } from "sequelize";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAccessLevel, requireAuth } from "../../middleware/auth";
import { AuditLog, User } from "../../models";

// Read-only audit trail for admins (PERM-08). Newest first, cursor paginated
// on created_at so the app can scroll back through history.
export const auditRouter = Router();
auditRouter.use(requireAuth, requireAccessLevel("admin", "chief"));

auditRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const where: WhereOptions<AuditLog> = {};
    const filters = where as Record<string, unknown>;
    for (const [param, column] of [
      ["action", "action"],
      ["targetType", "targetType"],
      ["targetId", "targetId"],
      ["actorId", "actorId"],
      ["scopeType", "scopeType"],
      ["scopeId", "scopeId"],
    ] as const) {
      const value = req.query[param];
      if (typeof value === "string" && value) filters[column] = value;
    }
    if (typeof req.query.before === "string" && req.query.before) {
      const before = new Date(req.query.before);
      if (Number.isNaN(before.getTime())) throw badRequest("before must be an ISO date");
      filters.createdAt = { [Op.lt]: before };
    }

    const rows = await AuditLog.findAll({ where, order: [["createdAt", "DESC"]], limit });
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => !!id))];
    const actors = actorIds.length
      ? await User.findAll({ where: { id: actorIds }, attributes: ["id", "name", "avatarUrl"] })
      : [];
    const byId = new Map(actors.map((a) => [a.id, { id: a.id, name: a.name, avatarUrl: a.avatarUrl }]));

    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actorId ? (byId.get(r.actorId) ?? { id: r.actorId, name: "Deleted user", avatarUrl: null }) : null,
        target: { type: r.targetType, id: r.targetId },
        scope: r.scopeType ? { type: r.scopeType, id: r.scopeId } : null,
        before: r.before,
        after: r.after,
        createdAt: r.createdAt,
      })),
      // Pass as ?before= to load the next page.
      nextBefore: rows.length === limit ? rows[rows.length - 1]!.createdAt : null,
    });
  }),
);
