// Browser-direct Anthropic credentials — the zero-process agent path. When the user pastes a credential, the agent
// calls api.anthropic.com directly (no proxy). The SAME field accepts BOTH an API key and a Claude-subscription OAuth
// access token: we detect the kind from the token shape and build the matching request envelope. OAuth tokens are
// short-lived, so we surface that and detect expiry on a 401 mid-run. Nothing here is ever sent anywhere but Anthropic;
// the token lives only in this browser's localStorage. (Verified live: a browser-origin POST with the OAuth Bearer +
// oauth-beta header passes CORS — Anthropic's dangerous-direct-browser-access mode permits it.)

export type CredKind = "apikey" | "oauth";
export interface Cred { token: string; kind: CredKind; expiresAt?: number; }   // expiresAt = epoch SECONDS, when known

const STORE = "p3-agent-cred";
const LOCAL = "p3-agent-local";   // a client-configured local OpenAI-compatible endpoint (browser-direct, no proxy)
const OFF = "p3-agent-off";       // explicit "no copilot" — disables the agent even if a proxy is reachable

// ---- the agent endpoint CONFIG beyond the Anthropic credential: a local model + an explicit off switch ----
export interface LocalCfg { url: string; model: string; }
export function localCfg(): LocalCfg | null { try { const s = localStorage.getItem(LOCAL); return s ? JSON.parse(s) as LocalCfg : null; } catch { return null; } }
export function setLocalCfg(url: string, model: string): void { try { localStorage.setItem(LOCAL, JSON.stringify({ url: (url || "").trim().replace(/\/+$/, ""), model: (model || "").trim() })); } catch { /* */ } }
export function clearLocalCfg(): void { try { localStorage.removeItem(LOCAL); } catch { /* */ } }
export function agentOff(): boolean { try { return localStorage.getItem(OFF) === "1"; } catch { return false; } }
export function setAgentOff(b: boolean): void { try { if (b) localStorage.setItem(OFF, "1"); else localStorage.removeItem(OFF); } catch { /* */ } }

// The ACTIVE mode, resolved from the stored prefs (sync; proxy REACHABILITY is checked separately by the UI). modeOf is
// the pure core (node-testable); resolveMode reads the live prefs. Precedence: off > local(openai) > pasted cred > proxy.
export type AgentMode = "off" | "oauth" | "key" | "local" | "proxy";
export function modeOf(provider: "anthropic" | "openai", cred: Cred | null, off: boolean): AgentMode {
  if (off) return "off";
  if (provider === "openai") return "local";
  if (cred) return cred.kind === "oauth" ? "oauth" : "key";
  return "proxy";
}
export function resolveMode(provider: "anthropic" | "openai"): AgentMode { return modeOf(provider, loadCred(), agentOff()); }
// The exact system marker the proxy prepends in OAuth mode — subscription-OAuth calls are validated as coming from a
// Claude agent, so a browser-direct OAuth request must carry it too or it's refused.
const MARKER = { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." };

// Parse what was pasted: a bare token, OR the contents of an oauth.json ({access_token, expires_at} — which gives us a
// real expiry to count down). Detect kind from the prefix: sk-ant-oat… = OAuth access token, sk-ant-api… = API key
// (the default when unsure, since that's the documented browser-direct credential).
export function detectCred(raw: string): Cred | null {
  const s = (raw || "").trim();
  if (!s) return null;
  if (s[0] === "{") {   // an oauth.json blob → carries expires_at
    try { const j = JSON.parse(s); const t = j.access_token || j.token; if (t) return { token: String(t).trim(), kind: "oauth", expiresAt: j.expires_at != null ? Number(j.expires_at) : undefined }; } catch { /* not json — treat as a bare token below */ }
  }
  const kind: CredKind = /^sk-ant-oat/i.test(s) ? "oauth" : "apikey";
  return { token: s, kind };
}

let runtimeExpired = false;   // flipped by a 401 mid-run for a bare token whose expiry we can't read upfront

export function saveCred(raw: string): Cred | null {
  const c = detectCred(raw); if (!c) return null;
  runtimeExpired = false;
  try { localStorage.setItem(STORE, JSON.stringify(c)); } catch { /* private mode / node */ }
  return c;
}
export function loadCred(): Cred | null {
  try { const s = localStorage.getItem(STORE); return s ? JSON.parse(s) as Cred : null; } catch { return null; }
}
export function clearCred(): void { runtimeExpired = false; try { localStorage.removeItem(STORE); } catch { /* */ } }
export function markCredExpired(): void { runtimeExpired = true; }
export function markCredOk(): void { runtimeExpired = false; }

export type CredState = "none" | "active" | "expiring" | "expired";
export interface CredStatus { state: CredState; kind?: CredKind; expiresAt?: number; secondsLeft?: number; }

// Pure status from a credential + the runtime-expired flag (separated so it's node-testable without localStorage).
export function statusOf(c: Cred | null, expired: boolean, nowMs: number): CredStatus {
  if (!c) return { state: "none" };
  if (expired) return { state: "expired", kind: c.kind, expiresAt: c.expiresAt, secondsLeft: 0 };
  if (c.expiresAt) {
    const left = c.expiresAt - nowMs / 1000;
    if (left <= 0) return { state: "expired", kind: c.kind, expiresAt: c.expiresAt, secondsLeft: 0 };
    if (left < 900) return { state: "expiring", kind: c.kind, expiresAt: c.expiresAt, secondsLeft: Math.round(left) };   // < 15 min
    return { state: "active", kind: c.kind, expiresAt: c.expiresAt, secondsLeft: Math.round(left) };
  }
  return { state: "active", kind: c.kind };   // bare token — expiry unknown until a 401 flips runtimeExpired
}
export function credStatus(nowMs?: number): CredStatus { return statusOf(loadCred(), runtimeExpired, nowMs ?? hostNow()); }
function hostNow(): number { try { return Date.now(); } catch { return 0; } }

// Build the browser-direct Anthropic request from the adapter's buildBody output, replicating EXACTLY what the proxy
// adds server-side (the Claude-agent marker for OAuth, prompt-cache framing, version headers) plus the browser-direct
// opt-in header. Does not mutate the caller's shared arrays (TOOLS / messages are reused across turns).
export function buildDirectAnthropic(body: { system?: string; messages: any[]; tools?: any[]; model?: string; max_tokens?: number }, cred: Cred): { url: string; headers: Record<string, string>; body: any } {
  const oauth = cred.kind === "oauth";
  const sys: any[] = [];
  if (oauth) sys.push(MARKER);
  if (body.system) sys.push({ type: "text", text: String(body.system) });
  if (sys.length) sys[sys.length - 1] = { ...sys[sys.length - 1], cache_control: { type: "ephemeral" } };   // cache the big stable system prompt
  const out: any = { model: body.model || "claude-opus-4-8", max_tokens: body.max_tokens || 4096, stream: true, system: sys, messages: (body.messages || []).slice() };
  if (body.tools && body.tools.length) { out.tools = body.tools.slice(); out.tools[out.tools.length - 1] = { ...out.tools[out.tools.length - 1], cache_control: { type: "ephemeral" } }; }
  if (out.messages.length) {   // cache the conversation prefix — mark the last message so each turn READS the cached prior turns
    const lm = out.messages[out.messages.length - 1];
    if (typeof lm.content === "string") out.messages[out.messages.length - 1] = { ...lm, content: [{ type: "text", text: lm.content, cache_control: { type: "ephemeral" } }] };
    else if (Array.isArray(lm.content) && lm.content.length) { const cc = lm.content.slice(); cc[cc.length - 1] = { ...cc[cc.length - 1], cache_control: { type: "ephemeral" } }; out.messages[out.messages.length - 1] = { ...lm, content: cc }; }
  }
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
  if (oauth) { headers["authorization"] = `Bearer ${cred.token}`; headers["anthropic-beta"] = "oauth-2025-04-20"; }
  else headers["x-api-key"] = cred.token;
  return { url: "https://api.anthropic.com/v1/messages", headers, body: out };
}
