export type LinkPreview = { url: string; title: string | null; description: string | null; imageUrl: string | null; siteName: string | null };

const decode = (value: string) =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .trim();

function metaContent(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
    const tag = html.match(pattern)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content).slice(0, 300);
  }
  return null;
}

export function parsePreview(html: string, url: URL): LinkPreview {
  const title = metaContent(html, ["og:title", "twitter:title"]) ?? (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ? decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)![1]!).slice(0, 300) : null);
  const image = metaContent(html, ["og:image", "og:image:url", "twitter:image"]);
  let imageUrl: string | null = null;
  if (image) {
    try {
      const resolved = new URL(image, url);
      if (resolved.protocol === "https:" || resolved.protocol === "http:") imageUrl = resolved.toString();
    } catch {
      imageUrl = null;
    }
  }
  return {
    url: url.toString(),
    title,
    description: metaContent(html, ["og:description", "twitter:description", "description"]),
    imageUrl,
    siteName: metaContent(html, ["og:site_name"]) ?? url.hostname.replace(/^www\./, ""),
  };
}
