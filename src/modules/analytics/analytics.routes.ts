import { Router } from "express";
import { z } from "zod";
import { asyncHandler, forbidden } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { analyticsService, DIMENSIONS, RANGES, type Dimension, type Range } from "./analytics.service";

// The authenticated half of analytics: everything the dashboard reads, plus
// site management. Anyone signed in can view the numbers; adding, editing and
// deleting a tracked site is executive-admin only — a site's tracking key is
// org-wide infrastructure, not per-department.
export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

function assertCanManageSites(accessLevel: string): void {
  if (accessLevel !== "executive_admin") {
    throw forbidden("Only an executive admin can manage analytics sites");
  }
}

const originsSchema = z.array(z.string().trim().min(1).max(255)).max(20);

const createSiteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  domain: z.string().trim().min(3).max(255),
  projectId: z.string().uuid().nullish(),
  allowedOrigins: originsSchema.optional(),
});

const updateSiteSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  domain: z.string().trim().min(3).max(255).optional(),
  projectId: z.string().uuid().nullish(),
  allowedOrigins: originsSchema.optional(),
});

const parseRange = (raw: unknown): Range =>
  RANGES.includes(raw as Range) ? (raw as Range) : "7d";

analyticsRouter.get(
  "/sites",
  asyncHandler(async (_req, res) => {
    res.json({ sites: await analyticsService.listSites() });
  }),
);

analyticsRouter.post(
  "/sites",
  validateBody(createSiteSchema),
  asyncHandler(async (req, res) => {
    assertCanManageSites(req.auth!.accessLevel);
    const site = await analyticsService.createSite({ ...req.body, createdBy: req.auth!.sub });
    res.status(201).json({ site });
  }),
);

analyticsRouter.patch(
  "/sites/:id",
  validateBody(updateSiteSchema),
  asyncHandler(async (req, res) => {
    assertCanManageSites(req.auth!.accessLevel);
    res.json({ site: await analyticsService.updateSite(req.params.id!, req.body) });
  }),
);

analyticsRouter.delete(
  "/sites/:id",
  asyncHandler(async (req, res) => {
    assertCanManageSites(req.auth!.accessLevel);
    await analyticsService.deleteSite(req.params.id!);
    res.status(204).end();
  }),
);

// Rotate the site's public key. The old snippet stops reporting the moment the
// cache expires, so the site must be re-tagged with the new key.
analyticsRouter.post(
  "/sites/:id/rotate-key",
  asyncHandler(async (req, res) => {
    assertCanManageSites(req.auth!.accessLevel);
    res.json({ site: await analyticsService.rotateKey(req.params.id!) });
  }),
);

// Re-scrape the site's favicon / preview image (after a redesign, or if the
// first attempt ran before the site was live).
analyticsRouter.post(
  "/sites/:id/refresh-branding",
  asyncHandler(async (req, res) => {
    assertCanManageSites(req.auth!.accessLevel);
    res.json({ site: await analyticsService.refreshBranding(req.params.id!) });
  }),
);

// Read-only sharing for our other dashboards (Hyparrow admin, etc.).
analyticsRouter.post(
  "/sites/:id/share",
  validateBody(z.object({ enabled: z.boolean() })),
  asyncHandler(async (req, res) => {
    assertCanManageSites(req.auth!.accessLevel);
    res.json({ site: await analyticsService.setSharing(req.params.id!, req.body.enabled) });
  }),
);

analyticsRouter.get(
  "/sites/:id/summary",
  asyncHandler(async (req, res) => {
    await analyticsService.siteById(req.params.id!); // 404s for unknown sites
    res.json(await analyticsService.summary(req.params.id!, parseRange(req.query.range)));
  }),
);

analyticsRouter.get(
  "/sites/:id/breakdown",
  asyncHandler(async (req, res) => {
    await analyticsService.siteById(req.params.id!);
    const dimension = DIMENSIONS.includes(req.query.dimension as Dimension)
      ? (req.query.dimension as Dimension)
      : "path";
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    res.json({
      dimension,
      rows: await analyticsService.breakdown(
        req.params.id!,
        dimension,
        parseRange(req.query.range),
        limit,
      ),
    });
  }),
);

analyticsRouter.get(
  "/sites/:id/realtime",
  asyncHandler(async (req, res) => {
    await analyticsService.siteById(req.params.id!);
    res.json(await analyticsService.realtime(req.params.id!));
  }),
);
