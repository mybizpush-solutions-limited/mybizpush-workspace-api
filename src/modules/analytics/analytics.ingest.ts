import crypto from "node:crypto";
import type { Request } from "express";
import { Op } from "sequelize";
import { AnalyticsEvent, AnalyticsSite } from "../../models";
import { env } from "../../config/env";
import { isBot, parseUserAgent } from "./useragent";

// Wire format sent by the tracker (kept terse to keep beacons small).
export type Beacon = {
  k?: unknown; // site public key
  s?: unknown; // client session id
  t?: unknown; // "pageview" | "event" | "duration"
  u?: unknown; // path (+ query)
  r?: unknown; // referrer (full URL)
  n?: unknown; // custom event name
  d?: unknown; // duration in ms
  w?: unknown; // screen width
  p?: unknown; // custom event props (currently unused server-side)
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Sites are looked up on every hit; cache the key → site mapping briefly so a
// busy site doesn't hit Postgres once per pageview.
const siteCache = new Map<string, { site: AnalyticsSite | null; expires: number }>();
const SITE_CACHE_MS = 60_000;

export async function resolveSite(publicKey: string): Promise<AnalyticsSite | null> {
  const hit = siteCache.get(publicKey);
  if (hit && hit.expires > Date.now()) return hit.site;
  const site = await AnalyticsSite.findOne({ where: { publicKey } });
  siteCache.set(publicKey, { site, expires: Date.now() + SITE_CACHE_MS });
  return site;
}

export function invalidateSiteCache(publicKey?: string) {
  if (publicKey) siteCache.delete(publicKey);
  else siteCache.clear();
}

// The visitor identifier. Salted with a secret AND the calendar day, so it
// rotates every 24h and can't be correlated across days or reversed into an IP.
// This is why we need no cookie and no consent banner.
function visitorHash(siteId: string, ip: string, ua: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return crypto
    .createHash("sha256")
    .update(`${env.JWT_ACCESS_SECRET}|${day}|${siteId}|${ip}|${ua}`)
    .digest("hex")
    .slice(0, 64);
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "").trim();
}

// Country comes from the edge (Cloudflare / Vercel) when the site sits behind
// one. We deliberately don't ship a GeoIP database for this.
function edgeCountry(req: Request): string {
  const h = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  const raw = h("cf-ipcountry") || h("x-vercel-ip-country") || h("x-country-code");
  return /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : "";
}

// Split a referrer URL into host + path, dropping self-referrals (internal
// navigation shouldn't show up as a traffic source).
function parseReferrer(raw: string, siteDomain: string): { host: string; path: string } {
  if (!raw) return { host: "", path: "" };
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, "");
    if (host === siteDomain.replace(/^www\./, "")) return { host: "", path: "" };
    return { host: host.slice(0, 255), path: url.pathname.slice(0, 512) };
  } catch {
    return { host: "", path: "" };
  }
}

function parsePath(raw: string): { path: string; utm: Record<string, string> } {
  const [rawPath = "/", query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  return {
    path: (rawPath || "/").slice(0, 512),
    utm: {
      source: (params.get("utm_source") ?? "").slice(0, 120),
      medium: (params.get("utm_medium") ?? "").slice(0, 120),
      campaign: (params.get("utm_campaign") ?? "").slice(0, 120),
    },
  };
}

// Origin allow-list. An empty list means "accept anything", which is the
// default while a site is being set up.
export function originAllowed(site: AnalyticsSite, origin: string | undefined): boolean {
  if (!site.allowedOrigins.length) return true;
  if (!origin) return true; // beacons from sendBeacon may omit Origin
  try {
    const host = new URL(origin).hostname.replace(/^www\./, "");
    return site.allowedOrigins.some((a) => a.replace(/^www\./, "").toLowerCase() === host);
  } catch {
    return false;
  }
}

export const ingestService = {
  // Record one beacon. Returns false when the hit was dropped (unknown site,
  // disallowed origin, bot) so the route can answer 204 either way — we never
  // leak whether a key is valid.
  async record(req: Request, body: Beacon): Promise<boolean> {
    const key = str(body.k, 32);
    if (!key) return false;

    const site = await resolveSite(key);
    if (!site) return false;
    if (!originAllowed(site, req.headers.origin)) return false;

    const ua = str(req.headers["user-agent"], 512);
    if (isBot(ua)) return false;

    const sessionId = str(body.s, 64);
    const kindRaw = str(body.t, 16) || "pageview";
    const { path, utm } = parsePath(str(body.u, 600) || "/");

    // A duration report closes out the pageview it belongs to rather than
    // creating a row of its own.
    if (kindRaw === "duration") {
      const ms = Math.min(Math.max(num(body.d), 0), 30 * 60 * 1000);
      if (!ms || !sessionId) return false;
      const last = await AnalyticsEvent.findOne({
        where: { siteId: site.id, sessionId, path, kind: "pageview" },
        order: [["ts", "DESC"]],
      });
      if (last && last.durationMs < ms) await last.update({ durationMs: ms });
      return true;
    }

    const ref = parseReferrer(str(body.r, 1000), site.domain);
    const uaInfo = parseUserAgent(ua, num(body.w));

    await AnalyticsEvent.create({
      siteId: site.id,
      ts: new Date(),
      kind: kindRaw === "event" ? "event" : "pageview",
      name: kindRaw === "event" ? str(body.n, 80) : "",
      path,
      referrerHost: ref.host,
      referrerPath: ref.path,
      utmSource: utm.source ?? "",
      utmMedium: utm.medium ?? "",
      utmCampaign: utm.campaign ?? "",
      country: edgeCountry(req),
      deviceType: uaInfo.deviceType,
      browser: uaInfo.browser,
      os: uaInfo.os,
      visitorHash: visitorHash(site.id, clientIp(req), ua),
      sessionId,
      durationMs: 0,
    });
    return true;
  },

  // Housekeeping: drop raw events past the retention window. The daily rollup
  // keeps the long-range charts intact.
  async pruneOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    return AnalyticsEvent.destroy({ where: { ts: { [Op.lt]: cutoff } } });
  },
};
