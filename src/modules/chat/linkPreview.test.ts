import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parsePreview } from "./linkPreview.parse";

const page = `<html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="Launch &amp; grow" />
  <meta name="description" content="Plain description" />
  <meta property="og:image" content="/img/cover.png" />
  <meta property="og:site_name" content="MyBizPush" />
</head></html>`;

test("prefers Open Graph tags and resolves relative images", () => {
  const preview = parsePreview(page, new URL("https://mybizpush.com/blog/launch"));
  assert.equal(preview.title, "Launch & grow");
  assert.equal(preview.description, "Plain description");
  assert.equal(preview.imageUrl, "https://mybizpush.com/img/cover.png");
  assert.equal(preview.siteName, "MyBizPush");
});

test("falls back to <title> and the host name", () => {
  const preview = parsePreview("<title>Just a page</title>", new URL("https://www.example.com/x"));
  assert.equal(preview.title, "Just a page");
  assert.equal(preview.siteName, "example.com");
  assert.equal(preview.imageUrl, null);
});

test("drops non-web image schemes", () => {
  const preview = parsePreview(`<meta property="og:image" content="javascript:alert(1)">`, new URL("https://example.com"));
  assert.equal(preview.imageUrl, null);
});
