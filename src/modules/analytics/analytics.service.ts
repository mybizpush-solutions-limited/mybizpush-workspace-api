import crypto from "node:crypto";
import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize";
import { AnalyticsSite, Project } from "../../models";
import { badRequest, notFound } from "../../lib/errors";
import { invalidateSiteCache } from "./analytics.ingest";
import { fetchSiteBranding } from "./branding";

export const RANGES = ["24h", "7d", "30d", "90d"] as const;
export type Range = (typeof RANGES)[number];

const RANGE_HOURS: Record<Range, number> = { "24h": 24, "7d": 168, "30d": 720, "90d": 2160 };
// Hourly buckets for a one-day window, daily buckets for anything longer.
const bucketOf = (range: Range) => (range === "24h" ? "hour" : "day");

export const DIMENSIONS = [
  "path",
  "referrer",
  "country",
  "device",
  "browser",
  "os",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "event",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

// Dimension → the column it groups by. Fixed mapping (never interpolated from
// user input) so the raw SQL below stays injection-free.
const DIMENSION_COLUMN: Record<Dimension, string> = {
  path: "path",
  referrer: "referrer_host",
  country: "country",
  device: "device_type",
  browser: "browser",
  os: "os",
  utm_source: "utm_source",
  utm_medium: "utm_medium",
  utm_campaign: "utm_campaign",
  event: "name",
};

function serializeSite(s: AnalyticsSite) {
  return {
    id: s.id,
    projectId: s.projectId ?? null,
    name: s.name,
    domain: s.domain,
    publicKey: s.publicKey,
    allowedOrigins: s.allowedOrigins,
    shareKey: s.shareKey ?? null,
    faviconUrl: s.faviconUrl ?? "",
    ogImageUrl: s.ogImageUrl ?? "",
    siteTitle: s.siteTitle ?? "",
    siteDescription: s.siteDescription ?? "",
    brandingFetchedAt: s.brandingFetchedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

// Is the snippet actually installed and reporting?
//   connected — something arrived in the last 48h
//   quiet     — it reported before, but not recently (snippet removed? no traffic?)
//   waiting   — nothing has ever arrived; the snippet isn't live yet
export const CONNECTION_STATUSES = ["connected", "quiet", "waiting"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

const CONNECTED_WINDOW_MS = 48 * 60 * 60 * 1000;

function connectionStatus(lastEventAt: Date | null): ConnectionStatus {
  if (!lastEventAt) return "waiting";
  return Date.now() - lastEventAt.getTime() <= CONNECTED_WINDOW_MS ? "connected" : "quiet";
}

// Scrape the site's homepage and store what we find. Best-effort: a failure
// leaves the previous values alone and is never surfaced to the caller, since
// branding is decoration, not data.
async function refreshBranding(site: AnalyticsSite): Promise<void> {
  try {
    const branding = await fetchSiteBranding(site.domain);
    await site.update({ ...branding, brandingFetchedAt: new Date() });
  } catch (err) {
    console.error(`[analytics] branding fetch failed for ${site.domain}`, err);
  }
}

// Normalise whatever the user typed ("https://hyparrow.com/", "www.Hyparrow.com")
// down to a bare lowercase hostname.
function normalizeDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!trimmed || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) {
    throw badRequest("Enter a valid domain, e.g. hyparrow.com");
  }
  return trimmed;
}

export const analyticsService = {
  // Sites plus their live connection state, so the list shows at a glance which
  // snippets are actually reporting and which were never installed.
  async listSites() {
    const sites = await AnalyticsSite.findAll({ order: [["createdAt", "ASC"]] });
    if (!sites.length) return [];

    // One grouped query for every site rather than one per site.
    const stats = await sequelize.query<{
      site_id: string;
      last_event_at: Date | null;
      total: string;
    }>(
      `SELECT site_id, MAX(ts) AS last_event_at, COUNT(*) AS total
         FROM analytics_events
        WHERE site_id IN (:ids)
        GROUP BY site_id`,
      { type: QueryTypes.SELECT, replacements: { ids: sites.map((s) => s.id) } },
    );
    const byId = new Map(stats.map((r) => [r.site_id, r]));

    return sites.map((site) => {
      const stat = byId.get(site.id);
      const lastEventAt = stat?.last_event_at ? new Date(stat.last_event_at) : null;
      return {
        ...serializeSite(site),
        lastEventAt: lastEventAt?.toISOString() ?? null,
        totalEvents: Number(stat?.total ?? 0),
        status: connectionStatus(lastEventAt),
      };
    });
  },

  async siteById(id: string) {
    const site = await AnalyticsSite.findByPk(id);
    if (!site) throw notFound("Site not found");
    return site;
  },

  async createSite(input: {
    name: string;
    domain: string;
    projectId?: string | null;
    allowedOrigins?: string[];
    createdBy: string | null;
  }) {
    const domain = normalizeDomain(input.domain);
    if (input.projectId && !(await Project.findByPk(input.projectId))) {
      throw notFound("Project not found");
    }
    const site = await AnalyticsSite.create({
      name: input.name.trim(),
      domain,
      projectId: input.projectId ?? null,
      // Default the allow-list to the site's own domain; callers can widen it.
      allowedOrigins: input.allowedOrigins?.length ? input.allowedOrigins : [domain],
      publicKey: crypto.randomBytes(12).toString("base64url"),
      createdBy: input.createdBy,
    });
    // Grab the favicon/OG image before answering, so the new card is never
    // briefly blank — the scrape is a single short-timeout request.
    await refreshBranding(site);
    return serializeSite(site);
  },

  async updateSite(
    id: string,
    patch: { name?: string; domain?: string; projectId?: string | null; allowedOrigins?: string[] },
  ) {
    const site = await this.siteById(id);
    const previousDomain = site.domain;
    await site.update({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.domain !== undefined ? { domain: normalizeDomain(patch.domain) } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      ...(patch.allowedOrigins !== undefined ? { allowedOrigins: patch.allowedOrigins } : {}),
    });
    // A new domain means the old favicon and preview image are stale.
    if (site.domain !== previousDomain) await refreshBranding(site);
    invalidateSiteCache(site.publicKey);
    return serializeSite(site);
  },

  // Re-scrape branding on demand — for when a site is redesigned, or the first
  // attempt ran before the site was live.
  async refreshBranding(id: string) {
    const site = await this.siteById(id);
    await refreshBranding(site);
    return serializeSite(site);
  },

  async deleteSite(id: string) {
    const site = await this.siteById(id);
    const { publicKey } = site;
    await sequelize.query("DELETE FROM analytics_events WHERE site_id = :id", {
      replacements: { id },
    });
    await sequelize.query("DELETE FROM analytics_daily WHERE site_id = :id", {
      replacements: { id },
    });
    await site.destroy();
    invalidateSiteCache(publicKey);
  },

  // Turn read-only sharing on (minting a fresh key) or off. Used to let the
  // Hyparrow admin dashboard show the same numbers without a Dev Space login.
  async setSharing(id: string, enabled: boolean) {
    const site = await this.siteById(id);
    await site.update({ shareKey: enabled ? crypto.randomBytes(12).toString("base64url") : null });
    return serializeSite(site);
  },

  // Resolve a shared site from its read-only key. Returns null rather than
  // throwing so the public route can answer a flat 404 for any bad key.
  async siteByShareKey(shareKey: string) {
    if (!shareKey) return null;
    return AnalyticsSite.findOne({ where: { shareKey } });
  },

  // Rotate the public key — the old snippet stops reporting immediately.
  async rotateKey(id: string) {
    const site = await this.siteById(id);
    const previous = site.publicKey;
    await site.update({ publicKey: crypto.randomBytes(12).toString("base64url") });
    invalidateSiteCache(previous);
    return serializeSite(site);
  },

  // Headline numbers plus the timeseries behind the main chart.
  async summary(siteId: string, range: Range) {
    const hours = RANGE_HOURS[range];
    const bucket = bucketOf(range);
    const replacements = { siteId, hours: `${hours} hours` };

    const [totals] = await sequelize.query<{
      pageviews: string;
      visitors: string;
      sessions: string;
      avg_duration: string | null;
    }>(
      `SELECT COUNT(*) FILTER (WHERE kind = 'pageview')      AS pageviews,
              COUNT(DISTINCT visitor_hash)                   AS visitors,
              COUNT(DISTINCT NULLIF(session_id, ''))         AS sessions,
              AVG(NULLIF(duration_ms, 0))                    AS avg_duration
         FROM analytics_events
        WHERE site_id = :siteId AND ts >= NOW() - CAST(:hours AS interval)`,
      { type: QueryTypes.SELECT, replacements },
    );

    // A bounce is a session that never got past its first pageview.
    const [bounce] = await sequelize.query<{ bounced: string; total: string }>(
      `SELECT COUNT(*) FILTER (WHERE views = 1) AS bounced, COUNT(*) AS total
         FROM (
           SELECT session_id, COUNT(*) AS views
             FROM analytics_events
            WHERE site_id = :siteId AND ts >= NOW() - CAST(:hours AS interval)
              AND kind = 'pageview' AND session_id <> ''
            GROUP BY session_id
         ) s`,
      { type: QueryTypes.SELECT, replacements },
    );

    const series = await sequelize.query<{
      bucket: Date;
      pageviews: string;
      visitors: string;
    }>(
      `SELECT date_trunc(:bucket, ts) AS bucket,
              COUNT(*) FILTER (WHERE kind = 'pageview') AS pageviews,
              COUNT(DISTINCT visitor_hash)              AS visitors
         FROM analytics_events
        WHERE site_id = :siteId AND ts >= NOW() - CAST(:hours AS interval)
        GROUP BY 1
        ORDER BY 1 ASC`,
      { type: QueryTypes.SELECT, replacements: { ...replacements, bucket } },
    );

    const totalSessions = Number(bounce?.total ?? 0);
    return {
      range,
      bucket,
      pageviews: Number(totals?.pageviews ?? 0),
      visitors: Number(totals?.visitors ?? 0),
      sessions: Number(totals?.sessions ?? 0),
      avgDurationMs: Math.round(Number(totals?.avg_duration ?? 0)),
      bounceRate: totalSessions ? Number(bounce?.bounced ?? 0) / totalSessions : 0,
      series: series.map((r) => ({
        bucket: new Date(r.bucket).toISOString(),
        pageviews: Number(r.pageviews),
        visitors: Number(r.visitors),
      })),
    };
  },

  // Top values for one dimension (top pages, referrers, countries, …).
  async breakdown(siteId: string, dimension: Dimension, range: Range, limit = 10) {
    const column = DIMENSION_COLUMN[dimension];
    const kindFilter = dimension === "event" ? "kind = 'event'" : "kind = 'pageview'";
    const rows = await sequelize.query<{ value: string; count: string; visitors: string }>(
      `SELECT ${column} AS value,
              COUNT(*)                     AS count,
              COUNT(DISTINCT visitor_hash) AS visitors
         FROM analytics_events
        WHERE site_id = :siteId
          AND ts >= NOW() - CAST(:hours AS interval)
          AND ${kindFilter}
          AND ${column} <> ''
        GROUP BY 1
        ORDER BY count DESC
        LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: { siteId, hours: `${RANGE_HOURS[range]} hours`, limit },
      },
    );
    return rows.map((r) => ({
      value: r.value,
      count: Number(r.count),
      visitors: Number(r.visitors),
    }));
  },

  // Who's on the site right now, and what they're looking at.
  async realtime(siteId: string) {
    const [totals] = await sequelize.query<{ visitors: string }>(
      `SELECT COUNT(DISTINCT visitor_hash) AS visitors
         FROM analytics_events
        WHERE site_id = :siteId AND ts >= NOW() - INTERVAL '5 minutes'`,
      { type: QueryTypes.SELECT, replacements: { siteId } },
    );
    const pages = await sequelize.query<{ value: string; count: string }>(
      `SELECT path AS value, COUNT(*) AS count
         FROM analytics_events
        WHERE site_id = :siteId AND ts >= NOW() - INTERVAL '5 minutes' AND kind = 'pageview'
        GROUP BY 1 ORDER BY count DESC LIMIT 5`,
      { type: QueryTypes.SELECT, replacements: { siteId } },
    );
    return {
      visitors: Number(totals?.visitors ?? 0),
      pages: pages.map((p) => ({ value: p.value, count: Number(p.count) })),
    };
  },

  // Rebuild the per-day/per-path rollup for the trailing `days` window. Runs on
  // a cron; safe to re-run (upserts on the site/day/path unique index).
  async rollup(days = 3): Promise<void> {
    await sequelize.query(
      `INSERT INTO analytics_daily (id, site_id, day, path, pageviews, visitors, sessions, created_at, updated_at)
       SELECT gen_random_uuid(),
              site_id,
              ts::date                               AS day,
              path,
              COUNT(*)                               AS pageviews,
              COUNT(DISTINCT visitor_hash)           AS visitors,
              COUNT(DISTINCT NULLIF(session_id, '')) AS sessions,
              NOW(), NOW()
         FROM analytics_events
        WHERE kind = 'pageview'
          AND ts >= (CURRENT_DATE - CAST(:days AS integer))
        GROUP BY site_id, ts::date, path
       ON CONFLICT (site_id, day, path) DO UPDATE
          SET pageviews  = EXCLUDED.pageviews,
              visitors   = EXCLUDED.visitors,
              sessions   = EXCLUDED.sessions,
              updated_at = NOW()`,
      { replacements: { days } },
    );
  },
};
