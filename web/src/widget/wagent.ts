// The widget-AUTHORING agent loop — a self-contained streaming tool-use loop that drives the SAME proxy as the app
// agent, but with its OWN memory (conversation), tools (template/contract/preview/save), and recipe (system prompt).
// It's the thing we debug "on the side": give it a request, watch it fetch a template, write source, preview_widget
// to test+fix, then save_widget to mount. Prompt caching (system+tools) is applied proxy-side.
import { WidgetHost, previewWidget } from "./runtime.ts";
import { WIDGET_API_DOC } from "./contract.ts";
import { getWidgetTemplate, KITCHEN_SINK } from "./template.ts";
import { listRecipes, findRecipes, getRecipe } from "./recipes.ts";

const PROXY = "/api/agent/stream";

// The tools the authoring agent has. Small, named — the agent composes a widget through them.
const TOOLS = [
  { name: "read_widget_contract", description: "Return the full widget authoring contract (the pagoda API, data kinds, theming rules). Read it before writing if unsure.", input_schema: { type: "object", properties: {} } },
  { name: "find_widget_recipe", description: "LOOK UP recipes + snippets by free-text need (e.g. 'scatter hover', 'colour scale', 'histogram bins', 'axes'). Returns ranked matches — kind 'widget' = a complete widget to adapt; kind 'snippet' = inlinable building-block functions (the plot kit: scales, nice-ticks, canvas point cloud, nearest-point hit-test for hover/click, colour ramps, SVG axes, binning). This is how you get a plotting library while staying self-contained. For chart/viz/interaction work, look here FIRST.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_widget_recipe", description: "DELIVER a recipe/snippet's full SOURCE by name (from find/list) — a widget to adapt, or snippet helpers to paste in. Compose snippets + glue, then preview.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "get_widget_template", description: "Return a starter widget source to adapt. kind='kitchen' (default — demonstrates every capability) or 'blank' (minimal). Prefer find_widget_recipe for viz.", input_schema: { type: "object", properties: { kind: { type: "string" } } } },
  { name: "preview_widget", description: "Render the widget SOURCE in a sandbox and return {ok, error, logs, manifest, renderedText}. This is your TEST/DEBUG loop — call it after each draft, read the error/logs/renderedText, and FIX until ok:true before saving. NOTE: by default this only exercises the INITIAL render. To test interactive logic (button handlers, computed output, setSelection, etc.) pass `probe`: JS that runs after mount IN THE WIDGET'S OWN SCOPE — it can call your widget's top-level functions and set input values, e.g. \"document.querySelector('#ga').value='CD3E'; document.querySelector('#gb').value='CD19'; await compute();\". console.log inside the probe to inspect values; renderedText reflects the post-probe DOM and includes a [viz: …] summary of any SVG/canvas content (element counts + sizes, e.g. 'svg 440x120 (36 circle)'), so you can confirm a CHART drew WITHOUT a DOM-counting probe (data-driven draws are async — if a probe shows 0 elements, `await` a moment first).", input_schema: { type: "object", properties: { source: { type: "string", description: "the full widget source" }, probe: { type: "string", description: "optional JS run after mount in the widget's scope to exercise interactions; can be async (use await)" } }, required: ["source"] } },
  { name: "save_widget", description: "Mount the finished widget as the live panel. Only call once preview_widget returned ok:true.", input_schema: { type: "object", properties: { source: { type: "string" }, title: { type: "string" } }, required: ["source"] } },
];

// The RECIPE: how to build a widget, the contract, and a worked example — cached as part of the system prompt.
const SYSTEM =
  "You are the widget-authoring agent for the pagoda single-cell browser. You write small, self-contained interactive " +
  "widgets that run in a sandboxed iframe and coordinate with the app through the `pagoda` global.\n\n" +
  "WORKFLOW: (1) for chart/viz/interaction work, find_widget_recipe('what you need') first — it returns whole widgets to adapt AND inlinable snippets (the plot kit: scales, axes, canvas point cloud, nearest-point hit-test for hover/click, colour ramps, binning); get_widget_recipe each hit and compose them. Otherwise start from get_widget_template (the kitchen sink shows every capability); (2) adapt it to the request —" +
  "keep it minimal and focused; (3) preview_widget to TEST — read ok/error/logs/renderedText and FIX until ok:true. " +
  "preview only renders the INITIAL state, so whenever the widget has interactive logic (a button, a computed result, " +
  "setSelection, a search box), preview AGAIN with a `probe` that drives it (set input values, call your handler, then " +
  "inspect renderedText/logs) — don't ship interactive logic you haven't exercised; " +
  "(4) save_widget to mount it. Never save before a clean preview.\n\n" +
  "RULES: theme only via the injected CSS variables (var(--text), --dim, --faint, --panel, --inset, --line, --cyan, " +
  "--amber, --bad, --good, --sans, --mono) — never hardcode colours. Pull only the data you need via pagoda.data(...). " +
  "Call pagoda.ready({title, controls?}) once set up. Coordinate: pagoda.setSelection / setColor / setHint / updateView, " +
  "and react with pagoda.on('coord'|'theme'|'control', cb). Self-contained — no external network/CDN.\n\n" +
  "CONTRACT:\n" + WIDGET_API_DOC + "\n\nWORKED EXAMPLE (the kitchen sink):\n" + KITCHEN_SINK;

export interface WAgentEvent {
  type: "user" | "text" | "tool" | "tool-done" | "done" | "error";
  text?: string; tool?: string; detail?: string;
}

export function createWidgetAgent(opts: { host: WidgetHost; onSave: (source: string, title?: string) => void; onEvent: (e: WAgentEvent) => void }) {
  const messages: any[] = [];   // MEMORY: the running conversation, persisted across asks for follow-ups
  let lastSource = "";

  const dispatch = async (name: string, input: any): Promise<string> => {
    if (name === "read_widget_contract") return WIDGET_API_DOC;
    if (name === "find_widget_recipe") { const hits = findRecipes(String(input?.query || "")); return hits.length ? JSON.stringify(hits) : "no matches — " + JSON.stringify(listRecipes().map((r) => r.name)); }
    if (name === "get_widget_recipe") { const src = getRecipe(String(input?.name || "")); return src || "no recipe/snippet '" + input?.name + "'"; }
    if (name === "get_widget_template") return getWidgetTemplate(input?.kind);
    if (name === "preview_widget") {
      lastSource = String(input?.source || "");
      const roHost = { ...opts.host, apply: () => { /* preview is side-effect-free — don't mutate the host's coord/selection */ } };
      const r = await previewWidget(lastSource, roHost as any, 4000, input?.probe ? String(input.probe) : undefined);
      return JSON.stringify({ ok: r.ok, error: r.error, logs: r.logs.slice(-8), manifest: r.manifest, renderedText: (r.text || "").slice(0, 400) });
    }
    if (name === "save_widget") { lastSource = String(input?.source || lastSource); opts.onSave(lastSource, input?.title); return "saved + mounted on the workbench"; }
    return `unknown tool ${name}`;
  };

  async function ask(text: string, abort?: AbortSignal): Promise<void> {
    messages.push({ role: "user", content: text });
    opts.onEvent({ type: "user", text });
    try {
      let emptyRetries = 0;
      for (let turn = 0; turn < 12; turn++) {
        if (abort?.aborted) break;
        const res = await fetch(PROXY, { method: "POST", signal: abort, headers: { "content-type": "application/json" },
          body: JSON.stringify({ system: SYSTEM, messages, tools: TOOLS, model: "claude-opus-4-8", max_tokens: 8192 }) });
        if (!res.ok || !res.body) { opts.onEvent({ type: "error", text: `agent unreachable (${res.status})` }); return; }
        const { assistant, stop, finalText } = await streamTurn(res.body, opts.onEvent);
        // A 200 with NO content (no tool_use, no text) is a transient API hiccup — retry the turn instead of silently
        // ending (which looks like a clean finish and abandons an in-progress widget). Don't append the empty turn.
        if (!assistant.length && !(finalText || "").trim()) { if (emptyRetries++ < 2) { turn--; continue; } opts.onEvent({ type: "error", text: "empty response from the model (after retries)" }); return; }
        emptyRetries = 0;
        messages.push({ role: "assistant", content: assistant.length ? assistant : [{ type: "text", text: finalText || "" }] });
        const toolUses = assistant.filter((b: any) => b.type === "tool_use");
        if (!toolUses.length || stop !== "tool_use") { opts.onEvent({ type: "done", text: finalText }); return; }
        const results: any[] = [];
        for (const tu of toolUses) {
          let out = ""; try { out = await dispatch(tu.name, tu.input); } catch (e) { out = "error: " + String((e as any)?.message || e); }
          opts.onEvent({ type: "tool-done", tool: tu.name, detail: out.length > 200 ? out.slice(0, 200) + "…" : out });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
        }
        messages.push({ role: "user", content: results });
      }
    } catch (e) { if (!abort?.aborted) opts.onEvent({ type: "error", text: String((e as any)?.message || e) }); }
  }

  return { ask, messages, get lastSource() { return lastSource; } };
}

// Parse one streamed assistant turn (Anthropic SSE) → its content blocks + stop reason. Mirrors the app loop's parse.
async function streamTurn(body: ReadableStream<Uint8Array>, onEvent: (e: WAgentEvent) => void):
    Promise<{ assistant: any[]; stop: string; finalText: string }> {
  const assistant: any[] = []; let curText = "", curTool: any = null, curJson = "", stop = "", finalText = "";
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      let ev: any; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === "content_block_start") {
        if (ev.content_block.type === "tool_use") { curTool = { type: "tool_use", id: ev.content_block.id, name: ev.content_block.name, input: {} }; curJson = ""; onEvent({ type: "tool", tool: curTool.name }); }
        else if (ev.content_block.type === "text") curText = "";
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") curText += ev.delta.text;
        else if (ev.delta.type === "input_json_delta") curJson += ev.delta.partial_json;
      } else if (ev.type === "content_block_stop") {
        if (curTool) { try { curTool.input = curJson ? JSON.parse(curJson) : {}; } catch { curTool.input = {}; } assistant.push(curTool); curTool = null; }
        else if (curText) { assistant.push({ type: "text", text: curText }); finalText = curText; onEvent({ type: "text", text: curText }); curText = ""; }
      } else if (ev.type === "message_delta") { if (ev.delta?.stop_reason) stop = ev.delta.stop_reason; }
    }
  }
  return { assistant, stop, finalText };
}
