// Scrape a tracked site's homepage for its favicon, OG image, title and
// description, so the analytics sites list is scannable at a glance instead of
// showing the same placeholder icon for everything.
//
// Deliberately small: one GET of the homepage, regex over the <head>, absolute
// URLs resolved against the page. We store URLs, never image bytes — the
// browser loads them from the site directly.

export type SiteBranding = {
  faviconUrl: string;
  ogImageUrl: string;
  siteTitle: string;
  siteDescription: string;
};

const EMPTY: SiteBranding = {
  faviconUrl: "",
  ogImageUrl: "",
  siteTitle: "",
  siteDescription: "",
};

// Only read the first chunk — everything we want lives in <head>, and some of
// our sites ship very large HTML documents.
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 8000;

// Pull one attribute out of a tag, tolerating either quote style and any
// attribute order.
function attr(tag: string, name: string): string {
  const m =
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag) ??
    new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i").exec(tag);
  return m?.[1]?.trim() ?? "";
}

function metaContent(html: string, keys: string[]): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, "property") || attr(tag, "name")).toLowerCase();
    if (keys.includes(key)) {
      const content = attr(tag, "content");
      if (content) return content;
    }
  }
  return "";
}

// Best <link rel="icon"> on the page. Prefers explicitly-sized icons (bigger is
// better for a crisp avatar) and falls back to whatever is declared.
function findIcon(html: string): string {
  let best = "";
  let bestSize = -1;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, "rel").toLowerCase();
    if (!/\b(icon|shortcut icon|apple-touch-icon)\b/.test(rel)) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    // "32x32", "180x180", or "any" for SVGs — treat SVG as the best case since
    // it scales losslessly.
    const sizes = attr(tag, "sizes").toLowerCase();
    const size = /\.svg($|\?)/i.test(href)
      ? 9999
      : (Number(/(\d+)x\d+/.exec(sizes)?.[1]) || (rel.includes("apple-touch") ? 180 : 16));
    if (size > bestSize) {
      bestSize = size;
      best = href;
    }
  }
  return best;
}

function absolute(href: string, base: string): string {
  if (!href) return "";
  try {
    return new URL(href, base).toString().slice(0, 1000);
  } catch {
    return "";
  }
}

async function fetchHead(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Some hosts serve a stripped page (or 403) to unknown agents.
        "User-Agent": "MyBizPushDevSpace/1.0 (+site-analytics branding fetcher)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let read = 0;
    // Stop as soon as we've seen </head> — no need to stream a whole SPA bundle.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (read >= MAX_BYTES || /<\/head>/i.test(html)) break;
    }
    await reader.cancel().catch(() => undefined);
    return { html, finalUrl: res.url || url };
  } catch {
    return null;
  }
}

// Fetch branding for a domain. Never throws — a site being down, slow, or
// hostile to scrapers must not break creating or listing analytics sites.
export async function fetchSiteBranding(domain: string): Promise<SiteBranding> {
  const clean = domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!clean) return EMPTY;

  const page = (await fetchHead(`https://${clean}/`)) ?? (await fetchHead(`http://${clean}/`));
  if (!page) {
    // Even with no reachable homepage, the conventional path is usually right.
    return { ...EMPTY, faviconUrl: `https://${clean}/favicon.ico` };
  }

  const { html, finalUrl } = page;
  const head = html.split(/<\/head>/i)[0] ?? html;

  const icon = absolute(findIcon(head), finalUrl);
  const ogImage = absolute(
    metaContent(head, ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]),
    finalUrl,
  );
  const title =
    metaContent(head, ["og:site_name", "og:title", "twitter:title"]) ||
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "").trim();
  const description = metaContent(head, ["og:description", "description", "twitter:description"]);

  return {
    // Fall back to /favicon.ico, which browsers request by convention even when
    // a site declares no <link rel="icon">.
    faviconUrl: icon || absolute("/favicon.ico", finalUrl),
    ogImageUrl: ogImage,
    siteTitle: decodeEntities(title).slice(0, 300),
    siteDescription: decodeEntities(description).slice(0, 600),
  };
}

// The named entities that actually show up in titles, plus numeric ones in both
// decimal and hex form (&#39; and &#x27; are both common in minified <head>s).
// &amp; is unescaped last so "&amp;#39;" doesn't turn into an apostrophe.
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function codePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}
