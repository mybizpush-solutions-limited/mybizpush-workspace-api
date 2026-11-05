import { Router } from "express";
import { z } from "zod";
import { Op } from "sequelize";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { redis } from "../../redis/client";
import { AccessRole, Department, Issue, Meeting, Product, ProductMember, Project, Task, Team, User } from "../../models";

// Lookup for every picker sheet (API-CHANGES A109, SYS-05, SYS-07) and global
// search (A110, SYS-04). Pickers show: recent picks, then suggestions for the
// current product, then matches for the typed text.
export const lookupRouter = Router();
export const searchRouter = Router();
lookupRouter.use(requireAuth);
searchRouter.use(requireAuth);

const TYPES = ["staff", "product", "project", "department", "team", "role"] as const;
type LookupType = (typeof TYPES)[number];
interface Item {
  id: string;
  label: string;
  sublabel?: string;
  imageUrl?: string | null;
}

const recentKey = (userId: string, type: string) => `lookup:recent:${userId}:${type}`;
const like = (q: string) => ({ [Op.iLike]: `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%` });

async function find(type: LookupType, q: string, limit: number, ids?: string[]): Promise<Item[]> {
  const idFilter = ids ? { id: ids } : {};
  switch (type) {
    case "staff": {
      const rows = await User.findAll({
        where: { status: "active", ...idFilter, ...(q ? { [Op.or]: [{ name: like(q) }, { email: like(q) }] } : {}) },
        attributes: ["id", "name", "email", "avatarUrl", "roles"],
        include: [{ model: Department, as: "departments", attributes: ["name"], through: { attributes: [] } }],
        order: [["name", "ASC"]],
        limit,
      });
      return rows.map((u) => ({
        id: u.id,
        label: u.name,
        sublabel: [u.roles[0], ((u.get("departments") as Department[] | undefined) ?? [])[0]?.name].filter(Boolean).join(" · ") || u.email,
        imageUrl: u.avatarUrl,
      }));
    }
    case "product": {
      const rows = await Product.findAll({ where: { ...idFilter, ...(q ? { name: like(q) } : {}) }, order: [["name", "ASC"]], limit });
      return rows.map((p) => ({ id: p.id, label: p.name, sublabel: p.description, imageUrl: p.logoUrl }));
    }
    case "project": {
      const rows = await Project.findAll({
        where: { ...idFilter, ...(q ? { name: like(q) } : {}) },
        include: [{ model: Product, as: "product", attributes: ["name"] }],
        order: [["name", "ASC"]],
        limit,
      });
      return rows.map((p) => ({ id: p.id, label: p.name, sublabel: [(p.get("product") as Product | null)?.name, `${p.progress}% done`].filter(Boolean).join(" · "), imageUrl: p.avatarUrl }));
    }
    case "department": {
      const rows = await Department.findAll({ where: { ...idFilter, ...(q ? { name: like(q) } : {}) }, order: [["name", "ASC"]], limit });
      return rows.map((d) => ({ id: d.id, label: d.name, sublabel: d.description }));
    }
    case "team": {
      const rows = await Team.findAll({ where: { ...idFilter, ...(q ? { name: like(q) } : {}) }, order: [["name", "ASC"]], limit });
      return rows.map((t) => ({ id: t.id, label: t.name, sublabel: t.description }));
    }
    case "role": {
      const rows = await AccessRole.findAll({ where: { ...idFilter, ...(q ? { name: like(q) } : {}) }, order: [["name", "ASC"]], limit });
      return rows.map((r) => ({ id: r.id, label: r.name, sublabel: r.description }));
    }
  }
}

// GET /lookup?type=staff&q=dan&productId=...&limit=20
lookupRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const type = String(req.query.type ?? "") as LookupType;
    if (!TYPES.includes(type)) throw badRequest(`type must be one of ${TYPES.join(", ")}`);
    const q = String(req.query.q ?? "").trim().slice(0, 80);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const productId = typeof req.query.productId === "string" ? req.query.productId : undefined;

    const recentIds = q ? [] : await redis.lrange(recentKey(req.auth!.sub, type), 0, 7);
    const recent = recentIds.length ? await find(type, "", 8, recentIds) : [];

    // Suggestions: people and projects in the current product come first.
    let suggested: Item[] = [];
    if (!q && productId) {
      if (type === "staff") {
        const ids = (await ProductMember.findAll({ where: { productId }, attributes: ["userId"] })).map((m) => m.userId);
        suggested = ids.length ? await find("staff", "", limit, ids) : [];
      } else if (type === "project") {
        const ids = (await Project.findAll({ where: { productId }, attributes: ["id"] })).map((p) => p.id);
        suggested = ids.length ? await find("project", "", limit, ids) : [];
      }
    }
    const results = q || !suggested.length ? await find(type, q, limit) : [];
    res.json({ type, recent, suggested, results });
  }),
);

// The app reports a pick so it appears under "Recent" next time.
lookupRouter.post(
  "/recent",
  validateBody(z.object({ type: z.enum(TYPES), id: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    const k = recentKey(req.auth!.sub, req.body.type);
    await redis.lrem(k, 0, req.body.id);
    await redis.lpush(k, req.body.id);
    await redis.ltrim(k, 0, 19);
    res.status(204).end();
  }),
);

// GET /search?q=hemp -> grouped results across the workspace (SYS-04).
// Plain ILIKE for now; trigram indexes can replace it when data grows.
searchRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 80);
    if (q.length < 2) return res.json({ q, groups: [] });
    const [people, products, projects, tasks, issues, meetings] = await Promise.all([
      find("staff", q, 5),
      find("product", q, 5),
      find("project", q, 5),
      Task.findAll({ where: { title: like(q) }, attributes: ["id", "title", "status", "projectId"], order: [["updatedAt", "DESC"]], limit: 5 }),
      Issue.findAll({ where: { title: like(q) }, attributes: ["id", "title", "status", "projectId"], order: [["updatedAt", "DESC"]], limit: 5 }),
      Meeting.findAll({ where: { title: like(q) }, attributes: ["id", "title", "startsAt"], order: [["startsAt", "DESC"]], limit: 5 }),
    ]);
    const groups = [
      { type: "people", items: people },
      { type: "products", items: products },
      { type: "projects", items: projects },
      { type: "tasks", items: tasks.map((t) => ({ id: t.id, label: t.title, sublabel: t.status })) },
      { type: "issues", items: issues.map((t) => ({ id: t.id, label: t.title, sublabel: t.status })) },
      { type: "meetings", items: meetings.map((m) => ({ id: m.id, label: m.title, sublabel: m.startsAt.toISOString() })) },
    ].filter((g) => g.items.length);
    res.json({ q, groups });
  }),
);
