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
  { name: "update_view", description: "Change WHAT IS SHOWN — colour, focus, display options, and panels — in one reversible step. Pass only the fields you want to change; a view knob is a FIELD here, never a separate verb. Smallest changes first: `color` recolours ALL embeddings (the most common move). `focus` dims everything except one field=value (clearFocus to undo). `display` sets labels / legend / alpha (point opacity 0–1; lower reveals density) / winsor (clip outlier cells off a numeric colour scale; 0.01 = 1% off each tail, the default). `panels` is an array of per-panel ops: to CONFIGURE an existing panel give its id (from LAYOUT) plus fields to change; to CREATE one give add:<type> (Embedding, Heatmap, CompositionBars); to REMOVE give id + remove:true. LAYOUT/placement: `col` (0=left,1=right) pins a panel to a column — give two panels the same col to stack them one under another; `full` makes a panel span the width, and two full panels stack one over the other (use this for a top/bottom compare, e.g. day0 over day7). Per-panel knobs: colorBy (override just this panel), scopeGrouping+scopeValue (restrict it to a population — an embedding reframes to those cells and greys the rest; a Heatmap is FACETED, its dots computed within that population; clearScope to undo). To COMPARE a factor (e.g. day0 vs day7) do NOT hand-build several scoped panels — use the top-level `facet` field, e.g. facet:{by:'condition'} (split one panel into aligned copies that share rows+columns; to facet TWO panels, send two update_view calls), which can't diverge the way separate panels do, embedding (which projection, see EMBEDDINGS), colormap (palette for NUMERIC colourings — gene/qc/score: amber (default), viridis, rdbu = red→blue, bluered, blues; aliases like 'red-to-blue' work; ignored for categorical colourings). A Heatmap shows the top markers per group: group sets the grouping, heatMode is 'dotplot' (the DEFAULT; dot size = % expressing, colour = mean) or 'heatmap' (colour grid), and genes PINS specific genes (highlighted, merged in) — it can show ANY gene, so to surface e.g. IL17A in the marker view add it via genes rather than declining (clearGenes resets). Invalid bits (unknown gene/field/type/id) are skipped and reported back so you can correct. Prefer ONE update_view with several panel ops over many calls.",
    input_schema: { type: "object", properties: {
      color: { type: "string", description: "global colour handle: meta:<field> (cell_type, leiden, sample, condition), gene:<SYMBOL>, qc:<metric> (e.g. qc:mito), or geneset:<name>" },
      focus: { type: "object", properties: { dim: { type: "string" }, value: { type: "string" }, set: { type: "object" }, label: { type: "string" } }, description: "RESTRICT the whole view to a subpopulation (inter-panel): the embedding greys the rest, the reconcile table restricts to clusters in it. Either a category (dim=value, e.g. condition=disease) OR a cell-SET for a population spanning several labels — set = a cell-set expression (same algebra as compute/annotate, e.g. {union:[{category:{grouping:'annotation',value:'CD4 T'}},{category:{grouping:'annotation',value:'CD8 T'}}]} for T cells) + a short label. clearFocus to release." },
      clearFocus: { type: "boolean" },
      select: { type: "object", properties: { dim: { type: "string" }, value: { type: "string" } }, description: "TRANSIENT selection of a metadata value (dim=value, e.g. cell_type=NK): highlights it on the embedding and cross-filters the Metadata facet panel (every field's bars/counts recompute to the selected cells). Lighter and more reversible than focus. clearSelect to drop it." },
      clearSelect: { type: "boolean" },
      display: { type: "object", properties: { labels: { type: "boolean" }, legend: { type: "boolean" }, alpha: { type: "number", description: "point opacity 0–1; lower reveals density" }, winsor: { type: "number", description: "fraction (0–0.2) clipped off EACH tail of a numeric colour scale so a few outlier cells don't wash out the rest; 0.01 = 1% (default), 0 = off" } } },
      panels: { type: "array", description: "per-panel ops (configure by id / create with add / remove)", items: { type: "object", properties: {
        id: { type: "number", description: "existing panel to modify (from LAYOUT)" },
        add: { type: "string", description: "create a panel of this type: Embedding | Heatmap | CompositionBars" },
        remove: { type: "boolean" },
        title: { type: "string" },
        col: { type: "number", enum: [0, 1], description: "pin to a workbench column: 0 = left, 1 = right. Added panels auto-balance across the two columns, so usually you don't need this — set it (or full) only for DELIBERATE stacking. Put two panels in the SAME col to stack them one under another." },
        full: { type: "boolean", description: "span the full width. Two full panels stack one under another (full-width) — the simplest 'one over the other' compare layout." },
        colorBy: { type: "string", description: "per-panel colour override (same handle forms as `color`)" },
        scopeGrouping: { type: "string" }, scopeValue: { type: "string", description: "restrict the panel to this field=value's cells" }, clearScope: { type: "boolean" },
        embedding: { type: "string", description: "which embedding to render (see EMBEDDINGS)" },
        colormap: { type: "string", description: "palette for numeric colourings: amber|viridis|rdbu|bluered|blues (aliases like 'red-to-blue' ok)" },
        group: { type: "string", description: "Heatmap: grouping to stack on (e.g. cell_type)" },
        heatMode: { type: "string", enum: ["heatmap", "dotplot"], description: "Heatmap representation" },
        genes: { type: "array", items: { type: "string" }, description: "Heatmap: pin these exact HGNC genes as highlighted rows IN the panel (merged with existing). This is how to 'add/highlight a gene in the dotplot/heatmap' — NOT `color` (which recolours the embedding). A gene not in the dataset is shown as a 'not in this dataset' footnote in the panel." },
        clearGenes: { type: "boolean", description: "Heatmap: drop existing pinned genes first" },
      } } },
      facet: { type: "object", description: "SPLIT one panel into aligned copies that differ only by scope — the right way to compare a factor (e.g. day0 vs day7). `by` = the field to split on (condition, sample, outcome…). Optional: `panel` (id to split; default = the most recent Heatmap, else Embedding), `values` (subset of the field's values; default = all), `layout` ('stack' = full-width one over another, best for dotplots; 'side' = columns, best for embeddings; default auto by type). The copies share group/genes/mode (Heatmap) or the same projection reframed (Embedding), so rows+columns line up — do NOT hand-build several scoped panels.", properties: { by: { type: "string" }, panel: { type: "number" }, values: { type: "array", items: { type: "string" } }, layout: { type: "string", enum: ["stack", "side"] } } },
      arrange: { type: "object", description: "REPOSITION existing panels into the 2-column grid — the right way to satisfy '2×2', 'side by side', 'stack these', 'put X above Y'. Give EITHER `rows` (one array per grid ROW, ≤2 ids each: a 1-id row spans full width, a 2-id row is left|right) OR `columns` (one array per COLUMN, ≤2 columns: each column's ids stack top-to-bottom). Use panel ids from LAYOUT. Examples — 2×2 with embeddings on top, dotplots below: rows:[[7,8],[5,6]]. Embeddings stacked in the left column, dotplots in the right: columns:[[7,8],[5,6]]. Everything stacked full-width: rows:[[7],[8],[5],[6]]. This ONLY moves panels (never recreates them, so scopes/genes are preserved) — prefer it over setting col/full one panel at a time, and NEVER remove+re-add panels just to rearrange.", properties: { rows: { type: "array", items: { type: "array", items: { type: "number" } } }, columns: { type: "array", items: { type: "array", items: { type: "number" } } } } },
    } } },
  // ---- compute primitives ("what to derive") — small, named, carry methodology + caveats ----
  { name: "get_markers", description: "Add a ranked marker-gene table for a group (cluster or annotation) to the disposable answer rail, and return the top genes. Rung-1 answer.", input_schema: { type: "object", properties: { cluster: { type: "string", description: "group id, e.g. a leiden cluster (c0 / 5) or a cell type name" }, grouping: { type: "string", description: "which precomputed grouping the id belongs to (e.g. leiden or cell_type); defaults to leiden" } }, required: ["cluster"] } },
  { name: "compute", description: "Run a statistic over CELL SETS, result to the rail (or canvas with toCanvas). stat='de' = differential expression of set A vs set B, compared DIRECTLY (logFC>0 = higher in A); B defaults to the COMPLEMENT of A (i.e. A vs rest). stat='overdispersion' = most variable genes WITHIN A, recomputed for that scope. A and B are CELL-SET expressions you compose freely — {category:{grouping,value}}, {selection:true}, {focus:true}, {all:true}, {complement:<set>}, {intersect:[<set>,…]}, {union:[<set>,…]}. So you can test ANY set you can describe, not just pre-baked combos. Examples — naive vs memory B: A={category:{grouping:'cell_type',value:'B (naive)'}}, B={category:{grouping:'cell_type',value:'B (memory)'}}. Markers of a cluster: A={category:{grouping:'leiden',value:'3'}} (B defaults to rest). DE on the current selection: A={selection:true}. Within CD8 T, day7 vs day0: A={intersect:[{category:{grouping:'cell_type',value:'CD8 T'}},{category:{grouping:'condition',value:'day7'}}]}, B=same with day0 — residual RPS/RPL or MT- splitters inside one type = batch. Variable genes in platelets: stat='overdispersion', A={category:{grouping:'cell_type',value:'Platelet'}}. stat='overdispersion' IS the per-gene 'highly variable genes' (HVG) score — use it for ANY 'variable / overdispersed / most-variable GENES' request; it's computed on the fly (no precompute needed), works GLOBALLY (omit A, or A={all:true}) or scoped to any subpopulation, and returns a ranked per-gene list. Do NOT use get_overdispersion for this — that is a different, precomputed gene-PROGRAM (aspect/module) view, not per-gene. Cell-level ranking-grade; the donor/patient is the replicate (the caveat travels on the result).", input_schema: { type: "object", properties: { stat: { type: "string", enum: ["de", "overdispersion"] }, A: { type: "object", description: "cell set (see forms above); for overdispersion omit to score genes globally (A={all:true})" }, B: { type: "object", description: "de only — the contrast set; omit to use the complement of A (A vs rest)" }, toCanvas: { type: "boolean", description: "put it on the workbench (evidence board) instead of the disposable rail" }, title: { type: "string" } }, required: ["stat"] } },
  { name: "get_composition", description: "Add a per-sample cluster-composition panel (compositional) to the rail and return the disease-vs-control cluster fractions. Rung-1.", input_schema: { type: "object", properties: {} } },
  { name: "get_overdispersion", description: "Add the precomputed gene-PROGRAM (aspect / gene-module) overdispersion list to the rail — NOT per-gene, and only available when the store has precomputed aspects. For per-gene variable/overdispersed genes (the usual request), use compute stat='overdispersion' instead (computed on the fly, global or scoped).", input_schema: { type: "object", properties: {} } },
  { name: "propose_workspace", description: "Propose switching to a named workspace (a bigger, reversible layout change the human confirms). name is one of: Overview, Markers, QC triage, Aspects.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "add_note", description: "Add a short text note to the rail (for an answer that needs no view).", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "concordance_panel", description: "Per-donor MARKER concordance for one cell type — the companion to a within-type compute(stat:de). Takes that cell type's top markers and shows their mean expression split by donor (a gene × donor heat). Markers reading the SAME across donors confirm a genuinely merged population; divergent ones are suspect. scopeGrouping/scopeValue = the cell type (e.g. cell_type, \"CD8+ T cells\"); splitField = the donor/batch field (sample). Adds the panel to the workbench.", input_schema: { type: "object", properties: { scopeGrouping: { type: "string" }, scopeValue: { type: "string" }, splitField: { type: "string" } }, required: ["scopeGrouping", "scopeValue", "splitField"] } },
  // ---- escape hatch: sandboxed ad-hoc computation when the primitives above can't express it ----
  { name: "compute_code", description: "ESCAPE HATCH — run a short SANDBOXED JS computation when neither update_view (config) nor compute (de/overdispersion over cell sets) can express what you need: custom signature scores, ad-hoc per-cell metrics, bespoke filters, simple correlations. Prefer the dedicated tools when they fit; reach here only for the long tail. " + CODE_API_DOC + " Declare every gene your code reads in `genes`. The result lands in the disposable rail (or set toCanvas); it carries an 'unvalidated custom code' caveat.", input_schema: { type: "object", properties: { code: { type: "string", description: "async function BODY that returns a typed result (see above)" }, genes: { type: "array", items: { type: "string" }, description: "exact HGNC symbols the code reads via api.expr" }, grouping: { type: "string", description: "optional: expose api.stats (mean/frac) for this grouping" }, title: { type: "string" }, toCanvas: { type: "boolean" } }, required: ["code"] } },
  // ---- annotation: build a clean cell-type labeling by reconciling sources (see the Annotate workspace) ----
  { name: "run_annotation", description: "Compute an annotation SOURCE by running a cell-typing method in-browser, added as a layer to reconcile against others. method='sctype' scores each cluster against a bundled marker DB (no server). Then read get_reconciliation and compare in the Annotate workspace's Reconcile panel.", input_schema: { type: "object", properties: { method: { type: "string", enum: ["sctype"] }, base: { type: "string", description: "clustering to label (default leiden)" } }, required: ["method"] } },
  { name: "annotate", description: "Write a cell-type LABEL onto a cell set in the WORKING annotation draft (last-write-wins; the draft auto-creates and is non-destructive — clusters stay intact). A is a CELL-SET expression, same algebra as compute ({category:{grouping,value}}, {selection:true}, {intersect:[…]}, {union:[…]}, …). Use this to resolve the reconciliation — e.g. accept a cell type for a cluster, or merge/split by labeling the exact cells. The working draft becomes the default grouping and colours every panel.", input_schema: { type: "object", properties: { label: { type: "string" }, A: { type: "object", description: "the cells to label (cell-set expression)" } }, required: ["label", "A"] } },
  { name: "get_reconciliation", description: "Read how the annotation sources compare per base cluster (working draft + each source's dominant label) and which clusters they DIFFER on — so you can advise, explain, and resolve. Differences are often just vocabulary across sources (CD14 mono vs CD14+ monocyte); weigh markers + the confusion matrix before calling a real conflict.", input_schema: { type: "object", properties: { base: { type: "string", description: "clustering as the reconciliation unit (default leiden)" } } } },
  { name: "adopt_source", description: "Set the WORKING annotation draft to a source's per-cluster labeling in ONE step (the fast 'start from scType / cell_type'), then fix the few wrong clusters with annotate. source = an annotation source name (see get_reconciliation); base = clustering (default leiden).", input_schema: { type: "object", properties: { source: { type: "string" }, base: { type: "string" } }, required: ["source"] } },
  { name: "import_labeling", description: "Import an EXTERNAL cluster-level labeling as a new reconciliation SOURCE — e.g. CellTypist/Azimuth output or a colleague's annotation the user pastes. labels = { clusterValue: cellTypeLabel } mapping base clusters to labels; base = the clustering the keys refer to (default leiden); name = the source's name. Sources aren't limited to what's stored — this brings any labeling in to reconcile.", input_schema: { type: "object", properties: { labels: { type: "object", description: "{ cluster: label } — keys are base cluster values" }, base: { type: "string" }, name: { type: "string" } }, required: ["labels"] } },
  { name: "rename_label", description: "Rename a label in the WORKING annotation draft (clean up names for deposition). Renaming to an EXISTING label MERGES the two — the way to collapse 'two of my labels are really the same cell type'. from = current label, to = new name.", input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
  { name: "propose_labels", description: "BATCH suggest — propose CAP records for MANY working-draft labels in ONE call (the reliable way to 'name all my clusters'; prefer this over many propose_label calls). proposals = array of objects, each { label (required — the CURRENT label, verbatim), name (clean cell-type to rename it to), fullName, category, ontologyTermId (CL:xxxx), ontologyTerm, canonicalMarkers[], rationale }. Ground each in that cluster's markers. Emit the single propose_labels call — don't narrate first.", input_schema: { type: "object", properties: { proposals: { type: "array", items: { type: "object", properties: { label: { type: "string" }, name: { type: "string" }, fullName: { type: "string" }, category: { type: "string" }, ontologyTermId: { type: "string" }, ontologyTerm: { type: "string" }, canonicalMarkers: { type: "array", items: { type: "string" } }, rationale: { type: "string" } }, required: ["label"] } } }, required: ["proposals"] } },
  { name: "propose_label", description: "SUGGEST a CAP cell-type record for a label in the WORKING annotation draft — your proposed name + metadata, which populates the record card for the user to review and edit. This is the core assist: read the cluster's markers (get_reconciliation / the prompt) and propose. Optionally rename the working label via `name` (e.g. cluster id → 'CD8 effector T cell'). Ground the rationale in THIS dataset's markers, not priors alone. Fields: label (which working label to annotate, required), name (clean cell-type name to rename it to), fullName, synonyms[], category (parent/broader term), ontologyTermId (Cell Ontology CL:xxxx), ontologyTerm, canonicalMarkers[], rationale (1-2 sentences). HIERARCHY: category is the broader lineage — for multi-level annotation give a coarse›fine PATH like 'Myeloid › Monocyte' (the leaf is the label itself), which defines L1/L2 levels the user can colour by; a single term or blank = flat.", input_schema: { type: "object", properties: { label: { type: "string" }, name: { type: "string" }, fullName: { type: "string" }, synonyms: { type: "array", items: { type: "string" } }, category: { type: "string" }, ontologyTermId: { type: "string" }, ontologyTerm: { type: "string" }, canonicalMarkers: { type: "array", items: { type: "string" } }, rationale: { type: "string" } }, required: ["label"] } },
  { name: "set_field_roles", description: "Classify obs/metadata fields so the annotation panel knows which are SOURCES. L* can't read roles from the store, so YOU decide from the category values: 'annotation' = a cell-type labeling (a reconciliation source), 'partition' = a clustering (the reconciliation unit, e.g. leiden), 'covariate' = sample/donor/condition/batch, 'qc' = metrics/calls. Read FIELDS in the dataset brief. Only annotation-role fields become sources.", input_schema: { type: "object", properties: { annotation: { type: "array", items: { type: "string" } }, partition: { type: "array", items: { type: "string" } }, covariate: { type: "array", items: { type: "string" } }, qc: { type: "array", items: { type: "string" } } } } },
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
ANNOTATION (the Annotate workspace): reconcile candidate labelings into one clean cell-type annotation. run_annotation adds a SOURCE (e.g. sctype); get_reconciliation reads how sources compare per cluster + where they differ; adopt_source sets the whole working draft to a source's labeling in one step; annotate writes a label onto a cell set in the WORKING draft (last-write-wins, non-destructive). Typical flow: run_annotation → adopt_source the best one → fix the few wrong clusters with annotate → name + document the labels with propose_label. SUGGESTING is the main way you help here: propose_label writes a proposed CAP record (clean name via the 'name' field, fullName, parent category, Cell-Ontology term, canonical markers, marker-grounded rationale) onto a working label, populating the record card for the user to review/edit. PROACTIVELY offer it — after adopt_source/annotate, suggest naming the clusters (e.g. 'want me to name and document these from their markers?') and, when asked or when clusters are still cluster-ids/vague, call propose_label per cluster grounded in each one's top markers. Advise and explain (markers + the confusion matrix) — cross-source string differences are often just vocabulary, not real conflicts. When a labeling does NOT map 1:1 to clusters (a source SPLITS a cluster, or two sources disagree at sub-cluster resolution), reconcile by INTERSECTION rather than per-cluster: annotate the exact disagreeing cells, e.g. A={intersect:[{category:{grouping:"scType",value:"CD14+ monocyte"}},{category:{grouping:"annotation",value:"NK"}}]} labels just the cells scType calls monocyte but the draft calls NK. The confusion matrix's off-diagonal counts are exactly these intersections. HIERARCHY: annotations are often multi-level. The working draft is the FINEST level; coarser levels are derived from each label's category lineage path (coarse›fine, e.g. 'Lymphoid › T cell' for leaf 'CD8 T effector'). Coarser annotation is usually easier — when asked, propose the lineage for each label (set the category field to the path) so the user gets L1/L2 rollups to colour/group by; keep it optional (blank = flat).
The change itself is visible, so keep your prose to ONE short sentence. Never narrate state the user can already see.

METHODOLOGY (cacoa — encode these, don't forget them):
- The replicate is the SAMPLE/DONOR, not the cell. Cell-level p-values overstate population effects.
- For a population-level claim, use pseudobulk across donors, not pooled-cell tests; say so.
- Cluster proportions are COMPOSITIONAL (sum to 1) — a rise in one forces others down; use a compositional test.
- Refuse or caveat a design that can't support a claim (e.g. 1-vs-1). If a result carries such a caveat, state it briefly. When unsure whether a claim is population- vs subpopulation-level, ASK a one-line clarifying question instead of running the wrong test.
- DE and overdispersion are scope-correct: ranked over ALL genes for the cells in question (a selection or subset), never a global gene shortlist — so they surface the genes that distinguish *that* scope.
- "Variable / overdispersed / most-variable GENES" means PER-GENE HVG → compute(stat:overdispersion): omit A for a global score, or pass A for a subpopulation (e.g. variable genes within monocytes). It's computed on the fly — never decline for lack of precompute. get_overdispersion is a DIFFERENT, precomputed gene-PROGRAM (aspect/module) list — only use it when the user explicitly asks for programs/aspects/modules.
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
    case "run_annotation": { const method = String(input.method || "sctype").toLowerCase(); if (method !== "sctype") return `unknown method "${method}" — available: sctype`; const { ok, error } = await app.runScType({ base: input.base }); return error ? `error: ${error}` : ok!; }
    case "annotate": {
      if (!input.label) return "annotate: 'label' is required"; if (!input.A) return "annotate: 'A' (a cell set) is required";
      const { ids, error } = app.resolveCells(input.A); if (error) return `error: ${error}`; if (!ids.length) return "annotate: that cell set resolved to 0 cells";
      app.labelCells(ids, String(input.label)); return `labeled ${ids.length} cells "${input.label}" in the working annotation draft`;
    }
    case "get_reconciliation": return await app.reconciliationSummary(input);
    case "adopt_source": { if (!input.source) return "adopt_source: 'source' is required"; const { ok, error } = await app.adoptSource(input.source, input.base); return error ? `error: ${error}` : ok!; }
    case "import_labeling": { const { ok, error } = await app.importLabeling(input); return error ? `error: ${error}` : ok!; }
    case "rename_label": { if (!input.from || !input.to) return "rename_label: 'from' and 'to' are required"; const { ok, error } = app.renameLabel("annotation", String(input.from), String(input.to)); return error ? `error: ${error}` : ok!; }
    case "propose_label": { if (!input.label) return "propose_label: 'label' is required"; const { ok, error } = app.proposeLabel(input); return error ? `error: ${error}` : ok!; }
    case "propose_labels": { if (!Array.isArray(input.proposals)) return "propose_labels: 'proposals' (array) is required"; const { ok, error } = app.proposeLabels(input.proposals); return error ? `error: ${error}` : ok!; }
    case "set_field_roles": return app.setFieldRoles(input);
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
  // Persist ONE running conversation across asks so follow-ups keep context — e.g. the agent asks "A or B?" and
  // the user's next message "B" is understood as the answer, not a fresh request. The loop below appends the
  // assistant + tool-result turns to this same array, so it accumulates the whole dialogue.
  if (!app.liveMessages) app.liveMessages = [];
  app.liveMessages.push({ role: "user", content: userText });
  trimLiveMessages(app.liveMessages);
  const messages = app.liveMessages;
  app.thread = { kind: "live", live: true, entries: [{ role: "user", text: userText }] };
  ag.renderThread(); app.setPip("working", "thinking");
  const sys = await systemPrompt(app);

  for (let turn = 0; turn < 8; turn++) {
    if (abort.aborted) break;
    const res = await fetch(PROXY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system: sys, messages, tools: TOOLS, model: "claude-opus-4-8", max_tokens: 4096 }), signal: abort });
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

// Bound the running conversation so it can't grow without limit. Drops oldest messages, then forward to a clean
// user-text turn so the window never starts mid-tool-cycle (an orphaned tool_result would be rejected by the API).
function trimLiveMessages(m: any[], max = 40): void {
  if (m.length <= max) return;
  m.splice(0, m.length - max);
  while (m.length && !(m[0].role === "user" && typeof m[0].content === "string")) m.shift();
}

function toolLabel(tu: any): string {
  const i = tu.input || {};
  if (tu.name === "update_view") {
    const bits: string[] = [];
    if (i.color) bits.push(`recolour → ${i.color}`);
    if (i.focus?.set) bits.push(`focus · ${i.focus.label || "subset"}`);
    else if (i.focus?.dim) bits.push(`focus ${i.focus.dim}=${i.focus.value}`);
    if (i.clearFocus) bits.push("release focus");
    if (i.display) bits.push("display");
    for (const p of (i.panels || [])) bits.push(p.add ? `+ ${p.add}` : p.remove ? `− panel #${p.id}` : `panel #${p.id}`);
    if (i.facet?.by) bits.push(`facet by ${i.facet.by}`);
    if (i.arrange) bits.push("arrange grid");
    return bits.join(" · ") || "update view";
  }
  if (tu.name === "get_markers") return `markers · ${i.cluster}`;
  if (tu.name === "compute") return i.stat === "overdispersion" ? "overdispersion" : "DE (compute)";
  if (tu.name === "compute_code") return "custom code";
  if (tu.name === "run_annotation") return `annotate · ${i.method || "sctype"}`;
  if (tu.name === "annotate") return `label · ${i.label}`;
  if (tu.name === "adopt_source") return `adopt · ${i.source}`;
  if (tu.name === "import_labeling") return `import · ${i.name || "labeling"}`;
  if (tu.name === "rename_label") return `rename · ${i.from}→${i.to}`;
  if (tu.name === "propose_label") return `suggest · ${i.name || i.label}`;
  if (tu.name === "propose_labels") return `suggest · ${(i.proposals || []).length} labels`;
  if (tu.name === "get_reconciliation") return "reconciliation";
  if (tu.name === "concordance_panel") return `concordance · ${i.scopeValue}`;
  if (tu.name === "propose_workspace") return `propose workspace · ${i.name}`;
  return tu.name.replace(/_/g, " ");
}
