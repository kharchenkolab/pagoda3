// The live Anthropic planner: a streaming tool-use loop where the model drives the
// coordination space and earns bigger moves through tools. Renders into the timeline
// thread (the live tip), interruptible. Falls back to the mock planner if unreachable.
import type { App } from "../ui/shell.ts";
import { CODE_API_DOC } from "./codeapi.ts";

const PROXY = "/api/agent/stream";

export async function checkLive(): Promise<boolean> {
  try { const r = await fetch("/api/health"); const j = await r.json(); return !!j.ok; } catch { return false; }
}

interface Tool { name: string; description: string; input_schema: any; }

const TOOLS: Tool[] = [
  // ---- the single declarative surface for VIEW/LAYOUT ("what to show") ----
  { name: "update_view", description: "Change WHAT IS SHOWN — colour, focus, display options, and panels — in one reversible step. Pass only the fields you want to change; a view knob is a FIELD here, never a separate verb. Smallest changes first: `color` recolours ALL embeddings (the most common move). `focus` dims everything except one field=value (clearFocus to undo). `display` sets labels / legend / alpha (point opacity 0–1; lower reveals density). `panels` is an array of per-panel ops: to CONFIGURE an existing panel give its id (from LAYOUT) plus fields to change; to CREATE one give add:<type> (Embedding, Heatmap, CompositionBars); to REMOVE give id + remove:true. Per-panel knobs: colorBy (override just this panel), scopeGrouping+scopeValue (restrict it to a population — an embedding reframes to those cells and greys the rest; clearScope to undo), embedding (which projection, see EMBEDDINGS). A Heatmap shows the top markers per group: group sets the grouping, heatMode is 'dotplot' (the DEFAULT; dot size = % expressing, colour = mean) or 'heatmap' (colour grid), and genes PINS specific genes (highlighted, merged in) — it can show ANY gene, so to surface e.g. IL17A in the marker view add it via genes rather than declining (clearGenes resets). Invalid bits (unknown gene/field/type/id) are skipped and reported back so you can correct. Prefer ONE update_view with several panel ops over many calls.",
    input_schema: { type: "object", properties: {
      color: { type: "string", description: "global colour handle: meta:<field> (cell_type, leiden, sample, condition), gene:<SYMBOL>, qc:<metric> (e.g. qc:mito), or geneset:<name>" },
      focus: { type: "object", properties: { dim: { type: "string" }, value: { type: "string" } }, description: "dim all cells except where dim=value (e.g. condition=disease)" },
      clearFocus: { type: "boolean" },
      display: { type: "object", properties: { labels: { type: "boolean" }, legend: { type: "boolean" }, alpha: { type: "number", description: "point opacity 0–1; lower reveals density" } } },
      panels: { type: "array", description: "per-panel ops (configure by id / create with add / remove)", items: { type: "object", properties: {
        id: { type: "number", description: "existing panel to modify (from LAYOUT)" },
        add: { type: "string", description: "create a panel of this type: Embedding | Heatmap | CompositionBars" },
        remove: { type: "boolean" },
        title: { type: "string" },
        colorBy: { type: "string", description: "per-panel colour override (same handle forms as `color`)" },
        scopeGrouping: { type: "string" }, scopeValue: { type: "string", description: "restrict the panel to this field=value's cells" }, clearScope: { type: "boolean" },
        embedding: { type: "string", description: "which embedding to render (see EMBEDDINGS)" },
        group: { type: "string", description: "Heatmap: grouping to stack on (e.g. cell_type)" },
        heatMode: { type: "string", enum: ["heatmap", "dotplot"], description: "Heatmap representation" },
        genes: { type: "array", items: { type: "string" }, description: "Heatmap: pin these exact HGNC genes as highlighted rows IN the panel (merged with existing). This is how to 'add/highlight a gene in the dotplot/heatmap' — NOT `color` (which recolours the embedding). A gene not in the dataset is shown as a 'not in this dataset' footnote in the panel." },
        clearGenes: { type: "boolean", description: "Heatmap: drop existing pinned genes first" },
      } } },
    } } },
  // ---- compute primitives ("what to derive") — small, named, carry methodology + caveats ----
  { name: "get_markers", description: "Add a ranked marker-gene table for a group (cluster or annotation) to the disposable answer rail, and return the top genes. Rung-1 answer.", input_schema: { type: "object", properties: { cluster: { type: "string", description: "group id, e.g. a leiden cluster (c0 / 5) or a cell type name" }, grouping: { type: "string", description: "which precomputed grouping the id belongs to (e.g. leiden or cell_type); defaults to leiden" } }, required: ["cluster"] } },
  { name: "compute", description: "Run a statistic over CELL SETS, result to the rail (or canvas with toCanvas). stat='de' = differential expression of set A vs set B, compared DIRECTLY (logFC>0 = higher in A); B defaults to the COMPLEMENT of A (i.e. A vs rest). stat='overdispersion' = most variable genes WITHIN A, recomputed for that scope. A and B are CELL-SET expressions you compose freely — {category:{grouping,value}}, {selection:true}, {focus:true}, {all:true}, {complement:<set>}, {intersect:[<set>,…]}, {union:[<set>,…]}. So you can test ANY set you can describe, not just pre-baked combos. Examples — naive vs memory B: A={category:{grouping:'cell_type',value:'B (naive)'}}, B={category:{grouping:'cell_type',value:'B (memory)'}}. Markers of a cluster: A={category:{grouping:'leiden',value:'3'}} (B defaults to rest). DE on the current selection: A={selection:true}. Within CD8 T, day7 vs day0: A={intersect:[{category:{grouping:'cell_type',value:'CD8 T'}},{category:{grouping:'condition',value:'day7'}}]}, B=same with day0 — residual RPS/RPL or MT- splitters inside one type = batch. Variable genes in platelets: stat='overdispersion', A={category:{grouping:'cell_type',value:'Platelet'}}. Cell-level ranking-grade; the donor/patient is the replicate (the caveat travels on the result).", input_schema: { type: "object", properties: { stat: { type: "string", enum: ["de", "overdispersion"] }, A: { type: "object", description: "cell set (see forms above)" }, B: { type: "object", description: "de only — the contrast set; omit to use the complement of A (A vs rest)" }, toCanvas: { type: "boolean", description: "put it on the workbench (evidence board) instead of the disposable rail" }, title: { type: "string" } }, required: ["stat", "A"] } },
  { name: "get_composition", description: "Add a per-sample cluster-composition panel (compositional) to the rail and return the disease-vs-control cluster fractions. Rung-1.", input_schema: { type: "object", properties: {} } },
  { name: "get_overdispersion", description: "Add the overdispersed gene-program list to the rail. Rung-1.", input_schema: { type: "object", properties: {} } },
  { name: "propose_workspace", description: "Propose switching to a named workspace (a bigger, reversible layout change the human confirms). name is one of: Overview, Markers, QC triage, Aspects.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "add_note", description: "Add a short text note to the rail (for an answer that needs no view).", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "concordance_panel", description: "Per-donor MARKER concordance for one cell type — the companion to a within-type compute(stat:de). Takes that cell type's top markers and shows their mean expression split by donor (a gene × donor heat). Markers reading the SAME across donors confirm a genuinely merged population; divergent ones are suspect. scopeGrouping/scopeValue = the cell type (e.g. cell_type, \"CD8+ T cells\"); splitField = the donor/batch field (sample). Adds the panel to the workbench.", input_schema: { type: "object", properties: { scopeGrouping: { type: "string" }, scopeValue: { type: "string" }, splitField: { type: "string" } }, required: ["scopeGrouping", "scopeValue", "splitField"] } },
  // ---- escape hatch: sandboxed ad-hoc computation when the primitives above can't express it ----
  { name: "compute_code", description: "ESCAPE HATCH — run a short SANDBOXED JS computation when neither update_view (config) nor compute (de/overdispersion over cell sets) can express what you need: custom signature scores, ad-hoc per-cell metrics, bespoke filters, simple correlations. Prefer the dedicated tools when they fit; reach here only for the long tail. " + CODE_API_DOC + " Declare every gene your code reads in `genes`. The result lands in the disposable rail (or set toCanvas); it carries an 'unvalidated custom code' caveat.", input_schema: { type: "object", properties: { code: { type: "string", description: "async function BODY that returns a typed result (see above)" }, genes: { type: "array", items: { type: "string" }, description: "exact HGNC symbols the code reads via api.expr" }, grouping: { type: "string", description: "optional: expose api.stats (mean/frac) for this grouping" }, title: { type: "string" }, toCanvas: { type: "boolean" } }, required: ["code"] } },
];

async function systemPrompt(app: App): Promise<string> {
  const brief = await app.ctx.describeForAgent();
  return `You are pagoda2's analysis copilot for an interactive single-cell RNA-seq viewer. The human owns a persistent spatial layout; you drive a shared COORDINATION SPACE (what colours things, what's focused/selected) and earn bigger moves.

TWO SURFACES: update_view changes WHAT IS SHOWN (colour, focus, display, panels — all declarative, one tool, any subset of fields); the compute primitives DERIVE data (markers, DE, overdispersion, composition). Configure with update_view; compute with the named tools.
PRINCIPLE OF RESTRAINT — always prefer the SMALLEST change that answers the question:
- recolour/focus in place via update_view ({color:…} or {focus:…}) — the default;
- a disposable answer in the rail (compute for DE/overdispersion over any cell set, get_markers, get_composition, get_overdispersion, add_note), or add a Heatmap panel via update_view, when a new view is needed;
- a workspace proposal (propose_workspace) only for a deliberate layout change — and it is a PROPOSAL the human confirms.
- compute_code is the ESCAPE HATCH — sandboxed ad-hoc JS (declare the genes it reads) for the long tail only (custom signature scores, bespoke per-cell metrics/filters). Try update_view and compute FIRST; its results carry an "unvalidated" caveat.
The change itself is visible, so keep your prose to ONE short sentence. Never narrate state the user can already see.

METHODOLOGY (cacoa — encode these, don't forget them):
- The replicate is the SAMPLE/DONOR, not the cell. Cell-level p-values overstate population effects.
- For a population-level claim, use pseudobulk across donors, not pooled-cell tests; say so.
- Cluster proportions are COMPOSITIONAL (sum to 1) — a rise in one forces others down; use a compositional test.
- Refuse or caveat a design that can't support a claim (e.g. 1-vs-1). If a result carries such a caveat, state it briefly. When unsure whether a claim is population- vs subpopulation-level, ASK a one-line clarifying question instead of running the wrong test.
- DE and overdispersion are scope-correct: ranked over ALL genes for the cells in question (a selection or subset), never a global gene shortlist — so they surface the genes that distinguish *that* scope.
- To CONTRAST two groups (naive vs memory B, day0 vs day7), use compute(stat:de) with A and B cell sets — a direct A-vs-B test. NEVER answer a contrast with two separate get_markers (each vs rest): related groups share their lineage genes, so the vs-rest lists look identical; only the direct test shows what differs. For markers of one group, compute(stat:de, A={category…}) (B defaults to rest) or get_markers for the precomputed table.

DATASET (read from the loaded store — do not assume any other dataset): ${brief}. Markers are precomputed for: ${app.ctx.groupings().join(", ") || "—"}.

CURRENT STATE: colouring by "${app.coord.state.colorBy}", workspace "${app.currentWS}", ${app.ctx.selectedCells().length ? app.ctx.selectedCells().length + " cells selected" : "no selection"}.
LAYOUT (panel ids for update_view panels[].id): ${app.canvas.map((p) => `#${p.id} ${p.type}${p.heatMode === "dot" ? "(dotplot)" : ""}${p.view?.colorBy ? ` colorBy=${p.view.colorBy}` : ""}${p.view?.scope ? ` scope=${(p.view.scope as any).value}` : ""}${p.view?.embedding ? ` emb=${p.view.embedding}` : ""}`).join(", ") || "—"}.
EMBEDDINGS available (update_view panels[].embedding): ${app.ctx.embeddingNames().join(", ") || "umap"}.`;
}

// ---- tool executors (side effects on the app + a compact result for the model) ----
async function execTool(app: App, name: string, input: any): Promise<string> {
  const ag = app.agent;
  switch (name) {
    case "update_view": {
      const { applied, rejected, notes } = await app.applyViewPatch(input);
      const parts: string[] = [];
      if (applied.length) parts.push(`applied: ${applied.join("; ")}`);
      if (rejected.length) parts.push(`REJECTED (fix and retry): ${rejected.join("; ")}`);
      if (notes.length) parts.push(`notes: ${notes.join("; ")}`);
      return parts.join(" | ") || "no-op — nothing valid to change";
    }
    case "get_markers": {
      const grouping = input.grouping && app.ctx.groupings().includes(input.grouping) ? input.grouping : "leiden";
      const markers = await app.ctx.markers(grouping); const rows = (markers.get(input.cluster) || []).slice(0, 20);
      if (!rows.length) return `no group "${input.cluster}" in ${grouping} (have: ${[...markers.keys()].slice(0, 12).join(", ")})`;
      ag.addRail({ type: "DeTable", title: `Markers · ${input.cluster}`, cap: `${grouping} vs rest`, bind: `de:${grouping}:${input.cluster}`, group: input.cluster, rows });
      return `added marker table for ${grouping}=${input.cluster}; top genes: ${rows.slice(0, 8).map((r) => r.symbol).join(", ")}`;
    }
    case "compute": { const { ok, error } = await app.runCompute(input); return error ? `error: ${error}` : ok!; }
    case "compute_code": { const { ok, error } = await app.runComputeCode(input); return error ? `error: ${error}` : ok!; }
    case "get_composition": {
      const comp = await app.ctx.composition("leiden"); ag.addRail({ type: "CompositionBars", title: "Composition by sample", cap: "compositional", bind: "composition:bySample" });
      const c0dis = comp.props.filter((_, i) => comp.conds[i] === "disease").map((p) => p[comp.groups.indexOf("c0")]);
      const c0con = comp.props.filter((_, i) => comp.conds[i] === "control").map((p) => p[comp.groups.indexOf("c0")]);
      return `added composition panel. c0 fraction — disease ${c0dis.map((x) => (x * 100).toFixed(0) + "%").join("/")} vs control ${c0con.map((x) => (x * 100).toFixed(0) + "%").join("/")}`;
    }
    case "get_overdispersion": { ag.addRail({ type: "Overdispersion", title: "Overdispersed programs", cap: "gene programs", bind: "aspect:overdispersion" }); return "added overdispersed-programs list"; }
    case "propose_workspace": { ag.proposeWorkspace(input.name); return `proposed workspace ${input.name} (awaiting the human's OK)`; }
    case "add_note": { ag.addRail({ type: "Note", title: "Note", text: input.text }); return "added note"; }
    case "concordance_panel": {
      const mm = await app.ctx.markers(input.scopeGrouping);
      const genes = (mm.get(input.scopeValue) || []).slice(0, 12).map((m: any) => m.symbol);
      if (!genes.length) return `no precomputed markers for "${input.scopeValue}" in ${input.scopeGrouping}`;
      const cells = app.ctx.cellsOfCategory(input.scopeGrouping, input.scopeValue);
      const split = await app.ctx.groupStatsSplit(genes, cells, input.splitField);
      if (!split.levels.length) return `no ${input.splitField} levels found in "${input.scopeValue}"`;
      app.addPanel({ type: "SplitHeat", title: `Concordance · ${input.scopeValue}`, cap: `markers × ${input.splitField}`, bind: "concordance", split });
      return `per-donor marker concordance for "${input.scopeValue}" (${genes.slice(0, 6).join(", ")}…) across ${split.levels.join(", ")} — matching columns = merged cleanly; divergent = batch.`;
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
  // checkpoint the turn as request → response: the label is what you asked, the "why" is the agent's actual
  // closing words (not meta-commentary). Both show in the timeline and the docked conversation.
  const label = userText.length > 56 ? userText.slice(0, 54) + "…" : userText;
  const finalText = [...app.thread.entries].reverse().find((e: any) => e.role === "agent" && e.text)?.text || "Done.";
  ag.settleThread(label, finalText);
}

function toolLabel(tu: any): string {
  const i = tu.input || {};
  if (tu.name === "update_view") {
    const bits: string[] = [];
    if (i.color) bits.push(`recolour → ${i.color}`);
    if (i.focus?.dim) bits.push(`focus ${i.focus.dim}=${i.focus.value}`);
    if (i.clearFocus) bits.push("clear focus");
    if (i.display) bits.push("display");
    for (const p of (i.panels || [])) bits.push(p.add ? `+ ${p.add}` : p.remove ? `− panel #${p.id}` : `panel #${p.id}`);
    return bits.join(" · ") || "update view";
  }
  if (tu.name === "get_markers") return `markers · ${i.cluster}`;
  if (tu.name === "compute") return i.stat === "overdispersion" ? "overdispersion" : "DE (compute)";
  if (tu.name === "compute_code") return "custom code";
  if (tu.name === "concordance_panel") return `concordance · ${i.scopeValue}`;
  if (tu.name === "propose_workspace") return `propose workspace · ${i.name}`;
  return tu.name.replace(/_/g, " ");
}
