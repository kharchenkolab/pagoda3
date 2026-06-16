// Standalone widget dev harness (served at /widget-dev.html) — develop & debug widgets with NO app dependency.
// A mock WidgetHost (synthetic coord + data), an editor, live preview, a contract-event log, and a theme toggle.
// Exposes window.wdev so it can be driven from automated checks (preview_eval).
import { mountWidget, previewWidget, WidgetHost, WidgetHandle } from "./runtime.ts";
import { ThemeInfo, CoordInfo, WidgetMsg } from "./contract.ts";
import { KITCHEN_SINK } from "./template.ts";
import { listRecipes, getRecipe } from "./recipes.ts";
import { createWidgetAgent, WAgentEvent } from "./wagent.ts";

// ---- theme var sets (the real app host will read these from the live document instead) ----
const THEME_VARS: Record<"dark" | "light", Record<string, string>> = {
  dark: { "--text": "#d7dee8", "--dim": "#8a97a8", "--faint": "#5b6675", "--panel": "#161b22", "--inset": "#1b2230", "--line": "#2a3340", "--cyan": "#5cc8ff", "--amber": "#e0a458", "--bad": "#e07a7a", "--good": "#5bbf8f", "--sans": "-apple-system,system-ui,sans-serif", "--mono": "ui-monospace,Menlo,monospace" },
  light: { "--text": "#33444b", "--dim": "#5a6970", "--faint": "#7c8789", "--panel": "#fbfaf7", "--inset": "#f3ecd9", "--line": "#e0ddd2", "--cyan": "#1f7faf", "--amber": "#a9750a", "--bad": "#cb2f2f", "--good": "#5f8500", "--sans": "-apple-system,system-ui,sans-serif", "--mono": "ui-monospace,Menlo,monospace" },
};

// ---- mock dataset ----
const N = 2000;
const CATS: Record<string, string[]> = {
  cell_type: ["T cell", "B cell", "NK", "Monocyte", "DC", "Platelet"],
  sample: ["S1", "S2", "S3"],
  condition: ["control", "disease"],
};
const NUMS = ["mito", "n_umi"];
const codesFor = (field: string) => { const k = CATS[field].length; const codes = new Int32Array(N); for (let i = 0; i < N; i++) codes[i] = (i * 2654435761 >>> 0) % k; return codes; };

let dark = false;
const subs: ((what: "coord" | "theme" | "hint") => void)[] = [];
const coord: CoordInfo = { colorBy: "meta:cell_type", selection: null, focus: null };
let hintInfo: any = null;
const notify = (what: "coord" | "theme" | "hint") => subs.forEach((f) => f(what));
const toHintInfo = (h: any) => !h ? null : (h.category ? { kind: "category", grouping: h.category.grouping, value: h.category.value } : (h.cells ? { kind: "cells", ids: h.cells.slice(0, 256) } : null));
// mirror the app host: a selection is a small descriptor; the actual ids are kept here and served via 'selectedCells'
let selectedIds: number[] = [];
const cellsOfCat = (field: string, value: string) => { const codes = codesFor(field); const k = (CATS[field] || []).indexOf(value); const ids: number[] = []; for (let i = 0; i < N; i++) if (codes[i] === k) ids.push(i); return ids; };
const toSelInfo = (sel: any): CoordInfo["selection"] => {
  if (!sel) { selectedIds = []; return null; }
  if (sel.category) { const { grouping, value } = sel.category; selectedIds = cellsOfCat(grouping, value); return { kind: "category", grouping, value, count: selectedIds.length }; }
  if (sel.cells) { selectedIds = sel.cells.slice(); return { kind: "cells", count: selectedIds.length }; }
  selectedIds = []; return null;
};

let logEl: HTMLElement;
const log = (dir: "→" | "←", m: any) => {
  if (!logEl) return;
  const row = document.createElement("div");
  row.textContent = `${dir} ${m.t}${m.t === "requestData" ? " " + m.kind : ""}${m.handle ? " " + m.handle : ""}${m.sel ? " " + JSON.stringify(m.sel) : ""}`;
  row.style.cssText = `font:11px ui-monospace,monospace;padding:1px 0;color:${dir === "→" ? "var(--cyan)" : "var(--dim)"}`;
  logEl.prepend(row); while (logEl.childElementCount > 60) logEl.lastChild!.remove();
};

const host: WidgetHost = {
  theme: (): ThemeInfo => ({ dark, vars: THEME_VARS[dark ? "dark" : "light"] }),
  coord: () => ({ ...coord }),
  hint: () => hintInfo,
  subscribe: (cb) => { subs.push(cb); return () => { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); }; },
  apply: (m: WidgetMsg) => {
    log("→", m);
    if (m.t === "setColor") { coord.colorBy = m.handle; notify("coord"); }
    else if (m.t === "setSelection") { coord.selection = toSelInfo(m.sel); notify("coord"); }
    else if (m.t === "setHint") { hintInfo = toHintInfo(m.hint); notify("hint"); }   // hover tier (separate channel)
  },
  data: async (kind, args) => {
    log("→", { t: "requestData", kind });
    if (kind === "n") return N;
    if (kind === "fields") return { categorical: Object.keys(CATS), numeric: NUMS };
    if (kind === "categories") { const cats = CATS[args.field] || []; const codes = codesFor(args.field); const counts = cats.map((_, k) => { let c = 0; for (let i = 0; i < N; i++) if (codes[i] === k) c++; return c; }); return { categories: cats, counts }; }
    if (kind === "category") return { categories: CATS[args.field] || [], codes: Array.from(codesFor(args.field)) };
    if (kind === "cellsOf") { const cats = CATS[args.field] || []; const k = cats.indexOf(args.value); const codes = codesFor(args.field); const ids: number[] = []; for (let i = 0; i < N; i++) if (codes[i] === k) ids.push(i); return ids; }
    if (kind === "expr") { const v = new Float32Array(N); let seed = 0; for (const ch of String(args.gene)) seed += ch.charCodeAt(0); for (let i = 0; i < N; i++) v[i] = Math.max(0, Math.sin(i * 0.13 + seed) * 2 + 1.5); return v; }
    if (kind === "numeric") { const v = new Float32Array(N); for (let i = 0; i < N; i++) v[i] = (i % 100) / 10; return { values: Array.from(v), min: 0, max: 9.9 }; }
    if (kind === "selectedCells") return selectedIds.slice();
    throw new Error("unknown data kind: " + kind);
  },
};

// ---- UI ----
const app = document.getElementById("app")!;
const setPageTheme = () => { const v = THEME_VARS[dark ? "dark" : "light"]; for (const k in v) app.style.setProperty(k, v[k]); app.style.background = dark ? "#0d1117" : "#ffffff"; app.style.color = v["--text"]; };
app.style.cssText = "font:13px -apple-system,system-ui,sans-serif;min-height:100vh;padding:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start";
app.innerHTML = `
  <div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
      <b>widget dev harness</b>
      <select id="recipe" title="load a recipe into the editor"><option value="">recipe…</option></select>
      <button id="run">▶ preview</button><button id="check">check</button><button id="theme">theme</button>
    </div>
    <div style="display:flex;align-items:center;gap:7px;margin-bottom:8px;flex-wrap:wrap;font:11px ui-monospace,monospace">
      <span style="color:var(--faint,#9aa)">simulate native panel →</span>
      <button id="extsel">select NK</button><button id="exthover">hover Monocyte</button><button id="extclear">clear</button><button id="ctl">fire control</button>
    </div>
    <div id="state" style="font:11px ui-monospace,monospace;color:var(--dim,#667);margin-bottom:6px"></div>
    <textarea id="src" spellcheck="false" style="width:100%;height:300px;font:12px ui-monospace,monospace;border:1px solid var(--line,#ccc);border-radius:8px;padding:8px;background:var(--panel,#fff);color:var(--text,#222)"></textarea>
    <div id="check-out" style="font:11px ui-monospace,monospace;margin-top:6px;white-space:pre-wrap;color:var(--dim,#667)"></div>
    <div style="font:11px ui-monospace,monospace;letter-spacing:1px;color:var(--faint,#9aa);margin:12px 0 4px">AGENT (authoring loop)</div>
    <div style="display:flex;gap:6px"><input id="ask" placeholder="ask the agent to build a widget…" style="flex:1;border:1px solid var(--line,#ccc);border-radius:8px;padding:6px 9px;background:var(--panel,#fff);color:var(--text,#222)"><button id="asksend">send</button></div>
    <div id="thread" style="border:1px solid var(--line,#ccc);border-radius:8px;padding:6px 9px;margin-top:6px;max-height:220px;overflow:auto;background:var(--panel,#fff)"></div>
  </div>
  <div>
    <div style="border:1px solid var(--line,#ccc);border-radius:10px;overflow:hidden;background:var(--panel,#fff)">
      <div style="font:11px ui-monospace,monospace;letter-spacing:1px;color:var(--faint,#9aa);padding:6px 10px;border-bottom:1px solid var(--line,#ccc)" id="wtitle">WIDGET</div>
      <div id="host" style="min-height:200px"></div>
    </div>
    <div style="font:11px ui-monospace,monospace;letter-spacing:1px;color:var(--faint,#9aa);margin:10px 0 4px">CONTRACT EVENTS · → widget→host · ← host→widget</div>
    <div id="log" style="border:1px solid var(--line,#ccc);border-radius:8px;padding:6px 9px;height:200px;overflow:auto;background:var(--panel,#fff)"></div>
  </div>`;
logEl = document.getElementById("log")!;
const srcEl = document.getElementById("src") as HTMLTextAreaElement; srcEl.value = KITCHEN_SINK;
const hostEl = document.getElementById("host")!;
let handle: WidgetHandle | null = null;

const mount = () => {
  handle?.destroy();
  hostEl.innerHTML = "";
  handle = mountWidget(hostEl, srcEl.value, host, (m) => log("→", m));   // tap logs widget→host
  handle.onManifest((mf) => { document.getElementById("wtitle")!.textContent = (mf.title || "WIDGET") + (mf.controls?.length ? "  ·  " + mf.controls.map((c) => "[" + c.label + "]").join(" ") : ""); });
  handle.onResize((h) => { handle!.iframe.style.height = Math.max(80, h + 4) + "px"; });
};
document.getElementById("run")!.onclick = mount;
document.getElementById("theme")!.onclick = () => { dark = !dark; setPageTheme(); notify("theme"); };
const updateState = () => { const st = document.getElementById("state"); if (st) st.textContent = "coord: color=" + coord.colorBy + " · sel=" + (coord.selection ? ((coord.selection as any).value || (coord.selection as any).kind) : "none") + " · hint=" + (hintInfo ? (hintInfo.value || hintInfo.kind) : "none"); };
document.getElementById("extsel")!.onclick = () => { coord.selection = toSelInfo({ category: { grouping: "cell_type", value: "NK" } }); notify("coord"); log("←", { t: "coord" }); updateState(); };
document.getElementById("exthover")!.onclick = () => { hintInfo = { kind: "category", grouping: "cell_type", value: "Monocyte" }; notify("hint"); log("←", { t: "hint" }); updateState(); };
document.getElementById("extclear")!.onclick = () => { coord.selection = null; selectedIds = []; hintInfo = null; notify("coord"); notify("hint"); log("←", { t: "clear" }); updateState(); };
document.getElementById("ctl")!.onclick = () => handle?.sendControl("reset");
// recipe picker — load a recipe into the editor + mount (fast iteration starting point)
const recipeSel = document.getElementById("recipe") as HTMLSelectElement;
recipeSel.innerHTML = '<option value="">recipe…</option>' + listRecipes().map((r) => '<option value="' + r.name + '">' + r.title + '</option>').join("");
recipeSel.onchange = () => { const src = getRecipe(recipeSel.value); if (src) { srcEl.value = src; mount(); } };
updateState();
document.getElementById("check")!.onclick = async () => {
  const out = await previewWidget(srcEl.value, host);
  (document.getElementById("check-out")!).textContent = JSON.stringify(out, null, 2);
};

// ---- the authoring agent (drives the real proxy loop; save → editor + mount) ----
const threadEl = document.getElementById("thread")!;
const addThread = (e: WAgentEvent) => {
  const row = document.createElement("div"); row.style.cssText = "font-size:11.5px;padding:2px 0;line-height:1.4";
  if (e.type === "user") { row.innerHTML = `<b>you:</b> ${e.text}`; }
  else if (e.type === "text") { row.style.color = "var(--text)"; row.textContent = e.text || ""; }
  else if (e.type === "tool") { row.style.color = "var(--cyan)"; row.textContent = "⚙ " + e.tool + "…"; }
  else if (e.type === "tool-done") { row.style.color = "var(--dim)"; row.textContent = "✓ " + e.tool + (e.detail ? " — " + e.detail : ""); }
  else if (e.type === "error") { row.style.color = "var(--bad)"; row.textContent = "✖ " + e.text; }
  else if (e.type === "done") { return; }
  threadEl.appendChild(row); threadEl.scrollTop = threadEl.scrollHeight;
};
const agent = createWidgetAgent({
  host,
  onSave: (source) => { srcEl.value = source; mount(); },     // mount the agent's widget in the host panel
  onEvent: addThread,
});
const send = () => { const inp = document.getElementById("ask") as HTMLInputElement; const t = inp.value.trim(); if (!t) return; inp.value = ""; agent.ask(t); };
document.getElementById("asksend")!.onclick = send;
(document.getElementById("ask") as HTMLInputElement).onkeydown = (e) => { if (e.key === "Enter") send(); };

setPageTheme(); mount();
(window as any).wdev = { host, agent, get handle() { return handle; }, mount, setTheme: (d: boolean) => { dark = d; setPageTheme(); notify("theme"); }, extSelect: () => document.getElementById("extsel")!.click(), previewWidget, srcEl };
