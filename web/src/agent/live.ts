// The live Anthropic planner: a streaming tool-use loop where the model drives the
// coordination space and earns bigger moves through tools. Renders into the timeline
// thread (the live tip), interruptible. Falls back to the mock planner if unreachable.
import type { App } from "../ui/shell.ts";

const PROXY = "/api/agent/stream";

export async function checkLive(): Promise<boolean> {
  try { const r = await fetch("/api/health"); const j = await r.json(); return !!j.ok; } catch { return false; }
}

interface Tool { name: string; description: string; input_schema: any; }

const TOOLS: Tool[] = [
  { name: "set_color", description: "Recolour every embedding in place by a handle. The SMALLEST change — prefer this. handle is one of: meta:leiden, meta:cell_type, meta:condition, meta:sample, qc:mito, or gene:<SYMBOL> (e.g. gene:IL6), or geneset:<program name>.", input_schema: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"] } },
  { name: "set_focus", description: "Dim all cells except those where a metadata dim equals value (e.g. dim=condition, value=disease). Coordinated focus.", input_schema: { type: "object", properties: { dim: { type: "string" }, value: { type: "string" } }, required: ["dim", "value"] } },
  { name: "clear_focus", description: "Clear focus/selection.", input_schema: { type: "object", properties: {} } },
  { name: "get_markers", description: "Add a ranked marker-gene table for a group (cluster or annotation) to the disposable answer rail, and return the top genes. Rung-1 answer.", input_schema: { type: "object", properties: { cluster: { type: "string", description: "group id, e.g. a leiden cluster (c0 / 5) or a cell type name" }, grouping: { type: "string", description: "which precomputed grouping the id belongs to (e.g. leiden or cell_type); defaults to leiden" } }, required: ["cluster"] } },
  { name: "run_de_on_selection", description: "Run subsample differential expression on the current cell selection vs the rest, ranked over ALL genes (scope-correct, ranking-grade). Adds a DE table to the rail. Only valid when the user has a selection.", input_schema: { type: "object", properties: {} } },
  { name: "get_overdispersed_genes", description: "Compute the most overdispersed (highly variable) genes for a scope — the current selection if there is one, else the whole dataset — recomputed for that scope (residual above the mean-variance trend), not a global shortlist. Adds a ranked gene list to the rail. Use when asked what varies / what's heterogeneous within a subset.", input_schema: { type: "object", properties: {} } },
  { name: "show_marker_heatmap", description: "Add a marker heatmap (top genes per group, gene × group) for a grouping to the rail — the canonical view to examine which genes define each cluster or cell type. Use when asked to examine/see the markers OF a set of clusters or cell types. grouping is one of the precomputed groupings (e.g. leiden, cell_type).", input_schema: { type: "object", properties: { grouping: { type: "string", description: "a precomputed grouping: leiden or cell_type" } }, required: ["grouping"] } },
  { name: "get_composition", description: "Add a per-sample cluster-composition panel (compositional) to the rail and return the disease-vs-control cluster fractions. Rung-1.", input_schema: { type: "object", properties: {} } },
  { name: "get_overdispersion", description: "Add the overdispersed gene-program list to the rail. Rung-1.", input_schema: { type: "object", properties: {} } },
  { name: "propose_workspace", description: "Propose switching to a named workspace (a bigger, reversible layout change the human confirms). name is one of: Overview, Markers, QC triage, Aspects.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "add_note", description: "Add a short text note to the rail (for an answer that needs no view).", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "set_display", description: "Toggle embedding view options: on-plot category labels and the colour legend. Defaults are automatic (labels on for categorical colourings; legend shown for gene/numeric colourings, hidden when labels carry identity). Pass only the field(s) to change. Use when the human asks to show/hide the labels or bring back / hide the legend.", input_schema: { type: "object", properties: { labels: { type: "boolean", description: "show on-plot cell-type/cluster labels" }, legend: { type: "boolean", description: "show the colour legend (swatches for categorical, low→high for numeric)" } } } },
  { name: "configure_panel", description: "DEEP per-panel view control — fine-tune ONE panel in place, leaving the others alone. Use it to build a focused evidence view (e.g. take a copy of the embedding, zoom it to one cluster, colour it by donor). panelId comes from the LAYOUT line. colorBy is a handle (meta:sample, meta:cell_type, gene:CD8A, qc:mito…) and overrides that panel's colour only. scopeGrouping+scopeValue restrict the panel to a group's cells (e.g. cell_type + \"CD8+ T cells\"): the embedding reframes to those cells and greys the rest. The smallest way to make a bespoke view — prefer it over a new workspace.", input_schema: { type: "object", properties: { panelId: { type: "number" }, colorBy: { type: "string" }, scopeGrouping: { type: "string" }, scopeValue: { type: "string" } }, required: ["panelId"] } },
];

async function systemPrompt(app: App): Promise<string> {
  const brief = await app.ctx.describeForAgent();
  return `You are pagoda2's analysis copilot for an interactive single-cell RNA-seq viewer. The human owns a persistent spatial layout; you drive a shared COORDINATION SPACE (what colours things, what's focused/selected) and earn bigger moves.

PRINCIPLE OF RESTRAINT — always prefer the SMALLEST change that answers the question:
- recolour/focus in place (set_color, set_focus) — the default;
- a disposable answer in the rail (get_markers, show_marker_heatmap, run_de_on_selection, get_overdispersed_genes, get_composition, get_overdispersion, add_note) when a new view is needed;
- a workspace proposal (propose_workspace) only for a deliberate layout change — and it is a PROPOSAL the human confirms.
The change itself is visible, so keep your prose to ONE short sentence. Never narrate state the user can already see.

METHODOLOGY (cacoa — encode these, don't forget them):
- The replicate is the SAMPLE/DONOR, not the cell. Cell-level p-values overstate population effects.
- For a population-level claim, use pseudobulk across donors, not pooled-cell tests; say so.
- Cluster proportions are COMPOSITIONAL (sum to 1) — a rise in one forces others down; use a compositional test.
- Refuse or caveat a design that can't support a claim (e.g. 1-vs-1). If a result carries such a caveat, state it briefly. When unsure whether a claim is population- vs subpopulation-level, ASK a one-line clarifying question instead of running the wrong test.
- DE and overdispersion are scope-correct: ranked over ALL genes for the cells in question (a selection or subset), never a global gene shortlist — so they surface the genes that distinguish *that* scope.

DATASET (read from the loaded store — do not assume any other dataset): ${brief}. Markers are precomputed for: ${app.ctx.groupings().join(", ") || "—"}.

CURRENT STATE: colouring by "${app.coord.state.colorBy}", workspace "${app.currentWS}", ${app.ctx.selectedCells().length ? app.ctx.selectedCells().length + " cells selected" : "no selection"}.
LAYOUT (panel ids for configure_panel): ${app.canvas.map((p) => `#${p.id} ${p.type}${p.view?.colorBy ? ` colorBy=${p.view.colorBy}` : ""}${p.view?.scope ? ` scope=${(p.view.scope as any).value}` : ""}`).join(", ") || "—"}.`;
}

// ---- tool executors (side effects on the app + a compact result for the model) ----
async function execTool(app: App, name: string, input: any): Promise<string> {
  const ag = app.agent;
  switch (name) {
    case "set_color": { app.coord.setColor(input.handle); return `coloured by ${input.handle}`; }
    case "set_focus": { app.coord.setFocus(input.dim, input.value); return `focused ${input.dim}=${input.value}`; }
    case "clear_focus": { app.coord.clearFocus(); return "cleared focus"; }
    case "get_markers": {
      const grouping = input.grouping && app.ctx.groupings().includes(input.grouping) ? input.grouping : "leiden";
      const markers = await app.ctx.markers(grouping); const rows = (markers.get(input.cluster) || []).slice(0, 20);
      if (!rows.length) return `no group "${input.cluster}" in ${grouping} (have: ${[...markers.keys()].slice(0, 12).join(", ")})`;
      ag.addRail({ type: "DeTable", title: `Markers · ${input.cluster}`, cap: `${grouping} vs rest`, bind: `de:${grouping}:${input.cluster}`, group: input.cluster, rows });
      return `added marker table for ${grouping}=${input.cluster}; top genes: ${rows.slice(0, 8).map((r) => r.symbol).join(", ")}`;
    }
    case "get_overdispersed_genes": {
      const selCells = app.ctx.selectedCells();
      const ids = selCells.length ? Array.from(selCells) : Array.from({ length: app.ctx.n }, (_, i) => i);
      const hv = await app.ctx.view.overdispersedGenes(ids, 25);
      if (!hv.length) return "no overdispersion (store has no cell-major counts panel)";
      const rows = hv.map((h) => ({ symbol: h.symbol, score: h.resid }));
      const scope = selCells.length ? `selection (${selCells.length} cells)` : "whole dataset";
      ag.addRail({ type: "GeneList", title: `Overdispersed · ${scope}`, cap: "od (resid)", bind: "hvg:scope", rows });
      return `top overdispersed genes for the ${scope}, recomputed for this scope: ${hv.slice(0, 10).map((h) => h.symbol).join(", ")}`;
    }
    case "show_marker_heatmap": {
      const grouping = app.ctx.groupings().includes(input.grouping) ? input.grouping : "leiden";
      app.coord.setColor("meta:" + grouping);
      ag.addRail({ type: "Heatmap", title: `Marker heatmap · ${grouping}`, cap: `top genes × ${grouping}`, group: grouping, bind: "markers:" + grouping, full: true });
      const mk = await app.ctx.markers(grouping);
      const eg = [...mk.entries()].slice(0, 3).map(([g, r]) => `${g}: ${r.slice(0, 3).map((x) => x.symbol).join("/")}`).join("; ");
      return `added a marker heatmap for the ${grouping} grouping (${[...mk.keys()].length} groups) and coloured the embedding by it; e.g. ${eg}`;
    }
    case "run_de_on_selection": {
      const ids = app.ctx.selectedCells(); if (!ids.length) return "no selection — ask the user to drag-select cells first";
      const set = new Set(ids); const rest: number[] = []; for (let i = 0; i < app.ctx.n; i++) if (!set.has(i)) rest.push(i);
      const { ranked, nA, nB, panel, nGenesRanked } = await app.ctx.view.subsampleDE(Array.from(ids), rest);
      const rows = ranked.slice(0, 20).map((r) => ({ gene: r.gene, symbol: r.symbol, lfc: r.lfc, padj: Math.exp(-Math.abs(r.lfc) * 2) }));
      ag.addRail({ type: "DeTable", title: `DE · selection (${ids.length})`, cap: panel ? "vs rest · panel" : "vs rest · approx", bind: "de:selection", rows });
      const how = panel ? `O(rows) cell-major counts, all ${nGenesRanked} genes` : "ranking-grade";
      return `subsample DE (n=${nA} vs ${nB}, ${how}); top up: ${rows.filter((r) => r.lfc > 0).slice(0, 6).map((r) => r.symbol).join(", ")}`;
    }
    case "get_composition": {
      const comp = await app.ctx.composition("leiden"); ag.addRail({ type: "CompositionBars", title: "Composition by sample", cap: "compositional", bind: "composition:bySample" });
      const c0dis = comp.props.filter((_, i) => comp.conds[i] === "disease").map((p) => p[comp.groups.indexOf("c0")]);
      const c0con = comp.props.filter((_, i) => comp.conds[i] === "control").map((p) => p[comp.groups.indexOf("c0")]);
      return `added composition panel. c0 fraction — disease ${c0dis.map((x) => (x * 100).toFixed(0) + "%").join("/")} vs control ${c0con.map((x) => (x * 100).toFixed(0) + "%").join("/")}`;
    }
    case "get_overdispersion": { ag.addRail({ type: "Overdispersion", title: "Overdispersed programs", cap: "gene programs", bind: "aspect:overdispersion" }); return "added overdispersed-programs list"; }
    case "propose_workspace": { ag.proposeWorkspace(input.name); return `proposed workspace ${input.name} (awaiting the human's OK)`; }
    case "add_note": { ag.addRail({ type: "Note", title: "Note", text: input.text }); return "added note"; }
    case "set_display": { const p: any = {}; if (typeof input.labels === "boolean") p.labels = input.labels; if (typeof input.legend === "boolean") p.legend = input.legend; app.coord.setDisplay(p); return `display ${JSON.stringify(p)}`; }
    case "configure_panel": {
      const patch: any = {};
      if (typeof input.colorBy === "string") patch.colorBy = input.colorBy;
      if (typeof input.scopeGrouping === "string" && typeof input.scopeValue === "string") patch.scope = { kind: "category", grouping: input.scopeGrouping, value: input.scopeValue };
      app.configurePanel(input.panelId, patch);
      return `configured panel ${input.panelId}: ${JSON.stringify(patch)}`;
    }
    default: return `unknown tool ${name}`;
  }
}

// ---- the streaming tool-use loop ----
export async function runLive(app: App, userText: string, abort: AbortSignal): Promise<void> {
  const ag = app.agent;
  const messages: any[] = [{ role: "user", content: userText }];
  app.thread = { kind: "live", live: true, entries: [{ role: "user", text: userText }] };
  ag.renderThread(); app.setPip("working", "thinking");
  const sys = await systemPrompt(app);

  for (let turn = 0; turn < 8; turn++) {
    if (abort.aborted) break;
    const res = await fetch(PROXY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system: sys, messages, tools: TOOLS, model: "claude-opus-4-8", max_tokens: 1500 }), signal: abort });
    if (!res.ok || !res.body) { app.thread.entries.push({ role: "agent", text: "(agent unreachable — using local fallback)" }); ag.renderThread(); throw new Error("live unreachable"); }
    const assistant: any[] = []; let curText = ""; let curTool: any = null; let curJson = ""; let textEntry: any = null; let stop = "";
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let ev: any; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === "content_block_start") { if (ev.content_block.type === "tool_use") { curTool = { type: "tool_use", id: ev.content_block.id, name: ev.content_block.name, input: {} }; curJson = ""; } else if (ev.content_block.type === "text") { curText = ""; textEntry = { role: "agent", text: "" }; app.thread.entries.push(textEntry); } }
        else if (ev.type === "content_block_delta") { if (ev.delta.type === "text_delta") { curText += ev.delta.text; if (textEntry) { textEntry.text = curText; ag.renderThread(); } } else if (ev.delta.type === "input_json_delta") { curJson += ev.delta.partial_json; } }
        else if (ev.type === "content_block_stop") { if (curTool) { try { curTool.input = curJson ? JSON.parse(curJson) : {}; } catch { curTool.input = {}; } assistant.push(curTool); app.thread.entries.push({ tool: curTool.name, label: toolLabel(curTool), status: "active" }); ag.renderThread(); curTool = null; } else if (textEntry) { assistant.push({ type: "text", text: curText }); textEntry = null; } }
        else if (ev.type === "message_delta") { if (ev.delta?.stop_reason) stop = ev.delta.stop_reason; }
      }
    }
    messages.push({ role: "assistant", content: assistant.length ? assistant : [{ type: "text", text: curText || "" }] });
    const toolUses = assistant.filter((b) => b.type === "tool_use");
    if (!toolUses.length || stop !== "tool_use") break;
    // execute tools, append results
    const results: any[] = [];
    for (const tu of toolUses) {
      app.setPip("working", tu.name);
      let out = ""; try { out = await execTool(app, tu.name, tu.input); } catch (e) { out = "error: " + e; }
      // mark the step done
      const step = [...app.thread.entries].reverse().find((e: any) => e.tool === tu.name && e.status === "active"); if (step) { step.status = "done"; step.detail = out; }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      ag.renderThread();
    }
    messages.push({ role: "user", content: results });
    app.setPip("working", "thinking");
  }
  app.setPip("idle");
  const settledLabel = userText.length > 40 ? userText.slice(0, 38) + "…" : userText;
  ag.settleThread("agent · " + settledLabel, "A live agent turn — the trace was the swelling tip of your timeline; only the conclusion is a checkpoint.");
}

function toolLabel(tu: any): string {
  const i = tu.input || {};
  if (tu.name === "set_color") return `recolour → ${i.handle}`;
  if (tu.name === "get_markers") return `markers · ${i.cluster}`;
  if (tu.name === "get_overdispersed_genes") return `overdispersed genes`;
  if (tu.name === "show_marker_heatmap") return `marker heatmap · ${i.grouping}`;
  if (tu.name === "propose_workspace") return `propose workspace · ${i.name}`;
  if (tu.name === "set_focus") return `focus · ${i.dim}=${i.value}`;
  return tu.name.replace(/_/g, " ");
}
