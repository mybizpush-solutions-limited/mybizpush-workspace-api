import { strict as assert } from "node:assert";
import { test } from "node:test";
import { bareDomain, canMoveCampaign, classifyImportRow, escapeHtml, extractLinks, formatFrom, isFreshTimestamp, normalizeEmail, parseFrom, renderForRecipient, resolveSender, senderDomainAllowed } from "./campaign.render";

const base = {
  subject: "Hi {{first_name}}",
  bodyHtml: '<p>Hello {{name}}</p><a href="https://a.example/x">Go</a><a href="mailto:a@b.c">Mail</a>',
  bodyText: "Hello {{name}}",
  values: { name: "Ada Obi", email: "ada@x.example", company: "X" },
  unsubscribeUrl: "https://api/t/u/tok",
  openPixelUrl: "https://api/t/o/tok.gif",
  linkIds: new Map([["https://a.example/x", "L1"]]),
  clickUrl: (id: string) => `https://api/t/c/tok/${id}`,
};

test("merge fields fill in, and an unsubscribe link is always there", () => {
  const out = renderForRecipient(base);
  assert.equal(out.subject, "Hi Ada");
  assert.ok(out.html.includes("Hello Ada Obi"));
  assert.ok(out.html.includes("https://api/t/u/tok"));
  assert.ok(out.text.includes("Unsubscribe: https://api/t/u/tok"));
});

test("an explicit unsubscribe link isn't added twice", () => {
  const out = renderForRecipient({ ...base, bodyHtml: '<a href="{{unsubscribe_url}}">Stop</a>' });
  assert.equal(out.html.match(/t\/u\/tok/g)?.length, 1);
});

test("lead data can't inject HTML", () => {
  const out = renderForRecipient({ ...base, values: { ...base.values, name: '<script>x</script>' } });
  assert.ok(!out.html.includes("<script>"));
  assert.ok(out.html.includes("&lt;script&gt;"));
});

test("only known http links are tracked", () => {
  const out = renderForRecipient(base);
  assert.ok(out.html.includes('href="https://api/t/c/tok/L1"'));
  assert.ok(out.html.includes('href="mailto:a@b.c"'));
  assert.ok(!out.html.includes('href="https://a.example/x"'));
  assert.deepEqual(extractLinks(base.bodyHtml), ["https://a.example/x"]);
});

test("a link in lead data isn't turned into a tracked link", () => {
  const out = renderForRecipient({ ...base, bodyHtml: "<p>{{company}}</p>", values: { ...base.values, company: '<a href="https://a.example/x">x</a>' } });
  assert.ok(!out.html.includes("t/c/tok/L1"));
});

test("unknown fields stay visible", () => {
  assert.ok(renderForRecipient({ ...base, bodyHtml: "{{nope}}" }).html.includes("{{nope}}"));
});

const levels = {
  campaign: {},
  product: {},
  organization: { name: "MyBizPush", email: "info@mybizpush.com" },
  fallbackFrom: "Backup <backup@mybizpush.com>",
  allowedDomains: ["mybizpush.com"],
  productDomains: [] as string[],
};

test("the sender comes from the first level that has one", () => {
  assert.deepEqual(resolveSender(levels), { name: "MyBizPush", email: "info@mybizpush.com", problem: null });
  const product = { ...levels, product: { name: "Shop", email: "hello@mybizpush.com" } };
  assert.deepEqual(resolveSender(product), { name: "Shop", email: "hello@mybizpush.com", problem: null });
  const campaign = { ...product, campaign: { name: "Ada", email: "ada@mybizpush.com" } };
  assert.deepEqual(resolveSender(campaign), { name: "Ada", email: "ada@mybizpush.com", problem: null });
  assert.equal(resolveSender({ ...levels, organization: {} }).email, "backup@mybizpush.com");
});

test("a blank name takes the name of the level giving the address", () => {
  const out = resolveSender({ ...levels, product: { name: "Shop", email: "hello@mybizpush.com" }, campaign: { name: "  " } });
  assert.equal(out.name, "Shop");
  assert.equal(resolveSender({ ...levels, campaign: { name: "Ada" } }).name, "Ada");
});

test("a bad domain is reported, never swapped for a good one", () => {
  const out = resolveSender({ ...levels, campaign: { email: "x@gmail.com" } });
  assert.deepEqual([out.email, out.problem], ["x@gmail.com", "sender_domain_not_allowed"]);
});

test("the product's own domain is allowed for that product", () => {
  const input = { ...levels, campaign: { email: "x@shop.example" } };
  assert.equal(resolveSender(input).problem, "sender_domain_not_allowed");
  assert.equal(resolveSender({ ...input, productDomains: ["shop.example"] }).problem, null);
  assert.equal(senderDomainAllowed("not an email", ["mybizpush.com"]), false);
});

test("names can't break the From header", () => {
  const out = resolveSender({ ...levels, campaign: { name: 'A"<b>\r\nBcc: x' } });
  assert.ok(!/["<>\r\n]/.test(out.name));
  assert.equal(formatFrom({ name: "A", email: "a@b.c" }), "A <a@b.c>");
  assert.equal(formatFrom({ name: "", email: "a@b.c" }), "a@b.c");
});

test("site addresses reduce to their domain", () => {
  assert.equal(bareDomain("https://www.Shop.example/about"), "shop.example");
  assert.equal(bareDomain("shop.example:8080"), "shop.example");
  assert.deepEqual(parseFrom("Name <A@B.c>"), { name: "Name", email: "a@b.c" });
});

test("import rows are sorted into what will happen", () => {
  const known = { existing: new Set(["old@x.example"]), suppressed: new Set(["gone@x.example"]), seen: new Set<string>() };
  const row = (email: string) => classifyImportRow({ email, name: "", company: "", phone: "" }, known).status;
  assert.equal(row("new@x.example"), "ready");
  assert.equal(row(" NEW@x.example "), "duplicate");
  assert.equal(row("old@x.example"), "duplicate");
  assert.equal(row("gone@x.example"), "suppressed");
  assert.equal(row("nope"), "invalid");
  assert.equal(row(""), "invalid");
});

test("helpers", () => {
  assert.equal(normalizeEmail(" A@B.C "), "a@b.c");
  assert.equal(escapeHtml(`<"&'>`), "&lt;&quot;&amp;&#39;&gt;");
  assert.equal(isFreshTimestamp("1000", 1_000_000), true);
  assert.equal(isFreshTimestamp("1000", 2_000_000), false);
  assert.equal(isFreshTimestamp("nope", 1_000_000), false);
});

test("a campaign can't skip approval", () => {
  assert.equal(canMoveCampaign("draft", "sending"), false);
  assert.equal(canMoveCampaign("draft", "scheduled"), false);
  assert.equal(canMoveCampaign("pending_approval", "sending"), false);
  assert.equal(canMoveCampaign("approved", "sending"), true);
  assert.equal(canMoveCampaign("sent", "sending"), false);
});
