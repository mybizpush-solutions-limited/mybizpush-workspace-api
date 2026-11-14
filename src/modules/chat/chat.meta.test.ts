import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildMeta, directKeyOf, MessageShapeError, previewOf, toSearchQuery } from "./chat.meta";

const file = { id: "a", name: "n.m4a", size: 1, type: "audio/mp4", url: "https://x/y" };

test("text needs a body and takes no attachments", () => {
  assert.throws(() => buildMeta({ type: "text", body: "  ", attachments: [] }), MessageShapeError);
  assert.throws(() => buildMeta({ type: "text", body: "hi", attachments: [file] }), MessageShapeError);
  assert.deepEqual(buildMeta({ type: "text", body: "hi", attachments: [] }), {});
});

test("a voice note needs a file and a duration", () => {
  assert.throws(() => buildMeta({ type: "voice", body: "", attachments: [] }), MessageShapeError);
  assert.throws(() => buildMeta({ type: "voice", body: "", attachments: [file], meta: {} }), MessageShapeError);
  const meta = buildMeta({ type: "voice", body: "", attachments: [file], meta: { durationMs: 900, waveform: [0, 1] } });
  assert.deepEqual(meta, { durationMs: 900, waveform: [0, 1], attachments: [file] });
});

test("link and location are checked", () => {
  assert.throws(() => buildMeta({ type: "link", body: "", attachments: [], meta: { url: "nope" } }), MessageShapeError);
  assert.throws(() => buildMeta({ type: "location", body: "", attachments: [], meta: { latitude: 200, longitude: 0 } }), MessageShapeError);
  assert.deepEqual(buildMeta({ type: "location", body: "", attachments: [], meta: { latitude: 6.5, longitude: 3.4, label: "Office" } }), { latitude: 6.5, longitude: 3.4, label: "Office" });
});

test("clients can't send system messages or store extra keys", () => {
  assert.throws(() => buildMeta({ type: "system", body: "x", attachments: [] }), MessageShapeError);
  assert.deepEqual(buildMeta({ type: "text", body: "hi", attachments: [], meta: { admin: true } }), {});
  // An attachment list in meta is ignored: only the server fills that in.
  const out = buildMeta({ type: "file", body: "", attachments: [file], meta: { attachments: [{ url: "evil" }] } });
  assert.deepEqual(out, { attachments: [file] });
});

test("previews fall back to the type", () => {
  assert.equal(previewOf("voice", ""), "Voice note");
  assert.equal(previewOf("image", " nice  view "), "nice view");
  assert.equal(previewOf("text", "x".repeat(300)).length, 160);
});

test("search queries become safe prefix terms", () => {
  assert.equal(toSearchQuery("Hemp oil!"), "hemp:* & oil:*");
  assert.equal(toSearchQuery("&&& ' :*"), null);
});

test("a direct key doesn't depend on who started it", () => {
  assert.equal(directKeyOf("b", "a"), directKeyOf("a", "b"));
});
