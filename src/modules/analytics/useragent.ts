// Minimal server-side user-agent classification. We only need coarse buckets
// for the dashboard (device / browser / OS), so a handful of ordered patterns
// beats pulling in a full UA database.

export type UaInfo = { deviceType: string; browser: string; os: string };

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//i, "Edge"],
  [/\bOPR\/|\bOpera\b/i, "Opera"],
  [/\bSamsungBrowser\//i, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//i, "Firefox"],
  // Chrome must come after the Chromium-based forks above, Safari after Chrome.
  [/\bChrome\/|\bCriOS\//i, "Chrome"],
  [/\bSafari\//i, "Safari"],
];

const OSES: [RegExp, string][] = [
  [/\bWindows NT\b/i, "Windows"],
  [/\b(iPhone|iPad|iPod)\b/i, "iOS"],
  [/\bMac OS X\b/i, "macOS"],
  [/\bAndroid\b/i, "Android"],
  [/\bCrOS\b/i, "ChromeOS"],
  [/\bLinux\b/i, "Linux"],
];

const BOT = /bot|crawler|spider|crawling|headless|preview|monitor|curl|wget|python-requests|axios\//i;

export function isBot(ua: string): boolean {
  return BOT.test(ua);
}

export function parseUserAgent(ua: string, screenWidth = 0): UaInfo {
  const match = (table: [RegExp, string][]) => table.find(([re]) => re.test(ua))?.[1] ?? "";

  const os = match(OSES);
  let deviceType: string;
  if (/\bTablet\b|\biPad\b|(Android(?!.*Mobile))/i.test(ua)) deviceType = "tablet";
  else if (/\bMobi|\bAndroid\b|\biPhone\b|\biPod\b/i.test(ua)) deviceType = "mobile";
  else if (screenWidth > 0 && screenWidth < 768) deviceType = "mobile";
  else deviceType = "desktop";

  return { deviceType, browser: match(BROWSERS), os };
}
