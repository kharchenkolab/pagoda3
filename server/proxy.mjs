// pagoda2 agent proxy — keeps the Anthropic credential server-side and relays the
// Messages API (SSE) to the browser. Auth borrows the local Claude Code OAuth token
// (~/.aba/oauth.json), per project directive; refreshes near expiry. An API-key mode
// and a browser OAuth (PKCE/UI-forwarding) sign-in are stubbed for later.
//
//   GET  /api/health            -> { ok, mode, expires_in }
//   POST /api/agent/stream      -> body {system, messages, tools, model, max_tokens}
//                                  relays Anthropic SSE; injects the CC system marker.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";

const PORT = Number(process.env.PROXY_PORT || 8786);
const OAUTH_STORE = `${process.env.HOME}/.aba/oauth.json`;
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REFRESH_SKEW = 120;
// Byte-exact first system block the API requires for OAuth bearer on non-Haiku models.
const CC_MARKER = { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." };
// Second upstream: a local OpenAI-compatible server (vLLM/qwen3) for the swappable agent provider. No auth by default
// (it's local, behind an SSH tunnel); the client tags the turn provider:"openai" and sends an already-OpenAI body.
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "http://localhost:8001/v1").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

function loadStore() { try { return JSON.parse(fs.readFileSync(OAUTH_STORE, "utf8")); } catch { return null; } }

// Per-request agent log (JSONL) — the chokepoint EVERY agent turn flows through (app + harness), so this is the one
// place to see latency, turn counts, tool calls, and prompt-cache hit/miss across all sessions. Analyze with jq/node.
const AGENT_LOG = process.env.PAGODA_AGENT_LOG || "/tmp/pagoda-agent.jsonl";
function logAgent(rec) { try { fs.appendFileSync(AGENT_LOG, JSON.stringify(rec) + "\n"); } catch { /* non-fatal */ } }

// FULL-CONTENT debug capture (opt-in: PAGODA_AGENT_DEBUG=1). Off by default — the telemetry log above stays the only
// write. When on, every agent turn's full request transcript + assistant response is dumped so the live session can be
// inspected end-to-end (prompts, tool inputs/outputs, replies), not just telemetry. Layout, optimised for "what is the
// session I'm running RIGHT NOW doing?":
//   <dir>/current.json     — ALWAYS the latest full conversation (overwritten each turn). One file → read it first.
//   <dir>/sess-<runId>.jsonl — per-session history: one line per turn (the delta: triggering user turn + the reply).
// Each conversation carries a client-minted runId so concurrent tabs / the preview don't get conflated.
const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.PAGODA_AGENT_DEBUG || ""));
const DEBUG_DIR = process.env.PAGODA_AGENT_DEBUG_DIR || "/tmp/pagoda-debug";
if (DEBUG) { try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); } catch { /* */ } }
function writeDebug(rec) {
  if (!DEBUG) return;
  try {
    fs.writeFileSync(`${DEBUG_DIR}/current.json`, JSON.stringify(rec, null, 2));   // overwrite → current.json is the live session
    const id = String(rec.runId || "session").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "session";
    fs.appendFileSync(`${DEBUG_DIR}/sess-${id}.jsonl`, JSON.stringify({ t: rec.t, store: rec.store, turn: rec.turnIndex, stop: rec.stop, usage: rec.usage, user: rec.lastUser, assistant: rec.response }) + "\n");
  } catch { /* non-fatal */ }
}

// Tee-parse a buffered SSE stream → { usage, tools, stop, textChars, dbgText, dbgTools } for telemetry + debug. One
// per provider (the wire formats differ); the byte relay itself is provider-agnostic.
function teeAnthropic(raw) {
  let usage = {}, tools = [], stop = "", textChars = 0, dbgText = "", dbgTools = [], curTool = null, curJson = "";
  for (const line of raw.split("\n")) { if (!line.startsWith("data:")) continue; let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (ev.type === "message_start") usage = { ...(ev.message && ev.message.usage || {}) };
    else if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "tool_use") { tools.push(ev.content_block.name); curTool = { name: ev.content_block.name, input: undefined }; curJson = ""; }
    else if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") { textChars += (ev.delta.text || "").length; dbgText += ev.delta.text || ""; }
    else if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "input_json_delta") curJson += ev.delta.partial_json || "";
    else if (ev.type === "content_block_stop" && curTool) { try { curTool.input = curJson ? JSON.parse(curJson) : {}; } catch { curTool.input = curJson; } dbgTools.push(curTool); curTool = null; }
    else if (ev.type === "message_delta") { if (ev.usage) usage = { ...usage, ...ev.usage }; if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; }
  }
  return { usage, tools, stop, textChars, dbgText, dbgTools };
}
function teeOpenAI(raw) {
  let usage = {}, tools = [], stop = "", textChars = 0, dbgText = "", dbgTools = [], curName = null, curJson = "", curIdx = -1;
  const flush = () => { if (curName != null) { let inp; try { inp = curJson ? JSON.parse(curJson) : {}; } catch { inp = curJson; } dbgTools.push({ name: curName, input: inp }); curName = null; curJson = ""; } };
  for (const line of raw.split("\n")) { if (!line.startsWith("data:")) continue; const d = line.slice(5).trim(); if (d === "[DONE]") continue; let ev; try { ev = JSON.parse(d); } catch { continue; }
    const ch = ev.choices && ev.choices[0];
    if (ch && ch.delta) {
      if (typeof ch.delta.content === "string") { textChars += ch.delta.content.length; dbgText += ch.delta.content; }
      const tcs = ch.delta.tool_calls;
      if (Array.isArray(tcs)) for (const tc of tcs) {
        if ((tc.id || (tc.function && tc.function.name)) && (tc.index == null || tc.index !== curIdx)) { flush(); curIdx = tc.index == null ? curIdx : tc.index; curName = (tc.function && tc.function.name) || ""; tools.push(curName); }
        if (tc.function && typeof tc.function.arguments === "string") curJson += tc.function.arguments;
      }
    }
    if (ch && ch.finish_reason) { flush(); stop = ch.finish_reason === "tool_calls" ? "tool_use" : ch.finish_reason === "stop" ? "end_turn" : ch.finish_reason; }
    if (ev.usage) usage = ev.usage;
  }
  flush();
  return { usage, tools, stop, textChars, dbgText, dbgTools };
}

// ---- web fetch (for the agent's fetch_url tool: consult an external viz/technique reference) ----
// SSRF guard: only http(s), and refuse loopback / link-local / private-range hosts so the tool can't be steered at
// internal services. (Literal-host checks only — adequate for a local single-user dev tool.)
function blockedHost(h) {
  h = (h || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "127.0.0.1" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^fe80:|^fc|^fd/.test(h)) return true;
  return false;
}
// External DATA fetch for widgets (pagoda.fetchExternal): only these registrable domains, https-only — keeps a widget
// from reaching arbitrary hosts while opening the curated set of bio data sources. host === D or *.D.
const EXT_ALLOW = ["rcsb.org", "ebi.ac.uk", "ensembl.org", "uniprot.org", "ncbi.nlm.nih.gov", "alphafold.ebi.ac.uk", "string-db.org", "reactome.org"];
function extAllowed(host) { host = (host || "").toLowerCase(); return EXT_ALLOW.some((d) => host === d || host.endsWith("." + d)); }
const extCache = new Map();   // tiny response cache (url -> {ct, body}) so preview/probe re-runs don't re-hit the API

// LIBRARY REGISTRY for pagoda.loadLib(name): a curated, version-PINNED allowlist of JS libraries widgets may load.
// The host fetches the pinned build once (optionally SHA-384-verified), caches it, and serves it; the widget never
// touches a CDN itself. Adding a library = one entry here (the general extension point). global = the window symbol.
const LIB_REGISTRY = {
  "3dmol": { url: "https://cdn.jsdelivr.net/npm/3dmol@2.4.2/build/3Dmol-min.js", global: "$3Dmol", integrity: "sha384-zxWwO8usW1MzUHquSL3foT+Cw2ndelPQ5bNzHVYdKGiJ0vqvqQ8Y9XeKLmotffmQ" },
  "d3": { url: "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js", global: "d3", integrity: "sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i" },
};
const libCache = new Map();
function htmlToText(h) {
  return h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

async function refresh(store) {
  const r = await fetch(TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: store.refresh_token, client_id: CLIENT_ID }),
  });
  if (!r.ok) throw new Error(`oauth refresh failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  const next = { access_token: d.access_token, refresh_token: d.refresh_token || store.refresh_token, expires_at: Date.now() / 1000 + (d.expires_in || 3600) };
  try { fs.writeFileSync(OAUTH_STORE, JSON.stringify(next, null, 2)); } catch {}
  console.log("[proxy] refreshed OAuth token");
  return next.access_token;
}

async function bearer() {
  if (process.env.ANTHROPIC_API_KEY) return { mode: "apikey", key: process.env.ANTHROPIC_API_KEY };
  const store = loadStore();
  if (!store?.access_token) throw new Error("no OAuth token in ~/.aba/oauth.json and no ANTHROPIC_API_KEY");
  if (store.refresh_token && store.expires_at && Date.now() / 1000 >= store.expires_at - REFRESH_SKEW) {
    return { mode: "oauth", token: await refresh(store) };
  }
  return { mode: "oauth", token: store.access_token };
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/health") {
    try { const auth = await bearer(); const store = loadStore(); res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: true, mode: auth.mode, expires_in: store?.expires_at ? Math.round(store.expires_at - Date.now() / 1000) : null })); }
    catch (e) { res.statusCode = 503; res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
  }

  if (url.pathname === "/api/agent/stream" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", async () => {
      let payload; try { payload = JSON.parse(body); } catch { res.statusCode = 400; return res.end(JSON.stringify({ error: "bad json" })); }
      const provider = payload.provider === "openai" ? "openai" : "anthropic";
      let url2, headers, out;
      if (provider === "openai") {
        // Pass the client's already-OpenAI-shaped body straight through to the local vLLM server. No OAuth, no CC
        // marker, no cache_control / anthropic headers (vLLM rejects unknown fields). The relay below is identical.
        const { provider: _p, client: _c, runId: _r, store: _s, ...rest } = payload;
        out = { ...rest, stream: true };
        if (typeof out.stream_options === "undefined") out.stream_options = { include_usage: true };
        headers = { "content-type": "application/json" };
        if (OPENAI_API_KEY) headers["authorization"] = `Bearer ${OPENAI_API_KEY}`;
        url2 = `${OPENAI_BASE_URL}/chat/completions`;
      } else {
        let auth;
        try { auth = await bearer(); } catch (e) { res.statusCode = 503; return res.end(JSON.stringify({ error: String(e.message || e) })); }
        const sys = [];
        if (auth.mode === "oauth") sys.push(CC_MARKER);
        if (payload.system) sys.push({ type: "text", text: String(payload.system) });
        out = { model: payload.model || "claude-opus-4-8", max_tokens: payload.max_tokens || 4096, stream: true, system: sys, messages: payload.messages || [] };
        if (payload.tools) out.tools = payload.tools;
        // PROMPT CACHING: the system prompt + tool definitions are large and stable across a conversation's turns —
        // mark the last block of each so Anthropic caches them (5-min TTL): written once, read (cheap) on follow-ups.
        if (out.system && out.system.length) out.system[out.system.length - 1] = { ...out.system[out.system.length - 1], cache_control: { type: "ephemeral" } };
        if (out.tools && out.tools.length) out.tools[out.tools.length - 1] = { ...out.tools[out.tools.length - 1], cache_control: { type: "ephemeral" } };
        // also cache the CONVERSATION prefix: mark the LAST message so each turn READS the cached prior turns.
        if (out.messages && out.messages.length) {
          const lm = out.messages[out.messages.length - 1];
          if (typeof lm.content === "string") lm.content = [{ type: "text", text: lm.content, cache_control: { type: "ephemeral" } }];
          else if (Array.isArray(lm.content) && lm.content.length) lm.content[lm.content.length - 1] = { ...lm.content[lm.content.length - 1], cache_control: { type: "ephemeral" } };
        }
        if (payload.thinking) out.thinking = payload.thinking;
        headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
        if (auth.mode === "oauth") { headers["authorization"] = `Bearer ${auth.token}`; headers["anthropic-beta"] = "oauth-2025-04-20"; }
        else headers["x-api-key"] = auth.key;
        url2 = "https://api.anthropic.com/v1/messages";
      }
      let up;
      try { up = await fetch(url2, { method: "POST", headers, body: JSON.stringify(out) }); }
      catch (e) { res.statusCode = 502; return res.end(JSON.stringify({ error: String(e) })); }
      const t0 = Date.now();
      res.statusCode = up.status;
      res.setHeader("content-type", up.headers.get("content-type") || "text/event-stream");
      if (!up.ok) { const t = await up.text(); logAgent({ t: new Date().toISOString(), ms: Date.now() - t0, client: payload.client || "?", provider, msgs: (out.messages || []).length, error: up.status, body: t.slice(0, 200) }); return res.end(t); }
      const reader = up.body.getReader(); const dec = new TextDecoder(); let raw = "";
      const pump = async () => {
        for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); raw += dec.decode(value, { stream: true }); }
        res.end();
        // tee-parse the buffered SSE (provider-specific) for telemetry + the DEBUG content dump.
        const r = provider === "openai" ? teeOpenAI(raw) : teeAnthropic(raw);
        const u = r.usage || {};
        logAgent({ t: new Date().toISOString(), ms: Date.now() - t0, client: payload.client || "?", provider, runId: payload.runId || null, store: payload.store || null, model: out.model, msgs: (out.messages || []).length,
          tools: r.tools, stop: r.stop || null, textChars: r.textChars, in: u.input_tokens ?? u.prompt_tokens ?? 0, cr: u.cache_read_input_tokens || 0, cc: u.cache_creation_input_tokens || 0, out: u.output_tokens ?? u.completion_tokens ?? 0,
          empty: r.tools.length === 0 && r.textChars === 0 });
        if (DEBUG) { const msgs = payload.messages || []; writeDebug({ t: new Date().toISOString(), runId: payload.runId || "session", client: payload.client || "?", provider, store: payload.store || null, model: out.model, turnIndex: msgs.length, stop: r.stop || null, usage: u, system: payload.system || "", messages: msgs, response: { text: r.dbgText, tools: r.dbgTools, stop: r.stop || null }, lastUser: msgs.length ? msgs[msgs.length - 1] : null }); }
      };
      pump().catch(() => res.end());
    });
    return;
  }
  if (url.pathname === "/api/web/fetch" && req.method === "GET") {
    let u; try { u = new URL(url.searchParams.get("url") || ""); } catch { res.statusCode = 400; return res.end("bad url"); }
    if (!/^https?:$/.test(u.protocol)) { res.statusCode = 400; return res.end("only http(s) URLs are allowed"); }
    if (blockedHost(u.hostname)) { res.statusCode = 403; return res.end("blocked host (loopback/private ranges are not fetchable)"); }
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 8000);
    try {
      const up = await fetch(u.href, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "pagoda-widget-agent", "accept": "text/html,text/plain,*/*" } });
      clearTimeout(to);
      const ct = up.headers.get("content-type") || "";
      let body = await up.text(); if (body.length > 400000) body = body.slice(0, 400000);
      const text = (/html/i.test(ct) || /^\s*</.test(body) ? htmlToText(body) : body).slice(0, 16000);
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res.end(text || "(empty response)");
    } catch (e) { clearTimeout(to); res.statusCode = 502; return res.end("fetch failed: " + String(e && e.message || e)); }
  }
  if (url.pathname === "/api/ext/fetch" && req.method === "GET") {
    let u; try { u = new URL(url.searchParams.get("url") || ""); } catch { res.statusCode = 400; return res.end("bad url"); }
    if (u.protocol !== "https:") { res.statusCode = 400; return res.end("https only"); }
    if (blockedHost(u.hostname) || !extAllowed(u.hostname)) { res.statusCode = 403; return res.end("host not in the external data allowlist (PDB/RCSB, UniProt, Ensembl, NCBI, AlphaFold, STRING, Reactome)"); }
    const hit = extCache.get(u.href);
    if (hit) { res.setHeader("content-type", hit.ct); return res.end(hit.body); }
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 12000);
    try {
      const up = await fetch(u.href, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "pagoda-widget", "accept": "application/json,text/plain,*/*" } });
      clearTimeout(to);
      if (!up.ok) { res.statusCode = up.status; return res.end("upstream " + up.status); }
      const buf = Buffer.from(await up.arrayBuffer());
      if (buf.length > 6_000_000) { res.statusCode = 413; return res.end("response too large (>6MB)"); }
      const ct = up.headers.get("content-type") || "text/plain";
      if (extCache.size > 40) extCache.clear();
      extCache.set(u.href, { ct, body: buf });
      res.setHeader("content-type", ct); res.setHeader("access-control-allow-origin", "*");
      return res.end(buf);
    } catch (e) { clearTimeout(to); res.statusCode = 502; return res.end("ext fetch failed: " + String(e && e.message || e)); }
  }
  if (url.pathname === "/api/lib" && req.method === "GET") {
    const name = url.searchParams.get("name") || "";
    if (!name) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(Object.keys(LIB_REGISTRY).map((k) => ({ name: k, global: LIB_REGISTRY[k].global })))); }   // no name → list the registry
    const lib = LIB_REGISTRY[name];
    if (!lib) { res.statusCode = 404; return res.end("unknown library '" + name + "' (registry: " + Object.keys(LIB_REGISTRY).join(", ") + ")"); }
    const hit = libCache.get(name);
    if (hit) { res.setHeader("content-type", "application/javascript"); res.setHeader("access-control-allow-origin", "*"); return res.end(hit); }
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 20000);
    try {
      const up = await fetch(lib.url, { signal: ac.signal, redirect: "follow" });
      clearTimeout(to);
      if (!up.ok) { res.statusCode = 502; return res.end("lib upstream " + up.status); }
      const src = Buffer.from(await up.arrayBuffer());
      if (lib.integrity) { const h = "sha384-" + crypto.createHash("sha384").update(src).digest("base64"); if (h !== lib.integrity) { res.statusCode = 502; return res.end("integrity mismatch for " + name); } }
      libCache.set(name, src);
      res.setHeader("content-type", "application/javascript"); res.setHeader("access-control-allow-origin", "*");
      return res.end(src);
    } catch (e) { clearTimeout(to); res.statusCode = 502; return res.end("lib fetch failed: " + String(e && e.message || e)); }
  }
  res.statusCode = 404; res.end("not found");
});

server.on("error", (e) => { if (e.code === "EADDRINUSE") { console.log(`[proxy] port ${PORT} already in use — assuming a proxy is running`); process.exit(0); } else throw e; });
server.listen(PORT, () => console.log(`[proxy] agent proxy on http://localhost:${PORT}`));
