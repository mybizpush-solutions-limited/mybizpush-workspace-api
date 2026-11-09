import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildRawMessage, compareEvent, extractBody, googleEventIdFor, hasNewReply, headerOf, isAllowedReturn, parseAddresses, withResult } from "./integrations.pure";

test("only allowed return links pass", () => {
  const list = ["mybizpush://", "https://app.example"];
  assert.equal(isAllowedReturn("mybizpush://integrations", list), true);
  assert.equal(isAllowedReturn("https://app.example/profile", list), true);
  assert.equal(isAllowedReturn("https://app.example", list), true);
  assert.equal(isAllowedReturn("https://app.example.evil.com/x", list), false);
  assert.equal(isAllowedReturn("https://app.exampleevil.com", list), false);
  assert.equal(isAllowedReturn("javascript:alert(1)", list), false);
  assert.equal(isAllowedReturn("https://evil.com", list), false);
  assert.equal(isAllowedReturn("mybizpush://x\r\nSet-Cookie: a", list), false);
  assert.equal(isAllowedReturn("", list), false);
  assert.equal(isAllowedReturn("mybizpush://x", []), false);
});

test("the result is added to the return link", () => {
  assert.equal(withResult("mybizpush://i", "google", "connected"), "mybizpush://i?provider=google&status=connected");
  assert.equal(withResult("mybizpush://i?a=1", "github", "error"), "mybizpush://i?a=1&provider=github&status=error");
});

test("addresses parse, keeping commas inside names", () => {
  assert.deepEqual(parseAddresses('"Obi, Ada" <ada@x.com>, bola@y.com'), [{ name: "Obi, Ada", email: "ada@x.com" }, { name: "", email: "bola@y.com" }]);
  assert.deepEqual(parseAddresses(null), []);
  assert.equal(headerOf([{ name: "SUBJECT", value: "Hi" }], "subject"), "Hi");
});

test("message bodies and files are found in nested parts", () => {
  const enc = (s: string) => Buffer.from(s).toString("base64url");
  const out = extractBody({
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: enc("Plain") } }, { mimeType: "text/html", body: { data: enc("<b>Html</b>") } }] },
      { mimeType: "application/pdf", filename: "a.pdf", body: { size: 12, attachmentId: "x" } },
    ],
  });
  assert.equal(out.text, "Plain");
  assert.equal(out.html, "<b>Html</b>");
  assert.deepEqual(out.attachments, [{ filename: "a.pdf", mimeType: "application/pdf", size: 12 }]);
});

test("line breaks can't add email headers", () => {
  const raw = buildRawMessage({ from: "a@x.com", to: ["b@y.com\r\nBcc: evil@z.com"], subject: "Hi\r\nBcc: evil@z.com", body: "Body" });
  const text = Buffer.from(raw, "base64url").toString("utf8");
  assert.ok(!/^Bcc:/m.test(text), text);
  assert.ok(text.includes("Subject: Hi Bcc: evil@z.com"));
});

test("replies keep their thread and bodies round trip", () => {
  const raw = buildRawMessage({ from: "a@x.com", to: ["b@y.com"], subject: "Ré", body: "Héllo", inReplyTo: "<1@x>", html: true });
  const text = Buffer.from(raw, "base64url").toString("utf8");
  assert.ok(text.includes("In-Reply-To: <1@x>"));
  assert.ok(text.includes("text/html"));
  assert.ok(text.includes("=?UTF-8?B?"));
  assert.equal(Buffer.from(text.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8"), "Héllo");
});

test("your own answer isn't a new reply", () => {
  const base = { knownCount: 2, currentCount: 3, myEmail: "me@x.com" };
  assert.equal(hasNewReply({ ...base, lastFrom: "Other <o@y.com>" }), true);
  assert.equal(hasNewReply({ ...base, lastFrom: "Me <ME@x.com>" }), false);
  assert.equal(hasNewReply({ ...base, currentCount: 2, lastFrom: "Other <o@y.com>" }), false);
});

const facts = (title: string, h = 9) => ({ title, startsAt: `2026-03-02T0${h}:00:00.000Z`, endsAt: `2026-03-02T1${h - 9}:00:00.000Z` });

test("calendar comparison separates our changes from Google's", () => {
  const local = facts("A");
  assert.equal(compareEvent({ local, snapshot: local, remote: { ...local, cancelled: false } }), "in_sync");
  assert.equal(compareEvent({ local, snapshot: local, remote: null }), "cancelled");
  assert.equal(compareEvent({ local, snapshot: local, remote: { ...local, cancelled: true } }), "cancelled");
  assert.equal(compareEvent({ local, snapshot: local, remote: { ...facts("B"), cancelled: false } }), "changed_in_google");
  assert.equal(compareEvent({ local: facts("Ours"), snapshot: facts("A"), remote: { ...facts("A"), cancelled: false } }), "local_ahead");
  assert.equal(compareEvent({ local, snapshot: null, remote: { ...facts("B"), cancelled: false } }), "changed_in_google");
});

test("the same instant in another format isn't a change", () => {
  const local = facts("A");
  assert.equal(compareEvent({ local, snapshot: local, remote: { title: "A", startsAt: "2026-03-02T10:00:00+01:00", endsAt: "2026-03-02T11:00:00+01:00", cancelled: false } }), "in_sync");
});

test("meeting ids make valid Google ids", () => {
  assert.match(googleEventIdFor("0F8FAD5B-D9CB-469F-A165-70867728950E"), /^[a-v0-9]{32}$/);
});
