import express, { Router } from "express";
import cors from "cors";
import { asyncHandler } from "../../lib/errors";
import { ingestService, type Beacon } from "./analytics.ingest";
import { analyticsService, DIMENSIONS, RANGES, type Dimension, type Range } from "./analytics.service";
import { trackerScript } from "./tracker";
import { env } from "../../config/env";

// The public half of analytics: the tracker script and the beacon endpoint.
// Both are unauthenticated and must be reachable from ANY origin (that's the
// whole point — they run on our marketing sites, not on the Dev Space), so this
// router carries its own permissive CORS instead of the app-wide allow-list.
export const analyticsCollectRouter = Router();

const anyOrigin = cors({
  origin: true,
  credentials: false,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 86_400,
});
analyticsCollectRouter.use(anyOrigin);
analyticsCollectRouter.options("*", anyOrigin);
// Its own body parser: this router is mounted ahead of the app-wide one so the
// global CORS allow-list never gets a chance to reject a beacon's preflight.
// sendBeacon posts a Blob typed application/json; fetch fallbacks post plain text.
analyticsCollectRouter.use(express.json({ limit: "8kb", type: ["application/json", "text/plain"] }));

// Absolute URL the snippet posts back to. Derived from the request so the same
// build works on localhost, staging and production without configuration.
function collectUrl(protocol: string, host: string): string {
  return `${protocol}://${host}/api/collect`;
}

// GET /px.js — the tracking snippet.
analyticsCollectRouter.get("/px.js", (req, res) => {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? req.protocol;
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? `localhost:${env.PORT}`;
  res
    .type("application/javascript; charset=utf-8")
    // Short cache: long enough to spare our origin, short enough that a fix to
    // the tracker propagates the same day.
    .set("Cache-Control", "public, max-age=3600")
    // The script is served cross-origin by design.
    .set("Cross-Origin-Resource-Policy", "cross-origin")
    .send(trackerScript(collectUrl(proto, String(Array.isArray(host) ? host[0] : host))));
});

// ---- Read-only shared dashboards -------------------------------------------
// A site with sharing switched on can be read by another of our apps (the
// Hyparrow admin dashboard) using only its share key. Read-only: no site list,
// no management, and an unknown key is a flat 404.
const parseRange = (raw: unknown): Range => (RANGES.includes(raw as Range) ? (raw as Range) : "7d");

analyticsCollectRouter.get(
  "/api/analytics/share/:shareKey/summary",
  asyncHandler(async (req, res) => {
    const site = await analyticsService.siteByShareKey(req.params.shareKey!);
    if (!site) return void res.status(404).json({ error: "Unknown share key" });
    res.json({
      site: { name: site.name, domain: site.domain },
      ...(await analyticsService.summary(site.id, parseRange(req.query.range))),
    });
  }),
);

analyticsCollectRouter.get(
  "/api/analytics/share/:shareKey/breakdown",
  asyncHandler(async (req, res) => {
    const site = await analyticsService.siteByShareKey(req.params.shareKey!);
    if (!site) return void res.status(404).json({ error: "Unknown share key" });
    const dimension = DIMENSIONS.includes(req.query.dimension as Dimension)
      ? (req.query.dimension as Dimension)
      : "path";
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    res.json({
      dimension,
      rows: await analyticsService.breakdown(
        site.id,
        dimension,
        parseRange(req.query.range),
        limit,
      ),
    });
  }),
);

analyticsCollectRouter.get(
  "/api/analytics/share/:shareKey/realtime",
  asyncHandler(async (req, res) => {
    const site = await analyticsService.siteByShareKey(req.params.shareKey!);
    if (!site) return void res.status(404).json({ error: "Unknown share key" });
    res.json(await analyticsService.realtime(site.id));
  }),
);

// POST /api/collect — one beacon. Always answers 204, even for unknown site
// keys, so the endpoint can't be used to probe which keys exist.
analyticsCollectRouter.post(
  "/api/collect",
  asyncHandler(async (req, res) => {
    try {
      await ingestService.record(req, (req.body ?? {}) as Beacon);
    } catch (err) {
      // A malformed beacon must never surface as an error to the visitor's
      // browser or take down the collector.
      console.error("[analytics] failed to record beacon", err);
    }
    res.status(204).end();
  }),
);
