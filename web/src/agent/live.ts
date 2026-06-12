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
  { name: "get_markers", description: "Add a ranked marker-gene table for a leiden cluster (e.g. c0) to the disposable answer rail, and return the top genes. Rung-1 answer.", input_schema: { type: "object", properties: { cluster: { type: "string", description: "leiden cluster id like c0" } }, required: ["cluster"] } },
  { name: "run_de_on_selection", description: "Run subsample differential expression on the current cell selection vs the rest (ranking-grade, approximate). Adds a DE table to the rail. Only valid when the user has a selection.", input_schema: { type: "object", properties: {} } },
  { name: "get_composition", description: "Add a per-sample cluster-composition panel (compositional) to the rail and return the disease-vs-control cluster fractions. Rung-1.", input_schema: { type: "object", properties: {} } },
  { name: "get_overdispersion", description: "Add the overdispersed gene-program list to the rail. Rung-1.", input_schema: { type: "object", properties: {} } },
  { name: "propose_workspace", description: "Propose switching to a named workspace (a bigger, reversible layout change the human confirms). name is one of: Overview, Markers, QC triage, Aspects.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "add_note", description: "Add a short text note to the rail (for an answer that needs no view).", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

function systemPrompt(app: App): string {
  return `You are pagoda2's analysis copilot for an interactive single-cell RNA-seq viewer. The human owns a persistent spatial layout; you drive a shared COORDINATION SPACE (what colours things, what's focused/selected) and earn bigger moves.

PRINCIPLE OF RESTRAINT — always prefer the SMALLEST change that answers the question:
- recolour/focus in place (set_color, set_focus) — the default;
- a disposable answer in the rail (get_markers, run_de_on_selection, get_composition, get_overdispersion, add_note) when a new view is needed;
- a workspace proposal (propose_workspace) only for a deliberate layout change — and it is a PROPOSAL the human confirms.
The change itself is visible, so keep your prose to ONE short sentence. Never narrate state the user can already see.

METHODOLOGY (cacoa — encode these, don't forget them):
- The replicate is the SAMPLE/DONOR, not the cell. Cell-level p-values overstate population effects.
- For a population-level claim, use pseudobulk across donors, not pooled-cell tests; say so.
- Cluster proportions are COMPOSITIONAL (sum to 1) — a rise in one forces others down; use a compositional test.
- Refuse or caveat a design that can't support a claim (e.g. 1-vs-1). If a result carries such a caveat, state it briefly. When unsure whether a claim is population- vs subpopulation-level, ASK a one-line clarifying question instead of running the wrong test.

DATASET: ${app.ctx.n.toLocaleString()} cells, 12 leiden clusters c0..c11 mapped to cell types (c0=Macrophage, c1=T cell, c2=B cell, ...). Genes use symbols (IL6, CXCL10, SOD2, CCL2, CD3D, MS4A1, NKG7, CD14, ...). Samples D1-D6: D1-D3 control, D4-D6 disease. NOTE: cluster c0 is enriched in disease, but the enrichment leans heavily on a single donor (D5) — a textbook donor-driven confound; flag it when relevant.

CURRENT STATE: colouring by "${app.coord.state.colorBy}", workspace "${app.currentWS}", ${app.coord.state.selection ? app.coord.state.selection.length + " cells selected" : "no selection"}.`;
}

// ---- tool executors (side effects on the app + a compact result for the model) ----
async function execTool(app: App, name: string, input: any): Promise<string> {
  const ag = app.agent;
  switch (name) {
    case "set_color": { app.coord.setColor(input.handle); return `coloured by ${input.handle}`; }
    case "set_focus": { app.coord.setFocus(input.dim, input.value); return `focused ${input.dim}=${input.value}`; }
    case "clear_focus": { app.coord.clearFocus(); return "cleared focus"; }
    case "get_markers": {
      const markers = await app.ctx.markers("leiden"); const rows = (markers.get(input.cluster) || []).slice(0, 20);
      ag.addRail({ type: "DeTable", title: `Markers · ${input.cluster}`, cap: "cluster vs rest", bind: `de:leiden:${input.cluster}`, group: input.cluster, rows });
      return `added marker table for ${input.cluster}; top genes: ${rows.slice(0, 8).map((r) => r.symbol).join(", ")}`;
    }
    case "run_de_on_selection": {
      const ids = app.coord.state.selection; if (!ids?.length) return "no selection — ask the user to drag-select cells first";
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
    default: return `unknown tool ${name}`;
  }
}

// ---- the streaming tool-use loop ----
export async function runLive(app: App, userText: string, abort: AbortSignal): Promise<void> {
  const ag = app.agent;
  const messages: any[] = [{ role: "user", content: userText }];
  app.thread = { kind: "live", live: true, entries: [{ role: "user", text: userText }] };
  ag.renderThread(); app.setPip("working", "thinking");
  const sys = systemPrompt(app);

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
  if (tu.name === "propose_workspace") return `propose workspace · ${i.name}`;
  if (tu.name === "set_focus") return `focus · ${i.dim}=${i.value}`;
  return tu.name.replace(/_/g, " ");
}
