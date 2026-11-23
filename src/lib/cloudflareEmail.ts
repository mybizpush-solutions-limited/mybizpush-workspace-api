import { env } from "../config/env";

// Cloudflare Email Routing: company addresses are forwarding rules, so renaming someone's
// address also means moving their rule. The old rule is disabled, not deleted, so it can be undone.

type Matcher = { type: string; field?: string; value?: string };
type Action = { type: string; value?: string[] };
type Rule = { id: string; name?: string; enabled: boolean; priority?: number; matchers: Matcher[]; actions: Action[] };

export type RoutingMove = "moved" | "not_configured" | "no_rule" | "target_exists" | "failed";

const configured = () => Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ZONE_ID);

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/email/routing${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message?: string }[] };
  if (!res.ok || body.success === false) throw new Error(body.errors?.[0]?.message ?? `Cloudflare ${res.status}`);
  return body.result as T;
}

async function rules(): Promise<Rule[]> {
  const all: Rule[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await call<Rule[]>(`/rules?page=${page}&per_page=50`);
    all.push(...batch);
    if (batch.length < 50) break;
  }
  return all;
}

const addressOf = (rule: Rule) => rule.matchers.find((m) => m.type === "literal" && m.field === "to")?.value?.toLowerCase();

export async function moveRoutingRule(from: string, to: string): Promise<RoutingMove> {
  if (!configured()) return "not_configured";
  try {
    const existing = await rules();
    const source = existing.find((rule) => addressOf(rule) === from.toLowerCase() && rule.enabled);
    if (!source) return "no_rule";
    if (existing.some((rule) => addressOf(rule) === to.toLowerCase() && rule.enabled)) return "target_exists";
    await call("/rules", {
      method: "POST",
      body: JSON.stringify({ name: `Workspace: ${to}`, enabled: true, matchers: [{ type: "literal", field: "to", value: to }], actions: source.actions }),
    });
    await call(`/rules/${source.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: source.name ?? from, enabled: false, priority: source.priority, matchers: source.matchers, actions: source.actions }),
    });
    return "moved";
  } catch (err) {
    console.error("[cloudflare] email routing move failed", (err as Error).message);
    return "failed";
  }
}
