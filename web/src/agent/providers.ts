// Pluggable agent backend: the Anthropic Messages API vs an OpenAI-compatible server (vLLM serving qwen3). Pure +
// dependency-free (no DOM, no import from live.ts) so `node --test` exercises the translation directly.
//
// The CANONICAL conversation is Anthropic-shaped (content blocks: text / tool_use / tool_result) — see live.ts
// runLive, which stores it in app.liveMessages and persists it (persist.ts SerConversation). The OpenAI adapter
// translates that canonical history → OpenAI chat-completions shape on each request, and normalizes the OpenAI SSE
// back into the SAME op stream the Anthropic path emits — so runLive's loop, tool dispatch, history, trimming, and
// persistence stay provider-agnostic. Switching back to Anthropic is a no-op (canonical IS Anthropic).

export type Provider = "anthropic" | "openai";
export interface Tool { name: string; description: string; input_schema: any; }
export interface AgentReq { system: string; messages: any[]; tools: Tool[]; maxTokens: number; }

// Normalized streaming ops — they mirror the Anthropic content-block transitions EXACTLY, so the Anthropic adapter
// stays byte-for-byte identical to the old inline parser, and the OpenAI adapter SYNTHESIZES the same op sequence
// (OpenAI has no explicit block boundaries). runLive folds these into canonical assistant blocks + UI.
export type StreamOp =
  | { op: "textStart" }
  | { op: "text"; text: string }
  | { op: "toolStart"; id: string; name: string }
  | { op: "toolArgs"; json: string }
  | { op: "blockStop" }
  | { op: "stop"; reason: string }
  | { op: "usage"; usage: any };

export type ParseState = Record<string, any>;
export interface ProviderAdapter {
  buildBody(r: AgentReq): any;          // provider-native request body (auth/cache framing is added proxy-side)
  newState(): ParseState;               // fresh per-turn streaming state
  parseEvent(data: any, st: ParseState): StreamOp[];   // one decoded SSE `data:` object → normalized ops
}

export const MODELS: Record<Provider, string> = { anthropic: "claude-opus-4-8", openai: "qwen3-8b" };
export function providerModel(p: Provider): string { return MODELS[p] || MODELS.anthropic; }

// Dev switch (no UI for now): a localStorage flag, default anthropic. Guarded so this pure module still loads under
// node (where localStorage is undefined) — see window.p2.setProvider() in shell.ts to flip it.
export const PROVIDER_KEY = "p3-agent-provider";
export function getProvider(): Provider {
  try { const v = typeof localStorage !== "undefined" ? localStorage.getItem(PROVIDER_KEY) : null; if (v === "openai" || v === "anthropic") return v as Provider; } catch { /* node / private mode */ }
  return "openai";   // TEMP active-testing default → local qwen/vLLM. p2.setProvider("anthropic") overrides per-browser; flip this line back to "anthropic" when done.
}
export function adapterFor(p: Provider): ProviderAdapter { return p === "openai" ? openaiAdapter : anthropicAdapter; }

// ───────────────────────── Anthropic ─────────────────────────
// buildBody returns exactly what runLive used to POST ({system string, messages, tools, model, max_tokens}); the
// proxy still adds the CC marker + cache_control. parseEvent reproduces the old inline content_block_* handling.
export const anthropicAdapter: ProviderAdapter = {
  buildBody(r) { return { system: r.system, messages: r.messages, tools: r.tools, model: MODELS.anthropic, max_tokens: r.maxTokens }; },
  newState() { return {}; },
  parseEvent(ev) {
    if (ev.type === "content_block_start") {
      if (ev.content_block?.type === "tool_use") return [{ op: "toolStart", id: ev.content_block.id, name: ev.content_block.name }];
      if (ev.content_block?.type === "text") return [{ op: "textStart" }];
      return [];
    }
    if (ev.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta") return [{ op: "text", text: ev.delta.text || "" }];
      if (ev.delta?.type === "input_json_delta") return [{ op: "toolArgs", json: ev.delta.partial_json || "" }];
      return [];
    }
    if (ev.type === "content_block_stop") return [{ op: "blockStop" }];
    if (ev.type === "message_delta") { const ops: StreamOp[] = []; if (ev.usage) ops.push({ op: "usage", usage: ev.usage }); if (ev.delta?.stop_reason) ops.push({ op: "stop", reason: ev.delta.stop_reason }); return ops; }
    if (ev.type === "message_start") return ev.message?.usage ? [{ op: "usage", usage: ev.message.usage }] : [];
    return [];
  },
};

// ───────────────────────── OpenAI-compatible (vLLM / qwen3) ─────────────────────────
export const openaiAdapter: ProviderAdapter = {
  buildBody(r) {
    const messages: any[] = [];
    if (r.system) messages.push({ role: "system", content: r.system });
    for (const m of r.messages) messages.push(...canonicalToOpenAIMessages(m));
    const body: any = {
      model: MODELS.openai,
      messages,
      max_tokens: r.maxTokens,
      stream: true,
      stream_options: { include_usage: true },        // needed to get usage on the final streamed chunk
      chat_template_kwargs: { enable_thinking: false }, // qwen3: no <think> — faster + cleaner tool args
    };
    if (r.tools && r.tools.length) {
      body.tools = r.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      body.tool_choice = "auto";
    }
    return body;
  },
  newState() { return { textOpen: false, toolOpen: false, idx: -1, inThink: false }; },
  parseEvent(ev, st) {
    const ops: StreamOp[] = [];
    const ch = ev.choices && ev.choices[0];
    if (ch && ch.delta) {
      if (typeof ch.delta.content === "string" && ch.delta.content.length) {
        const vis = stripThink(ch.delta.content, st);   // defensive — thinking is disabled, but never leak it
        if (vis) {
          if (st.toolOpen) { ops.push({ op: "blockStop" }); st.toolOpen = false; }
          if (!st.textOpen) { ops.push({ op: "textStart" }); st.textOpen = true; }
          ops.push({ op: "text", text: vis });
        }
      }
      const tcs = ch.delta.tool_calls;
      if (Array.isArray(tcs)) for (const tc of tcs) {
        const starts = !!(tc.id || (tc.function && tc.function.name));
        const newIdx = tc.index == null ? st.idx : tc.index;
        if (starts && (!st.toolOpen || newIdx !== st.idx)) {
          if (st.textOpen) { ops.push({ op: "blockStop" }); st.textOpen = false; }
          if (st.toolOpen) ops.push({ op: "blockStop" });   // close the previous tool before opening the next
          ops.push({ op: "toolStart", id: tc.id || ("call_" + newIdx), name: (tc.function && tc.function.name) || "" });
          st.toolOpen = true; st.idx = newIdx;
        }
        if (tc.function && typeof tc.function.arguments === "string" && tc.function.arguments.length) ops.push({ op: "toolArgs", json: tc.function.arguments });
      }
    }
    if (ch && ch.finish_reason) {
      if (st.textOpen || st.toolOpen) { ops.push({ op: "blockStop" }); st.textOpen = false; st.toolOpen = false; }
      ops.push({ op: "stop", reason: mapFinish(ch.finish_reason) });
    }
    if (ev.usage) ops.push({ op: "usage", usage: ev.usage });
    return ops;
  },
};

function mapFinish(fr: string): string { return fr === "tool_calls" ? "tool_use" : fr === "stop" ? "end_turn" : fr === "length" ? "max_tokens" : fr; }

// One canonical (Anthropic-shaped) message → one or more OpenAI messages.
export function canonicalToOpenAIMessages(m: any): any[] {
  if (m.role === "user" && typeof m.content === "string") return [{ role: "user", content: m.content }];
  // a user turn carrying tool_result blocks → one role:"tool" message per result (tool_use_id ↔ tool_call_id)
  if (m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"))
    return m.content.filter((b: any) => b.type === "tool_result").map((b: any) => ({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) }));
  if (m.role === "user" && Array.isArray(m.content)) return [{ role: "user", content: m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") }];
  if (m.role === "assistant") {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content || "") }];
    const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const toolUses = blocks.filter((b: any) => b.type === "tool_use");
    const msg: any = { role: "assistant", content: text || null };
    if (toolUses.length) msg.tool_calls = toolUses.map((b: any) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
    return [msg];
  }
  return [];
}

// Strip <think>…</think> from a streamed fragment, carrying the open/closed state across fragments via `st.inThink`.
export function stripThink(s: string, st: ParseState): string {
  let out = "", i = 0;
  while (i < s.length) {
    if (st.inThink) { const e = s.indexOf("</think>", i); if (e < 0) { i = s.length; } else { i = e + 8; st.inThink = false; } }
    else { const o = s.indexOf("<think>", i); if (o < 0) { out += s.slice(i); i = s.length; } else { out += s.slice(i, o); i = o + 7; st.inThink = true; } }
  }
  return out;
}
