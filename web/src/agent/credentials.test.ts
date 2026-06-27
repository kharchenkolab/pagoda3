// Unit tests for the browser-direct credential core (pure). Run from web/: `node --test src/agent/credentials.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { detectCred, buildDirectAnthropic, statusOf, modeOf, normProxyUrl, type Cred } from "./credentials.ts";

test("normProxyUrl: blank → null; normalizes to the /api mount; trims trailing slashes", () => {
  assert.equal(normProxyUrl(""), null);
  assert.equal(normProxyUrl("   "), null);
  assert.equal(normProxyUrl("http://localhost:8786"), "http://localhost:8786/api");
  assert.equal(normProxyUrl("http://localhost:8786/api/"), "http://localhost:8786/api");
  assert.equal(normProxyUrl("https://proxy.example/api"), "https://proxy.example/api");
});

test("detectCred: kind from prefix, oauth.json blob, junk", () => {
  assert.deepEqual(detectCred("sk-ant-api03-abc"), { token: "sk-ant-api03-abc", kind: "apikey" });
  assert.deepEqual(detectCred("  sk-ant-oat01-xyz "), { token: "sk-ant-oat01-xyz", kind: "oauth" });   // trimmed
  // a pasted oauth.json → oauth + a real expiry to count down
  assert.deepEqual(detectCred('{"access_token":"sk-ant-oat01-zzz","refresh_token":"r","expires_at":1782500000}'), { token: "sk-ant-oat01-zzz", kind: "oauth", expiresAt: 1782500000 });
  assert.equal(detectCred(""), null);
  assert.equal(detectCred("   "), null);
  // an unknown-shaped token defaults to apikey (the documented browser-direct credential)
  assert.equal(detectCred("whatever-token")!.kind, "apikey");
});

test("buildDirectAnthropic: OAuth envelope = Bearer + oauth-beta + marker + dangerous header", () => {
  const cred: Cred = { token: "sk-ant-oat01-tok", kind: "oauth" };
  const { url, headers, body } = buildDirectAnthropic({ system: "SYS", messages: [{ role: "user", content: "hi" }], tools: [{ name: "t" }], model: "claude-opus-4-8", max_tokens: 100 }, cred);
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers["authorization"], "Bearer sk-ant-oat01-tok");
  assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(headers["x-api-key"], undefined);
  // the Claude-agent marker is the FIRST system block (required for subscription-OAuth)
  assert.match(body.system[0].text, /Claude agent/);
  assert.equal(body.system[1].text, "SYS");
  assert.deepEqual(body.system[body.system.length - 1].cache_control, { type: "ephemeral" });   // cache the system prompt
  assert.deepEqual(body.tools[body.tools.length - 1].cache_control, { type: "ephemeral" });
  assert.equal(body.stream, true);
});

test("buildDirectAnthropic: API-key envelope = x-api-key, NO marker / oauth header", () => {
  const cred: Cred = { token: "sk-ant-api03-key", kind: "apikey" };
  const { headers, body } = buildDirectAnthropic({ system: "SYS", messages: [{ role: "user", content: "hi" }] }, cred);
  assert.equal(headers["x-api-key"], "sk-ant-api03-key");
  assert.equal(headers["authorization"], undefined);
  assert.equal(headers["anthropic-beta"], undefined);
  assert.equal(headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(body.system[0].text, "SYS");   // no marker prepended
  assert.ok(!body.system.some((b: any) => /Claude agent/.test(b.text)));
});

test("buildDirectAnthropic: does NOT mutate the caller's shared tools/messages arrays", () => {
  const tools = [{ name: "a" }, { name: "b" }];
  const messages = [{ role: "user", content: "hi" }];
  buildDirectAnthropic({ system: "S", messages, tools, model: "m", max_tokens: 8 }, { token: "k", kind: "apikey" });
  assert.equal((tools[1] as any).cache_control, undefined, "tools array must be untouched (reused across turns)");
  assert.equal(typeof messages[0].content, "string", "messages must be untouched");
});

test("modeOf: precedence off > local > cred > proxy", () => {
  const key: Cred = { token: "sk-ant-api03-k", kind: "apikey" };
  const oat: Cred = { token: "sk-ant-oat01-k", kind: "oauth" };
  assert.equal(modeOf("anthropic", oat, true), "off");        // off wins over everything
  assert.equal(modeOf("openai", key, false), "local");        // openai provider → local (even with a cred present)
  assert.equal(modeOf("anthropic", oat, false), "oauth");     // pasted OAuth → browser-direct oauth
  assert.equal(modeOf("anthropic", key, false), "key");       // pasted API key
  assert.equal(modeOf("anthropic", null, false), "proxy");    // nothing pasted → proxy
});

test("statusOf: none / active / expiring / expired (and runtime-expired override)", () => {
  const now = 1_782_000_000_000;   // fixed ms
  assert.equal(statusOf(null, false, now).state, "none");
  assert.equal(statusOf({ token: "k", kind: "apikey" }, false, now).state, "active");   // bare key, no expiry
  assert.equal(statusOf({ token: "k", kind: "oauth" }, true, now).state, "expired");    // a 401 flipped it
  const soon = { token: "k", kind: "oauth" as const, expiresAt: now / 1000 + 300 };     // 5 min left
  assert.equal(statusOf(soon, false, now).state, "expiring");
  const ok = { token: "k", kind: "oauth" as const, expiresAt: now / 1000 + 7200 };       // 2 h left
  assert.equal(statusOf(ok, false, now).state, "active");
  const dead = { token: "k", kind: "oauth" as const, expiresAt: now / 1000 - 10 };
  assert.equal(statusOf(dead, false, now).state, "expired");
});
