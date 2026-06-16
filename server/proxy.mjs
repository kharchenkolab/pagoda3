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

const PORT = Number(process.env.PROXY_PORT || 8786);
const OAUTH_STORE = `${process.env.HOME}/.aba/oauth.json`;
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REFRESH_SKEW = 120;
// Byte-exact first system block the API requires for OAuth bearer on non-Haiku models.
const CC_MARKER = { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." };

function loadStore() { try { return JSON.parse(fs.readFileSync(OAUTH_STORE, "utf8")); } catch { return null; } }

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
      let auth;
      try { auth = await bearer(); } catch (e) { res.statusCode = 503; return res.end(JSON.stringify({ error: String(e.message || e) })); }
      let payload; try { payload = JSON.parse(body); } catch { res.statusCode = 400; return res.end(JSON.stringify({ error: "bad json" })); }
      const sys = [];
      if (auth.mode === "oauth") sys.push(CC_MARKER);
      if (payload.system) sys.push({ type: "text", text: String(payload.system) });
      const out = {
        model: payload.model || "claude-opus-4-8",
        max_tokens: payload.max_tokens || 4096,
        stream: true,
        system: sys,
        messages: payload.messages || [],
      };
      if (payload.tools) out.tools = payload.tools;
      // PROMPT CACHING: the system prompt + tool definitions are large and stable across a conversation's turns —
      // mark the last block of each so Anthropic caches them (5-min TTL), so they're written once and read (cheap)
      // on every follow-up turn instead of re-billed in full. Transparent to results.
      if (out.system && out.system.length) out.system[out.system.length - 1] = { ...out.system[out.system.length - 1], cache_control: { type: "ephemeral" } };
      if (out.tools && out.tools.length) out.tools[out.tools.length - 1] = { ...out.tools[out.tools.length - 1], cache_control: { type: "ephemeral" } };
      if (payload.thinking) out.thinking = payload.thinking;
      const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
      if (auth.mode === "oauth") { headers["authorization"] = `Bearer ${auth.token}`; headers["anthropic-beta"] = "oauth-2025-04-20"; }
      else headers["x-api-key"] = auth.key;
      let up;
      try { up = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(out) }); }
      catch (e) { res.statusCode = 502; return res.end(JSON.stringify({ error: String(e) })); }
      res.statusCode = up.status;
      res.setHeader("content-type", up.headers.get("content-type") || "text/event-stream");
      if (!up.ok) { const t = await up.text(); return res.end(t); }
      const reader = up.body.getReader();
      const pump = async () => {
        for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
        res.end();
      };
      pump().catch(() => res.end());
    });
    return;
  }
  res.statusCode = 404; res.end("not found");
});

server.on("error", (e) => { if (e.code === "EADDRINUSE") { console.log(`[proxy] port ${PORT} already in use — assuming a proxy is running`); process.exit(0); } else throw e; });
server.listen(PORT, () => console.log(`[proxy] agent proxy on http://localhost:${PORT}`));
