// The live Anthropic planner: a streaming tool-use loop where the model drives the
// coordination space and earns bigger moves through tools. Renders into the timeline
// thread (the live tip), interruptible. Falls back to the mock planner if unreachable.
import type { App } from "../ui/shell.ts";
import { CODE_API_DOC } from "./codeapi.ts";
import { olsLookup } from "../anno/ols.ts";
import { WIDGET_API_DOC } from "../widget/contract.ts";
import { capabilityMenu } from "./capabilities.ts";
import { getWidgetTemplate } from "../widget/template.ts";
import { previewWidget } from "../widget/runtime.ts";
import { previewHost, PreviewSim } from "../widget/apphost.ts";
import { listRecipes, findRecipes, getRecipe, recipeSource } from "../widget/recipes.ts";
import { applyEdits } from "../widget/edits.ts";
import { getProvider, providerModel, adapterFor } from "./providers.ts";
import { newLoopState, isStuck } from "./loopguard.ts";
import { loadCred, buildDirectAnthropic, markCredExpired, localCfg, agentOff, proxyBase } from "./credentials.ts";

// The agent's network hop. With a pasted Anthropic credential (API key OR subscription OAuth token), call
// api.anthropic.com DIRECTLY from the browser — the zero-process path, no proxy. Otherwise hit the proxy (which holds
// a server-side credential). The Anthropic provider is canonical, so the SAME SSE parse loop consumes either stream.
function agentStream(built: any, meta: { provider: string; model: string; store: string | null }, abort: AbortSignal): Promise<Response> {
  if (meta.provider === "openai") {
    const lc = localCfg();
    if (lc?.url) return fetch(lc.url + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...built, model: lc.model || meta.model, stream: true, stream_options: { include_usage: true } }), signal: abort });   // browser-direct to a local OpenAI-compatible server
  } else {
    const cred = loadCred();
    if (cred) { const { url, headers, body } = buildDirectAnthropic({ ...built, model: meta.model }, cred); return fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: abort }); }   // browser-direct to Anthropic
  }
  return fetch(proxyBase() + "/agent/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...built, provider: meta.provider, model: meta.model, client: "app", runId: liveRunId(), store: meta.store }), signal: abort });   // the proxy (server-side credential), at the configured base
}

// A stable id for THIS browser session's conversation — minted once per page load, sent with every turn so the proxy's
// debug capture (PAGODA_AGENT_DEBUG) can attribute turns to one session (current.json + sess-<runId>.jsonl) instead of
// conflating concurrent tabs / the preview. Telemetry-only by default; no effect unless DEBUG is on server-side.
let _liveRunId = "";
function liveRunId(): string { if (!_liveRunId) _liveRunId = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); return _liveRunId; }

export async function checkLive(provider?: string): Promise<boolean> {
  if (agentOff()) return false;                                  // explicit "no copilot"
  if (provider === "openai") { if (localCfg()?.url) return true; }   // a configured local endpoint = reachable browser-direct
  else if (loadCred()) return true;                              // a pasted credential = reachable browser-direct (no proxy)
  // A static deploy with no proxy can declare it (publish bakes <meta name="pagoda3:agent" content="off">):
  // skip the /health probe so a shared artifact's console isn't littered with 404s. A pasted credential
  // (above) still works, and the user can still set one up via the agent panel.
  try { if (document.querySelector('meta[name="pagoda3:agent"]')?.getAttribute("content") === "off") return false; } catch { /* no DOM (tests) — fall through */ }
  try { const r = await fetch(proxyBase() + "/health" + (provider ? "?provider=" + encodeURIComponent(provider) : "")); const j = await r.json(); return !!j.ok; } catch { return false; }
}

interface Tool { name: string; description: string; input_schema: any; }

const TOOLS: Tool[] = [
  // ---- the single declarative surface for VIEW/LAYOUT ("what to show") ----
  { name: "describe_data", description: "Reflective lookup of the DATASET'S FIELDS bucketed by ROLE — the data analog of describe_panel. Returns: GROUPINGS (clusterings WITH markers — the ONLY valid Heatmap `group` / get_markers fields), COVARIATES (experimental factors like sample/condition/donor — the dimensions you COMPARE ACROSS via facet / scope / pseudobulk replicate, with the likely replicate flagged), NUMERIC fields (colour / threshold / compute_code), and the gene namespace. Call it when unsure which field fits a slot — BEFORE grouping a Heatmap, faceting, or choosing a pseudobulk replicate — because a covariate is NOT a grouping. Roles are heuristic; correct a wrong one with set_field_roles.", input_schema: { type: "object", properties: {} } },
  { name: "describe_panel", description: "Reflective lookup — what you can CONFIGURE, STYLE, or TRIGGER on a panel (works on ANY panel, built-in or agent-authored WIDGET). A built-in returns BOTH its DATA INPUTS (what it shows — e.g. a Heatmap's `group` with the VALID groupings listed, heatMode, genes, scope; an Embedding's colorBy/colormap/embedding) AND its STYLE keys (point/label/selection/… with current value + default + range, read live so they never drift). So call this FIRST whenever a panel field is rejected or you're unsure what a panel accepts — it tells you the valid values (e.g. that a Heatmap groups only by a clustering, not a covariate). Set DATA inputs via update_view({panels:[{id, …}]}); STYLE via update_view({style:{…}}) or pointSize/labelSize. A WIDGET returns its declared params + triggerable header controls. id = the panel (LAYOUT lists ids); omit for the main embedding.", input_schema: { type: "object", properties: { id: { type: "number", description: "panel id (omit → the main embedding)" } } } },
  { name: "update_view", description: "Change WHAT IS SHOWN — colour, focus, display options, and panels — in one reversible step. Pass only the fields you want to change; a view knob is a FIELD here, never a separate verb. Smallest changes first: `color` recolours ALL embeddings (the most common move). `focus` SUBSETS the workspace to one field=value — the rest is REMOVED from every view, not just dimmed (clearFocus to undo); a transient `select` only DIMS the rest instead. `display` sets labels / legend / alpha (point opacity 0–1; lower reveals density) / winsor (clip outlier cells off a numeric colour scale; 0.01 = 1% off each tail, the default). `panels` is an array of per-panel ops: to CONFIGURE an existing panel give its id (from LAYOUT) plus fields to change; to CREATE one give add:<type> (Embedding, Heatmap, CompositionBars, VariableGenes — the last is a LIVE top-overdispersed-genes panel for the current selection); to REMOVE give id + remove:true; to TRIGGER a Widget's declared header control give id + control:'<id>', or to SET a Widget's declared typed param give id + param:{id:'<id>', value:…} (discover both with describe_panel — this is how you drive an agent-authored widget). LAYOUT/placement: `col` (0-based; 0=leftmost) pins a panel to a column and the grid GROWS to fit — col:2 makes a THIRD column, so a three-column layout is just col 0/1/2 (no fixed two-column cap); give two panels the same col to stack them one under another; `full` makes a panel span the width, and two full panels stack one over the other (use this for a top/bottom compare, e.g. day0 over day7). Per-panel knobs: colorBy (override just this panel), scopeGrouping+scopeValue (restrict it to a population — an embedding reframes to those cells and greys the rest; a Heatmap is FACETED, its dots computed within that population; clearScope to undo). To COMPARE a factor (e.g. day0 vs day7) do NOT hand-build several scoped panels — use the top-level `facet` field, e.g. facet:{by:'condition'} (split one panel into aligned copies that share rows+columns; to facet TWO panels, send two update_view calls), which can't diverge the way separate panels do, embedding (which projection, see EMBEDDINGS), colormap (palette for NUMERIC colourings — gene/qc/score: amber (default), viridis, rdbu = red→blue, bluered, blues; aliases like 'red-to-blue' work; ignored for categorical colourings). To DEFINE YOUR OWN numeric gradient instead of a named one, pass `colorStops`: an array of css colours low→high (e.g. ['#101030','#ff3030'] or ['white','purple']) — it becomes the 'custom' palette and applies to the EMBEDDING's current gene/qc/score colouring. (A Heatmap/dotplot's colour is SEPARATE — its own style.ramp, NOT colorStops: to recolour a dotplot, describe_panel(id) then set style:{ramp:{lo,hi}}.) `recolor` sets the colour of INDIVIDUAL category VALUES of a categorical field (the per-value analogue of colormap): recolor:{field?, colors:{<value>:'<css colour>', …}} — e.g. recolor:{colors:{'low':'lightgrey'}} greys just the 'low' cells; field defaults to the current colour-by; the value '' or 'unassigned' targets the cells in NO category; colours accept any CSS form ('lightgrey', '#ccc', 'rgb(200,200,200)'); recolor:{field, clear:true} resets a field's overrides. Use this for 'make X grey / colour Y red' instead of focus/recolour workarounds. `style` is the OPEN escape hatch for a panel's rendering constants (point / label / selection / crosshair / fit, and more) — DON'T guess the keys: call `describe_panel(id)` to SEE the exact styleable keys, their current values + ranges, then set them: style:{<family>:{<key>:value}} (global, or per-panel via stylePanel:<id> OR panels:[{id, style:{…}}]; styleReset:true clears). `pointSize`/`labelSize` are px shortcuts (→ point.radius / label.fontSize). So 'bigger points', 'smaller labels', 'thinner selection rings', 'tighter zoom' are DIRECT — never decline a basic visual tweak; if it's not a named field, describe_panel it and set the style key. A Heatmap shows the top markers per group: group sets the grouping, heatMode is 'dotplot' (the DEFAULT; dot size = % expressing, colour = mean) or 'heatmap' (colour grid), and genes PINS specific genes (highlighted, merged in) — it can show ANY gene, so to surface e.g. IL17A in the marker view add it via genes rather than declining (clearGenes resets). Invalid bits (unknown gene/field/type/id) are skipped and reported back so you can correct. Prefer ONE update_view with several panel ops over many calls.",
    input_schema: { type: "object", properties: {
      color: { type: "string", description: "global colour handle: meta:<field> (cell_type, leiden, sample, condition), gene:<SYMBOL>, qc:<metric> (e.g. qc:mito), or geneset:<name>" },
      focus: { type: "object", properties: { dim: { type: "string" }, value: { type: "string" }, set: { type: "object" }, label: { type: "string" } }, description: "SUBSET (level 3) the whole workspace to a subpopulation: the rest is REMOVED from every view — the embedding HIDES it (layout unchanged, no auto-zoom) and the facets / heatmap / composition / variable-genes / reconcile all recompute WITHIN the subset; a prominent banner offers Back-to-full. Either a category (dim=value, e.g. condition=disease) OR a cell-SET for a population spanning several labels — set = a cell-set expression (same algebra as compute/annotate, e.g. {union:[{category:{grouping:'annotation',value:'CD4 T'}},{category:{grouping:'annotation',value:'CD8 T'}}]} for T cells) + a short label. clearFocus to release." },
      clearFocus: { type: "boolean" },
      select: { type: "object", properties: { dim: { type: "string" }, value: { type: "string" } }, description: "TRANSIENT selection (level 2) of a metadata value (dim=value, e.g. cell_type=NK): the embedding DIMS the OTHER cells (so a gene/qc colour-by still reads THROUGH the selected ones) and live panels (variable-genes) scope to it — a sticky highlight, lighter and more reversible than focus/subset (which REMOVES the rest and cross-filters the facets). clearSelect to drop it." },
      clearSelect: { type: "boolean" },
      display: { type: "object", properties: { labels: { type: "boolean" }, legend: { type: "boolean" }, alpha: { type: "number", description: "point opacity 0–1; lower reveals density" }, winsor: { type: "number", description: "fraction (0–0.2) clipped off EACH tail of a numeric colour scale so a few outlier cells don't wash out the rest; 0.01 = 1% (default), 0 = off" } } },
      panels: { type: "array", description: "per-panel ops (configure by id / create with add / remove)", items: { type: "object", properties: {
        id: { type: "number", description: "existing panel to modify (from LAYOUT)" },
        add: { type: "string", description: "create a panel of this type: Embedding | Heatmap | CompositionBars | VariableGenes (a live panel of the top overdispersed genes for the current selection, recomputed as the selection changes; scopeGrouping/scopeValue pins it to a population)" },
        remove: { type: "boolean" },
        title: { type: "string" },
        col: { type: "number", minimum: 0, maximum: 3, description: "pin to a 0-based workbench column (0 = leftmost). The grid GROWS to fit the highest column you use (up to 4), so col:2 creates a THIRD column — that is how you build a three-column layout. To ADD a panel AS a new column, combine add:<type> with col (e.g. {add:'VariableGenes', col:2}); the EXISTING panels STAY and fill the other columns — NEVER remove them to 'make room'. Put two panels in the SAME col to stack them one under another." },
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
      facet: { type: "object", description: "SPLIT one panel into aligned copies that differ only by scope — the right way to compare a factor (e.g. day0 vs day7). `by` = the field to split on (condition, sample, outcome…). Optional: `panel` (id to split; default = the most recent Heatmap, else Embedding), `values` (subset of the field's values; default = all), `layout` ('stack' = full-width one over another, best for dotplots; 'side' = columns, best for embeddings; default auto by type). The copies share group/genes/mode (Heatmap) or the same projection reframed (Embedding), so rows+columns line up — do NOT hand-build several scoped panels. To REVERSE a split, use `unfacet`.", properties: { by: { type: "string" }, panel: { type: "number" }, values: { type: "array", items: { type: "string" } }, layout: { type: "string", enum: ["stack", "side"] } } },
      unfacet: { description: "The INVERSE of facet — collapse faceted copies back into ONE panel (\"unsplit\", \"merge the days back\", \"go back\"). `true` un-splits EVERY faceted group; a panel id un-splits just that panel's group; {by:'condition'} un-splits only groups split on that field. The surviving panel drops its scope and shows all cells again." },
      arrange: { type: "object", description: "REPOSITION existing panels into the grid — the right way to satisfy '2×2', 'three columns', 'side by side', 'stack these', 'put X above Y'. Give EITHER `rows` (one array per grid ROW, left→right; up to 4 ids each — a 1-id row spans full width) OR `columns` (one array per COLUMN, top→bottom; up to 4 columns — each column's ids stack). Use panel ids from LAYOUT. Examples — THREE columns side by side: columns:[[7],[8],[5]] (or equivalently rows:[[7,8,5]]). 2×2 with embeddings on top, dotplots below: rows:[[7,8],[5,6]]. Embeddings stacked in the left column, dotplots in the right: columns:[[7,8],[5,6]]. Everything stacked full-width: rows:[[7],[8],[5],[6]]. This ONLY moves panels (never recreates them, so scopes/genes are preserved) — prefer it over setting col/full one panel at a time, and NEVER remove+re-add panels just to rearrange.", properties: { rows: { type: "array", items: { type: "array", items: { type: "number" } } }, columns: { type: "array", items: { type: "array", items: { type: "number" } } } } },
    } } },
  // ---- compute primitives ("what to derive") — small, named, carry methodology + caveats ----
  { name: "set_gene_filter", description: "Set (or clear) a SESSION-WIDE 'ignore these genes' filter that drops matching genes from ALL data-driven gene RANKINGS — cluster markers (dot-plot), differential-expression tables, and variable-genes/HVG. Reach for it when housekeeping / technical genes crowd the top of marker or DE lists: mitochondrial (MT-), ribosomal (RPS, RPL), MALAT1, hemoglobin (HB), etc. Patterns are case-insensitive PREFIXES (trailing * optional): 'RPS' drops RPS3A/RPS27A…; 'MT-' drops MT-ND1…. It does NOT touch QC metrics (percent_mito is a stored measure) or gene-set / signature scores (those target genes on purpose). OFF by default — NEVER enable it silently: OFFER it ('the marker lists are topped by ribosomal/mito genes — want me to ignore those so real markers surface?') and set it only when the user agrees. It persists with the session; the user can ask you to change or clear it anytime (clear = exclude:[]). When you set or clear it, tell the user what changed and that it affects markers/DE/variable-genes everywhere.", input_schema: { type: "object", properties: { exclude: { type: "array", items: { type: "string" }, description: "gene-symbol prefixes to ignore, e.g. ['MT-','RPS','RPL','MALAT1']; pass [] to clear the filter" } }, required: ["exclude"] } },
  { name: "get_markers", description: "Add a ranked marker-gene table for a group (cluster or annotation) to the disposable answer rail, and return the top genes. Rung-1 answer.", input_schema: { type: "object", properties: { cluster: { type: "string", description: "group id, e.g. a leiden cluster (c0 / 5) or a cell type name" }, grouping: { type: "string", description: "which precomputed grouping the id belongs to (e.g. leiden or cell_type); defaults to leiden" } }, required: ["cluster"] } },
  { name: "compute", description: "Run a statistic over CELL SETS, result to the rail (or canvas with toCanvas). stat='de' = differential expression of set A vs set B, compared DIRECTLY (logFC>0 = higher in A); B defaults to the COMPLEMENT of A (i.e. A vs rest). CELL-LEVEL (ranking-grade, NO p-value) — the donor is the real replicate, so de OVERSTATES confidence for a population claim. stat='pseudobulk' = the DONOR-LEVEL version of de and the statistically CORRECT way to compare a factor across samples: it aggregates A's and B's cells to one mean PER REPLICATE (pass replicate=the donor/sample field, e.g. replicate:'sample') and runs a Welch t-test ACROSS replicates → a REAL p-value (shown as a 'p' column). Use pseudobulk whenever the user compares CONDITIONS / SAMPLES / TIMEPOINTS / GENOTYPES and wants a genuine difference (not just a ranking) — A and B are the two groups (e.g. A=condition:disease, B=condition:control), replicate is the donor field. Needs ≥2 replicates per side (it errors otherwise — a 1-vs-1 design can't support a population claim). stat='overdispersion' = most variable genes WITHIN A, recomputed for that scope. A and B are CELL-SET expressions you compose freely — {category:{grouping,value}}, {selection:true}, {focus:true}, {all:true}, {complement:<set>}, {intersect:[<set>,…]}, {union:[<set>,…]}. So you can test ANY set you can describe, not just pre-baked combos. Examples — naive vs memory B: A={category:{grouping:'cell_type',value:'B (naive)'}}, B={category:{grouping:'cell_type',value:'B (memory)'}}. Markers of a cluster: A={category:{grouping:'leiden',value:'3'}} (B defaults to rest). DE on the current selection: A={selection:true}. Within CD8 T, day7 vs day0: A={intersect:[{category:{grouping:'cell_type',value:'CD8 T'}},{category:{grouping:'condition',value:'day7'}}]}, B=same with day0 — residual RPS/RPL or MT- splitters inside one type = batch. Variable genes in platelets: stat='overdispersion', A={category:{grouping:'cell_type',value:'Platelet'}}. stat='overdispersion' IS the per-gene 'highly variable genes' (HVG) score — use it for ANY 'variable / overdispersed / most-variable GENES' request; it's computed on the fly (no precompute needed), works GLOBALLY (omit A, or A={all:true}) or scoped to any subpopulation, and returns a ranked per-gene list. Do NOT use get_overdispersion for this — that is a different, precomputed gene-PROGRAM (aspect/module) view, not per-gene. Cell-level ranking-grade; the donor/patient is the replicate (the caveat travels on the result).", input_schema: { type: "object", properties: { stat: { type: "string", enum: ["de", "pseudobulk", "overdispersion"] }, A: { type: "object", description: "cell set (see forms above); for overdispersion omit to score genes globally (A={all:true})" }, B: { type: "object", description: "de/pseudobulk — the contrast set; omit to use the complement of A (A vs rest)" }, replicate: { type: "string", description: "pseudobulk ONLY — the donor/sample categorical field that defines biological replicates (e.g. 'sample'); A and B are aggregated to one mean per replicate, then tested across replicates" }, toCanvas: { type: "boolean", description: "put it on the workbench (evidence board) instead of the disposable rail" }, title: { type: "string", description: "OPTIONAL and usually UNNEEDED — the system names the card from the resolved sets (e.g. 'CD14 mono vs rest', 'leiden 4 vs rest'); a title you pass for a category/cluster/selection contrast is IGNORED. Set it ONLY to name an otherwise-anonymous manual (lasso) selection; never pass a generic 'selection vs rest'." } }, required: ["stat"] } },
  { name: "get_composition", description: "Add a per-sample cluster-composition panel (compositional) to the rail and return the disease-vs-control cluster fractions. Rung-1.", input_schema: { type: "object", properties: {} } },
  { name: "get_overdispersion", description: "Add the precomputed gene-PROGRAM (aspect / gene-module) overdispersion list to the rail — NOT per-gene, and only available when the store has precomputed aspects. For per-gene variable/overdispersed genes (the usual request), use compute stat='overdispersion' instead (computed on the fly, global or scoped).", input_schema: { type: "object", properties: {} } },
  { name: "propose_workspace", description: "Propose switching to a named workspace (a bigger, reversible layout change the human confirms). name is one of: Overview, Markers, QC triage, Aspects.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "add_note", description: "Add a short text note to the rail (for an answer that needs no view).", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "concordance_panel", description: "Per-donor MARKER concordance for one cell type — the companion to a within-type compute(stat:de). Takes that cell type's top markers and shows their mean expression split by donor (a gene × donor heat). Markers reading the SAME across donors confirm a genuinely merged population; divergent ones are suspect. scopeGrouping/scopeValue = the cell type (e.g. cell_type, \"CD8+ T cells\"); splitField = the donor/batch field (sample). Adds the panel to the workbench.", input_schema: { type: "object", properties: { scopeGrouping: { type: "string" }, scopeValue: { type: "string" }, splitField: { type: "string" } }, required: ["scopeGrouping", "scopeValue", "splitField"] } },
  // ---- escape hatch: sandboxed ad-hoc computation when the primitives above can't express it ----
  { name: "compute_code", description: "ESCAPE HATCH — run a short SANDBOXED JS computation when neither update_view (config) nor compute (de/overdispersion over cell sets) can express what you need: custom signature scores, ad-hoc per-cell metrics, bespoke filters, simple correlations. Prefer the dedicated tools when they fit; reach here only for the long tail. " + CODE_API_DOC + " Declare every gene your code reads in `genes`. The result lands in the disposable rail (or set toCanvas); it carries an 'unvalidated custom code' caveat.", input_schema: { type: "object", properties: { code: { type: "string", description: "async function BODY that returns a typed result (see above)" }, genes: { type: "array", items: { type: "string" }, description: "exact HGNC symbols the code reads via api.expr" }, grouping: { type: "string", description: "optional: expose api.stats (mean/frac) for this grouping" }, title: { type: "string" }, toCanvas: { type: "boolean" } }, required: ["code"] } },
  // ---- custom widgets (generative UI): author a bespoke interactive panel the built-ins don't provide ----
  { name: "read_widget_contract", description: "Return the full WIDGET authoring contract — the `pagoda` API a widget uses, the data kinds it can pull, and the theming + coordination rules. Read it the first time you author a widget in a session.", input_schema: { type: "object", properties: {} } },
  { name: "list_widget_capabilities", description: "List the kernel-backed ANALYTIC PRIMITIVES a widget can call via `pagoda.compute(name, args)` — the SAME analyses available as `compute` tools, now usable INSIDE a widget (overdispersion / de / markers / groupStats). Returns each primitive's name, what it returns, when to use it, params, and an example. Use this when authoring a data/analysis widget so you call the fast, correct primitive (e.g. 'overdispersion' for variable genes) instead of looping raw expr and recomputing statistics by hand.", input_schema: { type: "object", properties: {} } },
  { name: "get_widget_template", description: "Return a starter widget SOURCE to adapt. kind='kitchen' (default — demonstrates every capability: read coord, setColor/setSelection, pull data, a header control, an SVG) or 'blank' (minimal).", input_schema: { type: "object", properties: { kind: { type: "string" } } } },
  { name: "find_widget_recipe", description: "LOOK UP recipes + snippets by free-text need (e.g. 'scatter hover click', 'colour scale', 'histogram bins', 'axes'). Returns ranked matches: kind 'widget' = a complete widget to adapt; kind 'snippet' = reusable building-block functions to PASTE IN (the plot kit — scales, nice-ticks, canvas point cloud, nearest-point hit-test for hover/click, colour ramps, SVG axes, binning). This is how you get 'a plotting library' while staying self-contained: pull only the snippets you need and inline them. For anything chart/viz/interaction-shaped, look here FIRST, then get_widget_recipe each match.", input_schema: { type: "object", properties: { query: { type: "string", description: "what you need, e.g. 'canvas scatter with point hover'" } }, required: ["query"] } },
  { name: "list_widget_recipes", description: "List ALL built-in recipes + snippets (name, kind, about). Recipes = complete widgets (ranked bars, histogram+brush, canvas scatter, expression heatmap, donut, selection-breakdown); snippets = inlinable building blocks (scales, canvas-points, hit-test, color, svg-axes, bins). Prefer find_widget_recipe when you know what you need.", input_schema: { type: "object", properties: {} } },
  { name: "get_widget_recipe", description: "DELIVER a recipe/snippet's full SOURCE by name (from find/list) — a widget to adapt, or snippet helpers to paste in. Compose a few snippets + your own glue, then preview_widget before saving.", input_schema: { type: "object", properties: { name: { type: "string", description: "recipe/snippet name, e.g. 'scatter' or 'hit-test'" } }, required: ["name"] } },
  { name: "fetch_url", description: "Fetch the TEXT of a web page (server-side, so no CORS) to consult an external viz/data technique or doc when the recipes don't cover it — e.g. a charting-pattern or algorithm reference. Returns truncated text. The widget itself must stay SELF-CONTAINED (no remote code/CDN at runtime); use this only to learn a technique, then write the code inline.", input_schema: { type: "object", properties: { url: { type: "string", description: "an https:// page URL" } }, required: ["url"] } },
  { name: "preview_widget", description: "Render a widget SOURCE in a sandbox and return {ok, error, logs, manifest, renderedText, emitted} — your TEST/DEBUG loop. Pass the FULL `source` the FIRST time; after that OMIT source to re-preview the current widget (e.g. with a probe) without re-emitting it. To FIX, prefer edit_widget (small patches) over re-sending the whole source. To test interactive logic pass `probe`: JS run after mount IN THE WIDGET'S OWN SCOPE — call the widget's functions / set inputs, e.g. \"document.querySelector('#g').value='CD3E'; await compute();\" — prefer ONE preview WITH a probe. If the widget POPULATES ASYNC on mount (it awaits data/compute/runCompute in an init fn), the probe must WAIT for that first — await the widget's init fn (e.g. await run()) or a short delay — BEFORE you click/read, or you race an empty DOM (a click hits null). renderedText includes a [viz: …] summary of SVG/canvas content so you can confirm a CHART drew WITHOUT a DOM-counting probe. The preview WAITS for the widget's data/fetch/lib to settle before snapshotting (so an external/async widget is captured rendered, not 'loading…'). TEST COORDINATION here: pass `select` to preview AS IF a selection were active (so a selection-reactive widget actually renders rows instead of 'nothing selected') and `hint` to simulate a hover; the widget's writes are CAPTURED and returned as `emitted` (e.g. 'setSelection(category cell_type=NK)'), so a probe that clicks a row lets you CONFIRM it drives the right coordination — without touching the live session.", input_schema: { type: "object", properties: { from: { type: "string", description: "seed from a recipe by name (e.g. 'scatter') instead of typing its source. Pass it ONCE to start a widget; re-passing the SAME recipe later is ignored (so you don't lose your edits) — omit `from` and `source` to keep iterating on the current widget. A DIFFERENT recipe, or a full `source`, replaces the working widget." }, source: { type: "string", description: "full source — first time, or to START A NEW/DIFFERENT widget (it replaces the current working source); omit to reuse the current source" }, probe: { type: "string", description: "optional JS run after mount to exercise interactions (can be async)" }, select: { description: "simulate a SELECTION for the preview so reactive code runs: {grouping,value} (e.g. {grouping:'cell_type',value:'NK'}), {cells:[…]}, or null for 'nothing selected'" }, hint: { description: "simulate a cross-panel HOVER: {grouping,value} or {cells:[…]} or null" }, colorBy: { type: "string", description: "simulate the global colour handle (e.g. 'gene:CD3E')" } } } },
  { name: "edit_widget", description: "FIX or ADAPT a widget with str_replace-style edits (like the text-editor tool) instead of re-emitting the whole source — far fewer tokens + faster — then it previews automatically. `edits` is an array applied in order; each is {old_str, new_str}: `old_str` must match the CURRENT widget source EXACTLY (verbatim, including whitespace) and UNIQUELY — include enough surrounding lines to make it the only match; `new_str` is the replacement (use \"\" to delete). ATOMIC: if any old_str isn't found or isn't unique, NOTHING changes and you get the failures back (or re-send the full source via preview_widget to resync). Use this for every fix after the first preview. To ADAPT a recipe, pass `from` (the recipe name) and the edits adapt ITS source — you never re-type the recipe body (much cheaper than preview_widget with full source). Pass `probe` to also exercise interactions, and `select`/`hint` to test coordination (same as preview_widget).", input_schema: { type: "object", properties: { from: { type: "string", description: "seed from a recipe ONCE, then apply the edits to ITS source. On later edit_widget calls OMIT `from` — re-passing the same recipe is ignored (it does NOT re-seed), so your accumulated edits are preserved. (To start a different widget, pass full `source` to preview_widget first.)" }, edits: { type: "array", description: "str_replace edits, applied in order", items: { type: "object", properties: { old_str: { type: "string", description: "exact, unique text in the current source" }, new_str: { type: "string", description: "replacement (\"\" to delete)" } }, required: ["old_str", "new_str"] } }, probe: { type: "string", description: "optional JS run after mount to exercise interactions" }, select: { description: "simulate a selection (see preview_widget)" }, hint: { description: "simulate a hover (see preview_widget)" }, colorBy: { type: "string", description: "simulate the colour handle" } }, required: ["edits"] } },
  { name: "save_widget", description: "Mount the finished widget as a Widget PANEL on the workbench. Call only once preview_widget returned ok:true. OMIT `source` to mount EXACTLY what you last previewed (the default + much faster — don't re-emit the whole source); pass `source` only if you changed it since the last preview. REVISING an existing widget (the user asks to fix/clean up/extend one already on the canvas): keep the SAME `title` — save_widget then UPDATES that panel in place (no duplicate). Use a NEW title only for a genuinely separate widget. The widget reads/writes the same coordination space (selection/colour) as other panels and themes automatically.", input_schema: { type: "object", properties: { source: { type: "string", description: "optional — omit to reuse the last previewed source" }, title: { type: "string" } } } },
  { name: "inspect_widget", description: "CHECK A WIDGET'S LIVE USE after it's mounted — returns its current rendered text, recent console logs, any runtime error, its manifest, and `checks` (a REFLECTION lint), captured from the actual running panel (with real data + the user's current selection). REFLECT on what you built: `checks` flags well-formedness gaps to fix BEFORE telling the user it's done — chiefly a tunable VALUE built as an internal slider/select instead of a declared param (so it can't be driven by you or by voice and isn't persisted), plus declared-but-unwired params/controls and a fetch/compute the manifest doesn't declare. Use it to confirm a widget you saved is actually working AND well-formed, or to debug one the user says is misbehaving, then fix it (re-author + save_widget) — re-inspect until `checks` is empty and it renders right. Omit panelId if there's only one widget; otherwise pass it (LAYOUT lists Widget panel ids).", input_schema: { type: "object", properties: { panelId: { type: "number" } } } },
  // ---- annotation: build a clean cell-type labeling by reconciling sources (see the Annotate workspace) ----
  { name: "run_annotation", description: "Compute an annotation SOURCE by running a cell-typing method in-browser, added as a layer to reconcile against others. method='sctype' scores each cluster against a bundled marker DB (no server). Then read get_reconciliation and compare in the Annotate workspace's Reconcile panel.", input_schema: { type: "object", properties: { method: { type: "string", enum: ["sctype"] }, base: { type: "string", description: "clustering to label (default leiden)" } }, required: ["method"] } },
  { name: "annotate", description: "Write a cell-type LABEL onto a cell set in the WORKING annotation draft (last-write-wins; the draft auto-creates and is non-destructive — clusters stay intact). A is a CELL-SET expression, same algebra as compute ({category:{grouping,value}}, {selection:true}, {intersect:[…]}, {union:[…]}, …). Use this to resolve the reconciliation — e.g. accept a cell type for a cluster, or merge/split by labeling the exact cells. The working draft becomes the default grouping and colours every panel.", input_schema: { type: "object", properties: { label: { type: "string" }, A: { type: "object", description: "the cells to label (cell-set expression)" } }, required: ["label", "A"] } },
  { name: "get_reconciliation", description: "Read how the annotation sources compare per base cluster (working draft + each source's dominant label), the TOP MARKER GENES per cluster (inline — everything you need to GROUND a label), and which clusters they DIFFER on — so you can advise, explain, and resolve. Because the markers are here, you do NOT need a get_markers call per cluster to name them (that clutters the Answers rail) — this ONE call grounds every propose_label. Differences are often just vocabulary across sources (CD14 mono vs CD14+ monocyte); weigh markers + the confusion matrix before calling a real conflict.", input_schema: { type: "object", properties: { base: { type: "string", description: "clustering as the reconciliation unit (default leiden)" } } } },
  { name: "adopt_source", description: "Set the WORKING annotation draft to a source's per-cluster labeling in ONE step (the fast 'start from scType / cell_type'), then fix the few wrong clusters with annotate. source = an annotation source name (see get_reconciliation); base = clustering (default leiden).", input_schema: { type: "object", properties: { source: { type: "string" }, base: { type: "string" } }, required: ["source"] } },
  { name: "import_labeling", description: "Import an EXTERNAL cluster-level labeling as a new reconciliation SOURCE — e.g. CellTypist/Azimuth output or a colleague's annotation the user pastes. labels = { clusterValue: cellTypeLabel } mapping base clusters to labels; base = the clustering the keys refer to (default leiden); name = the source's name. Sources aren't limited to what's stored — this brings any labeling in to reconcile.", input_schema: { type: "object", properties: { labels: { type: "object", description: "{ cluster: label } — keys are base cluster values" }, base: { type: "string" }, name: { type: "string" } }, required: ["labels"] } },
  { name: "rename_label", description: "Rename a label in the WORKING annotation draft (clean up names for deposition). Renaming to an EXISTING label MERGES the two — the way to collapse 'two of my labels are really the same cell type'. from = current label, to = new name.", input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
  { name: "manage_category", description: "CREATE or MANAGE a custom categorical FIELD — a grouping the user can colour / facet / cross-tab / annotate by. This is the general 'make me a category and let me edit it' tool, SEPARATE from the cell-type annotation DRAFT (for that use annotate / propose_label). Pick one `op`: 'create' = build a new field from cell-SETS — assignments:[{value, A}] where A is a cell-set expression (same algebra as compute: {category:{grouping,value}}, {selection:true}, {focus:true}, {intersect:[…]}, {union:[…]}, {complement:…}); 'set_cells' = assign/move a cell set (A) to `value` (creates the field if new); 'rename_value' (from→to; to an EXISTING value MERGES); 'delete_value' (value — unassign its cells, dropping the value); 'merge_values' (values:[…] → into); 'rename_field' (name→to); 'delete' (name). To create a category from a NUMERIC THRESHOLD or an expression (e.g. high-mito, signature tertiles), use compute_code returning {kind:'category'} instead — it can read api.numeric and assign every cell. Only fields YOU created can be renamed/deleted; stored fields (cell_type, leiden, sample) are immutable.", input_schema: { type: "object", properties: { op: { type: "string", enum: ["create", "set_cells", "rename_value", "merge_values", "rename_field", "delete"] }, name: { type: "string", description: "the categorical field to create/edit" }, assignments: { type: "array", description: "create: [{value, A}] — label each cell-set A with a value", items: { type: "object", properties: { value: { type: "string" }, A: { type: "object" } }, required: ["value", "A"] } }, value: { type: "string", description: "set_cells: the category value to assign" }, A: { type: "object", description: "set_cells: the cell set (expression)" }, from: { type: "string", description: "rename_value: the current value" }, to: { type: "string", description: "rename_value / rename_field: the new name" }, values: { type: "array", items: { type: "string" }, description: "merge_values: the values to fold in" }, into: { type: "string", description: "merge_values: the surviving value" } }, required: ["op"] } },
  { name: "lookup_ontology", description: "Resolve a Cell Ontology (CL) term by name via EBI's OLS — grounds an annotation in a REAL ontology id (CL:xxxx) + canonical name instead of recalling one from memory. Returns the top hits [{id, label, description}]. Use it when proposing/cleaning cell-type labels (propose_label / propose_labels) to fill ontologyTermId + ontologyTerm correctly — especially for less-common cell types, where a remembered id is easy to get wrong.", input_schema: { type: "object", properties: { term: { type: "string", description: "the cell-type name to resolve, e.g. 'natural killer cell' or 'plasmablast'" } }, required: ["term"] } },
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
- CUSTOM WIDGETS (generative UI) are the UI escape hatch: when the user wants a bespoke interactive panel the built-ins don't provide (a custom chart, control, calculator, mini-tool), AUTHOR one. For anything CHART/VIZ/INTERACTION-shaped — OR a VIEWER over external data (a protein/molecule structure, a sequence, an external record) — LOOK UP recipes FIRST: find_widget_recipe('what you need') → get_widget_recipe each hit. There are worked whole-widget recipes for these (e.g. structure-viewer renders a clean single-chain 3D structure; pdb-card shows entry metadata), so you adapt a good default instead of hand-rolling one that renders the whole busy assembly. It returns whole widgets to adapt AND inlinable snippets — the plot kit (scales, nice-ticks, canvas point cloud, nearest-point hit-test for point hover/click, colour ramps, SVG axes, binning). That's how you get 'a plotting library' while staying self-contained: pull only the snippets you need and paste them in (don't hand-roll axes/scales/hit-testing from scratch, and never load a CDN). Fall back to get_widget_template (kitchen sink) / read_widget_contract for the base API. When ADAPTING one recipe, prefer edit_widget with from:<recipe> + small edits (never re-type the recipe body) — otherwise preview_widget ONCE with the full source (pass a 'probe' to exercise interactive logic); then FIX with edit_widget (small str_replace patches, NOT a whole-source re-emit) until ok:true → save_widget with NO source (reuses the last preview). After saving (or when the user says a widget misbehaves), inspect_widget to CHECK its live use — its rendered text/logs/errors against real data + the current selection — and fix if needed. For a technique the recipes don't cover, fetch_url can pull an external reference, but the widget itself stays self-contained (no CDN). A widget reads/writes the SAME coordination space (selection/colour) and themes automatically. COORDINATION widgets (react to / drive selection + hover): TEST them in preview — pass select:{grouping,value} (and/or hint:) to preview_widget AS IF a selection/hover were active, so reactive code actually renders (not 'nothing selected'); the widget's writes come back as an 'emitted' list so a probe that clicks an element confirms it drives the right setSelection/setHint. Do NOT ship reactive code you never saw run. For 'top/marker genes of the selection' (a very common ask) pull data('rankGenes') — one fast DE-vs-rest call — never loop expr over a hand-picked gene list. YOUR ANALYST POWERS PROJECT INTO WIDGETS: every kernel analysis you can run as a compute tool is callable INSIDE a widget via await pagoda.compute(name, args) — 'overdispersion' (variable/HVG genes for a cell set), 'de' (A-vs-B), 'markers' (cell set vs rest), 'groupStats' (per-group mean+%expressing); call list_widget_capabilities for params/examples. So for a 'variable genes' widget use pagoda.compute('overdispersion', …), for a contrast pagoda.compute('de', {A,B}) — NEVER hand-roll statistics from raw expr when a primitive fits (it's slow AND less correct). When NO primitive fits and you need a HEAVY or CUSTOM computation (a co-expression / correlation network, a signature score, custom clustering — typically over MANY genes at once), use await pagoda.runCompute(code, {genes, grouping, args}): your code runs OFF the main thread in a host-spawned, TERMINABLE worker next to the data (the UI never freezes, a runaway loop is killed), gets api.expr/api.cat/api.embedding/api.args, and RETURNS any JSON your widget then renders — declare the genes you need (raw vectors stay in the worker, only the small result returns). Reach for pagoda.compute (fixed kernels) first; pagoda.runCompute is the unbounded escape hatch under it. Prefer built-in panels when they fit; author a widget for the genuine long tail.
ANNOTATION (the Annotate workspace): reconcile candidate labelings into one clean cell-type annotation. run_annotation adds a SOURCE (e.g. sctype); get_reconciliation reads how sources compare per cluster + where they differ; adopt_source sets the whole working draft to a source's labeling in one step; annotate writes a label onto a cell set in the WORKING draft (last-write-wins, non-destructive). Typical flow: run_annotation → adopt_source the best one → fix the few wrong clusters with annotate → name + document the labels with propose_label. SUGGESTING is the main way you help here: propose_label writes a proposed CAP record (clean name via the 'name' field, fullName, parent category, Cell-Ontology term, canonical markers, marker-grounded rationale) onto a working label, populating the record card for the user to review/edit. PROACTIVELY offer it — after adopt_source/annotate, suggest naming the clusters (e.g. 'want me to name and document these from their markers?') and, when asked or when clusters are still cluster-ids/vague, call propose_label per cluster grounded in each one's top markers. Advise and explain (markers + the confusion matrix) — cross-source string differences are often just vocabulary, not real conflicts. When a labeling does NOT map 1:1 to clusters (a source SPLITS a cluster, or two sources disagree at sub-cluster resolution), reconcile by INTERSECTION rather than per-cluster: annotate the exact disagreeing cells, e.g. A={intersect:[{category:{grouping:"scType",value:"CD14+ monocyte"}},{category:{grouping:"annotation",value:"NK"}}]} labels just the cells scType calls monocyte but the draft calls NK. The confusion matrix's off-diagonal counts are exactly these intersections. HIERARCHY: annotations are often multi-level. The working draft is the FINEST level; coarser levels are derived from each label's category lineage path (coarse›fine, e.g. 'Lymphoid › T cell' for leaf 'CD8 T effector'). Coarser annotation is usually easier — when asked, propose the lineage for each label (set the category field to the path) so the user gets L1/L2 rollups to colour/group by; keep it optional (blank = flat). To GROUND a cell-type's ontology id, call lookup_ontology(term) for a real CL:xxxx + canonical name (don't recall ids from memory for less-common types). CLOSE-OUT (do this at the END of any annotation task — the MOST IMPORTANT part): a run leaves SEVERAL groupings (the working draft, each candidate source, maybe coarse levels) and the user WILL lose track of which is which — so your final message MUST orient them in ONE compact list, naming each grouping and which to USE: \`annotation\` = the FINAL labeling, colour by this; each source (\`scType\`, a stored \`cell_type\`, an imported set) = a CANDIDATE you reconciled FROM, kept for provenance; \`annotation: L1\`/\`L2\` = coarser rollups, present ONLY if you set a lineage. Say where to manage them (the Metadata-panel facets / session ledger — rename · merge · delete). And keep it CLEAN as you go: the working \`annotation\` draft is the SINGLE evolving answer, NOT a new field per attempt — PRUNE (manage_category delete) any category left over from a corrected or abandoned step, so the end state is only the groupings that matter. Several versions are fine; an unexplained pile is not.
CATEGORIES (custom groupings the user asks you to make + manage — "make a category of …", "group these cells", "split into low/med/high", "flag the high-mito cells as a group"): you CAN create persistent categorical fields and edit them. From a NUMERIC THRESHOLD or an expression (high-mito, signature tertiles, a gene+condition rule) → compute_code returning {kind:'category', name, categories, codes} (it reads api.numeric / api.expr / api.cat and assigns EVERY cell). From CELL-SETS (a selection, or category algebra) → manage_category op:'create' with assignments:[{value, A}]. Then EDIT with manage_category — set_cells / rename_value / merge_values / rename_field / delete. The new field is a first-class grouping you can colour / facet / cross-tab / annotate by. This is SEPARATE from the cell-type annotation draft (that's annotate / propose_label).
The change itself is visible, so keep your prose to ONE short sentence. Never narrate state the user can already see.

METHODOLOGY (cacoa — encode these, don't forget them):
- The replicate is the SAMPLE/DONOR, not the cell. Cell-level p-values overstate population effects.
- For a population-level claim, use pseudobulk across donors, not pooled-cell tests; say so.
- Cluster proportions are COMPOSITIONAL (sum to 1) — a rise in one forces others down; use a compositional test.
- Refuse or caveat a design that can't support a claim (e.g. 1-vs-1). If a result carries such a caveat, state it briefly. When unsure whether a claim is population- vs subpopulation-level, ASK a one-line clarifying question instead of running the wrong test.
- DE and overdispersion are scope-correct: ranked over ALL genes for the cells in question (a selection or subset), never a global gene shortlist — so they surface the genes that distinguish *that* scope.
- "Variable / overdispersed / most-variable GENES" means PER-GENE HVG → compute(stat:overdispersion): omit A for a global score, or pass A for a subpopulation (e.g. variable genes within monocytes). It's computed on the fly — never decline for lack of precompute. get_overdispersion is a DIFFERENT, precomputed gene-PROGRAM (aspect/module) list — only use it when the user explicitly asks for programs/aspects/modules.
- To CONTRAST two groups (naive vs memory B, day0 vs day7), use compute(stat:de) with A and B cell sets — a direct A-vs-B test. NEVER answer a contrast with two separate get_markers (each vs rest): related groups share their lineage genes, so the vs-rest lists look identical; only the direct test shows what differs. For markers of one group, compute(stat:de, A={category…}) (B defaults to rest) or get_markers for the precomputed table.

DATASET (read from the loaded store — do not assume any other dataset): ${brief}. Markers are precomputed for: ${app.ctx.groupings().join(", ") || "—"} — these (and ONLY these) are valid Heatmap groupings; every other categorical (sample/condition/…) is a COVARIATE you facet/scope/pseudobulk by, never a grouping. Unsure which field fits a slot? call describe_data (fields bucketed by role).
EMBEDDINGS available (update_view panels[].embedding): ${app.ctx.embeddingNames().join(", ") || "umap"}.
Your current colour/selection/workspace and the live panel layout (with panel ids for update_view panels[].id) are at the END of the latest user turn — read them there.`;
}

// The VOLATILE per-turn context (current colour/selection/workspace + live panel layout). Deliberately kept OUT of the
// system prompt and appended at the TAIL of the user turn, so the large stable system+tools prefix stays byte-identical
// across asks. That's what lets vLLM's automatic prefix cache (and Anthropic's system cache) REUSE the ~10K-token
// system+tools prefix instead of re-prefilling it every ask — volatile content anywhere before the tools poisons the
// cache for everything after it. It belongs in the conversation anyway: it's append-only turn context, not a standing rule.
function viewState(app: App): string {
  const sel = app.ctx.selectedCells().length;
  // Group panels by their CURRENT rendered column (dataset.col, set by layoutCanvas). Without this the agent can't
  // see the grid — a "make it a 3rd column" request flies blind and a weak model rebuilds/removes instead of adding.
  const byCol = new Map<string, string[]>();
  for (const p of app.canvas) {
    const el = document.querySelector<HTMLElement>(`.panel[data-pid="${p.id}"]`);
    const key = p.full || el?.style.gridColumn === "1 / -1" ? "full-width" : `col ${el?.dataset.col ?? (p.col ?? 0)}`;
    const d = `#${p.id} ${p.type}${p.heatMode === "dot" ? "(dotplot)" : ""}${p.view?.colorBy ? ` colorBy=${p.view.colorBy}` : ""}${p.view?.scope ? ` scope=${(p.view.scope as any).value}` : ""}${p.view?.embedding ? ` emb=${p.view.embedding}` : ""}`;
    if (!byCol.has(key)) byCol.set(key, []);
    byCol.get(key)!.push(d);
  }
  const ncol = [...byCol.keys()].filter((k) => k.startsWith("col ")).length;
  const grid = app.canvas.length ? `${ncol || 1} column${ncol > 1 ? "s" : ""} — ${[...byCol.entries()].map(([k, ps]) => `${k}: ${ps.join(", ")}`).join("; ")}` : "no panels";
  return `[current view] colouring by "${app.coord.state.colorBy}", workspace "${app.currentWS}", ${sel ? sel + " cells selected" : "no selection"}. Panel layout: ${grid}.`;
}

// The most recent source the agent previewed — so save_widget can reuse it without the agent re-emitting the whole
// widget (re-generating ~2K tokens of source is the dominant latency of an authoring run; see the proxy agent log).
let lastWidgetSource = "";
let lastWidgetFrom = "";   // which recipe the current working source was seeded from ("" = custom source / none / committed)

// Resolve the `from`/`source` seeding for preview_widget & edit_widget, GUARDING the transition footgun: passing
// `from:<recipe>` again on a later turn USED TO re-seed from the fresh recipe, silently discarding the edits the agent
// had accumulated (it then saw "the unedited recipe" and thought its edits were lost). Now: re-passing the SAME `from`
// is a no-op (you keep editing the current widget); a DIFFERENT recipe — or a full `source` — replaces the working
// widget; and after a save_widget the slot is "committed" so the next `from` starts fresh. Returns {error?, note?}.
function seedWorkingSource(input: any): { error?: string; note?: string } {
  if (input?.from != null && String(input.from) !== "") {
    const name = String(input.from);
    if (lastWidgetSource && lastWidgetFrom === name) return { note: `continuing the widget already seeded from '${name}' — \`from\` ignored (omit it to keep editing; pass full \`source\` to start over)` };
    const s = recipeSource(name); if (!s) return { error: `no recipe/snippet '${name}'` };
    const replaced = !!lastWidgetSource;
    lastWidgetSource = s; lastWidgetFrom = name;
    return { note: replaced ? `seeded from recipe '${name}' (replaced the prior working source)` : `seeded from recipe '${name}'` };
  }
  if (input?.source != null) { lastWidgetSource = String(input.source); lastWidgetFrom = ""; }
  return {};
}

// ---- tool executors (side effects on the app + a compact result for the model) ----
async function execTool(app: App, name: string, input: any): Promise<string> {
  const ag = app.agent;
  switch (name) {
    case "describe_data": return app.describeData();
    case "describe_panel": {
      const d = app.describePanel(typeof input?.id === "number" ? input.id : undefined);
      const head = `${d.type}${d.id != null ? ` #${d.id}` : d.type === "Embedding" ? " (main embedding)" : ""}`;
      if (d.type === "Widget") {   // a WIDGET — its instance-declared PARAMS (typed value knobs) + CONTROLS (actions)
        const lines: string[] = [];
        for (const pr of (d as any).params || []) { const rng = pr.options ? `: ${(pr.options as any[]).map((o) => typeof o === "object" ? o.value : o).join(" | ")}` : (pr.min != null || pr.max != null) ? `, ${pr.min ?? ""}–${pr.max ?? ""}` : ""; const where = pr.render === "self" ? ", drawn by the widget" : ""; lines.push(`- param ${pr.id} = ${JSON.stringify(pr.value)} (${pr.type}${rng}${where})`); }
        for (const c of d.controls || []) lines.push(`- control ${c.id} ("${c.label}")`);
        return lines.length ? `${head}:\n${lines.join("\n")}\n${d.note}` : `${head}: ${d.note}`;
      }
      const dataBlock = (d as any).dataInputs ? `\nDATA inputs — what it SHOWS (set via update_view({panels:[{id${d.id != null ? ":" + d.id : ""}, …}]})):\n` + Object.entries((d as any).dataInputs).map(([k, v]) => `- ${k}: ${v}`).join("\n") : "";
      if (d.params) {     // a built-in with a style descriptor
        const fmt = (v: any) => Array.isArray(v) ? `[${v.join(",")}]` : JSON.stringify(v);
        const lines = d.params.map((p: any) => `- ${p.key} = ${fmt(p.current)}${p.range ? ` (range ${p.range[0]}–${p.range[1]}, default ${p.default})` : p.current !== p.default ? ` (default ${fmt(p.default)})` : ""}`);
        return `STYLE knobs for ${head} (how it looks) — set via update_view({style:{<family>:{<key>:value}}${d.id != null ? `, stylePanel:${d.id}` : ""}}); pointSize/labelSize are px shortcuts:\n${lines.join("\n")}${dataBlock}`;
      }
      return `${head}: ${d.note || ""}${dataBlock}`;
    }
    case "update_view": {
      const { applied, rejected, notes } = await app.applyViewPatch(input);
      const parts: string[] = [];
      if (applied.length) parts.push(`applied: ${applied.join("; ")}`);
      if (rejected.length) parts.push(`REJECTED (fix and retry): ${rejected.join("; ")}`);
      if (notes.length) parts.push(`notes: ${notes.join("; ")}`);
      return parts.join(" | ") || "no-op — nothing valid to change";
    }
    case "set_gene_filter": {
      const patterns = Array.isArray(input.exclude) ? input.exclude.map(String).map((s: string) => s.trim()).filter(Boolean) : [];
      await app.ctx.setGeneFilter(patterns);
      app.fullRender(); app.scheduleSave();
      return patterns.length
        ? `Gene filter ON — ignoring ${app.ctx.excludedGeneCount()} genes (${patterns.join(", ")}) in every marker / DE / variable-gene ranking (QC scores and gene-set scores are unaffected). Persisted with the session; the user can ask you to change or clear it anytime.`
        : "Gene filter cleared — all genes are used again in rankings.";
    }
    case "get_markers": {
      const grouping = input.grouping && app.ctx.groupings().includes(input.grouping) ? input.grouping : "leiden";
      const markers = await app.ctx.markers(grouping); const rows = (markers.get(input.cluster) || []).slice(0, 20);
      if (!rows.length) return `no group "${input.cluster}" in ${grouping} (have: ${[...markers.keys()].slice(0, 12).join(", ")})`;
      ag.addRail({ type: "DeTable", title: `Markers · ${input.cluster}`, cap: `${grouping} vs rest`, bind: `de:${grouping}:${input.cluster}`, group: input.cluster, rows });
      return `added marker table for ${grouping}=${input.cluster}; top genes: ${rows.slice(0, 8).map((r) => r.symbol).join(", ")}`;
    }
    case "compute": { const { ok, error } = await app.runCompute({ ...input, source: "agent" }); return error ? `error: ${error}` : ok!; }
    case "compute_code": { const { ok, error } = await app.runComputeCode(input); return error ? `error: ${error}` : ok!; }
    case "read_widget_contract": return WIDGET_API_DOC;
    case "list_widget_capabilities": return JSON.stringify(capabilityMenu());
    case "get_widget_template": return getWidgetTemplate(input?.kind);
    case "find_widget_recipe": { const hits = findRecipes(String(input?.query || "")); return hits.length ? JSON.stringify(hits) : "no matches — call list_widget_recipes to see everything"; }
    case "list_widget_recipes": return JSON.stringify(listRecipes());
    case "get_widget_recipe": { const src = getRecipe(String(input?.name || "")); return src || `no recipe/snippet "${input?.name}" — call find_widget_recipe / list_widget_recipes for names`; }
    case "fetch_url": return await fetchUrlText(String(input?.url || ""));
    case "inspect_widget": return await app.inspectWidget(input?.panelId != null ? Number(input.panelId) : undefined);
    case "preview_widget": {
      const seed = seedWorkingSource(input);
      if (seed.error) return JSON.stringify({ ok: false, error: seed.error });
      if (!lastWidgetSource) return JSON.stringify({ ok: false, error: "no source — pass `from` (a recipe) or the full `source` the first time" });
      const sim = await resolveSim(app, input);
      const r = await previewWidget(lastWidgetSource, previewHost(app, sim), 6000, input?.probe ? String(input.probe) : undefined);
      return JSON.stringify({ ok: r.ok, error: r.error, logs: r.logs.slice(-8), manifest: r.manifest, renderedText: (r.text || "").slice(0, 400), emitted: r.emitted && r.emitted.length ? r.emitted : undefined, note: seed.note });
    }
    case "edit_widget": {
      const seed = seedWorkingSource(input);   // `from` seeds a recipe ONCE; a repeat is ignored so edits aren't lost
      if (seed.error) return JSON.stringify({ ok: false, error: seed.error });
      if (!lastWidgetSource) return JSON.stringify({ ok: false, error: "no widget yet — pass `from` (a recipe) or preview_widget the full source first" });
      const res = applyEdits(lastWidgetSource, Array.isArray(input?.edits) ? input.edits : []);
      if (!res.ok) return JSON.stringify({ ok: false, error: "edits did not apply (source unchanged) — make each 'old' match the CURRENT source exactly + uniquely, or preview_widget the full corrected source to resync", failed: res.failed, note: seed.note });
      lastWidgetSource = res.source;
      const sim = await resolveSim(app, input);
      const r = await previewWidget(lastWidgetSource, previewHost(app, sim), 6000, input?.probe ? String(input.probe) : undefined);
      return JSON.stringify({ ok: r.ok, error: r.error, logs: r.logs.slice(-8), manifest: r.manifest, renderedText: (r.text || "").slice(0, 400), emitted: r.emitted && r.emitted.length ? r.emitted : undefined, applied: res.applied, note: seed.note });
    }
    case "save_widget": { const src = String(input?.source || lastWidgetSource); if (!src.trim()) return "save_widget: no source — preview_widget first, then save (omit source to reuse it)"; const { id, updated, unchanged } = app.addWidgetPanel(src, input?.title); lastWidgetFrom = ""; if (updated && unchanged) return `⚠ widget panel #${id} UNCHANGED — the saved source is byte-identical to what's already on the panel, so nothing re-rendered. Your last edit_widget almost certainly did NOT apply (an old_str didn't match the current source). Re-preview the corrected FULL source (preview_widget with \`source\`), confirm ok:true, then save again — don't tell the user it's revised until it actually changed.`; return updated ? `updated widget panel #${id} in place (same title) — no duplicate added` : `mounted widget panel #${id} on the workbench (a NEW widget starts fresh — pass full \`source\` or \`from:\` a recipe; the previous source is no longer "current")`; }
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
    case "manage_category": { const { ok, error } = app.manageCategory({ ...input, source: "agent" }); return error ? `error: ${error}` : ok!; }
    case "lookup_ontology": {
      const term = String(input?.term || "").trim(); if (!term) return "lookup_ontology: 'term' is required";
      const hits = await olsLookup(term);
      if (!hits.length) return `no Cell Ontology hits for "${term}" — try a more canonical name (e.g. 'natural killer cell'), or fill the id from knowledge if confident.`;
      return `Cell Ontology hits for "${term}":\n` + hits.map((h) => `- ${h.id} — ${h.label}${h.description ? ` (${h.description.slice(0, 80)})` : ""}`).join("\n") + `\nUse the best-matching id in propose_label/propose_labels (ontologyTermId + ontologyTerm).`;
    }
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

// Resolve the agent-friendly `select`/`hint`/`colorBy` preview args into a PreviewSim (cells pre-resolved so the
// preview host stays synchronous). This is what lets the agent TEST a coordination widget — preview it AS IF a
// selection/hover were active — instead of shipping reactive code it never saw run. Accepts category ({grouping/field,
// value} or {category:{…}}), explicit {cells:[…]} or a raw array, or null (simulate "nothing selected").
async function resolveSim(app: App, input: any): Promise<PreviewSim | undefined> {
  if (!input) return undefined;
  const sim: PreviewSim = {}; let any = false;
  if ("select" in input) {
    any = true; const sel = input.select;
    if (sel == null || sel === false) { sim.selection = null; sim.selCells = []; }
    else if (Array.isArray(sel)) { sim.selCells = sel.map(Number); sim.selection = { kind: "cells", count: sel.length }; }
    else if (Array.isArray(sel.cells)) { sim.selCells = sel.cells.map(Number); sim.selection = { kind: "cells", count: sel.cells.length }; }
    else {
      const grouping = sel.grouping || sel.field || (sel.category && sel.category.grouping);
      const value = sel.value != null ? sel.value : (sel.category && sel.category.value);
      if (grouping != null && value != null) { try { await app.ctx.metaOf(String(grouping)); } catch { /* unknown field → empty */ } const cells = Array.from(app.ctx.cellsOfCategory(String(grouping), String(value))); sim.selCells = cells; sim.selection = { kind: "category", grouping: String(grouping), value: String(value), count: cells.length }; }
    }
  }
  if ("hint" in input) {
    any = true; const hn = input.hint;
    if (hn == null || hn === false) sim.hint = null;
    else if (Array.isArray(hn.cells)) sim.hint = { kind: "cells", ids: hn.cells.map(Number) };
    else { const grouping = hn.grouping || hn.field || (hn.category && hn.category.grouping); const value = hn.value != null ? hn.value : (hn.category && hn.category.value); if (grouping != null && value != null) sim.hint = { kind: "category", grouping: String(grouping), value: String(value) }; }
  }
  if (input.colorBy) { any = true; sim.colorBy = String(input.colorBy); }
  return any ? sim : undefined;
}

// Fetch a web page's text via the proxy (server-side → no CORS). The proxy applies SSRF guards + strips HTML +
// truncates; here we just validate the scheme and relay. For LEARNING a technique only — widgets stay self-contained.
async function fetchUrlText(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "fetch_url: provide an http(s):// URL";
  try {
    const r = await fetch("/api/web/fetch?url=" + encodeURIComponent(url));
    const t = await r.text();
    return r.ok ? t : "fetch_url error (" + r.status + "): " + t.slice(0, 200);
  } catch (e) { return "fetch_url failed: " + String((e as any)?.message || e); }
}

// ---- the streaming tool-use loop ----
export async function runLive(app: App, userText: string, abort: AbortSignal): Promise<void> {
  const ag = app.agent;
  // Persist ONE running conversation across asks so follow-ups keep context — e.g. the agent asks "A or B?" and
  // the user's next message "B" is understood as the answer, not a fresh request. The loop below appends the
  // assistant + tool-result turns to this same array, so it accumulates the whole dialogue.
  if (!app.liveMessages) app.liveMessages = [];
  app.liveMessages.push({ role: "user", content: `${userText}\n\n${viewState(app)}` });   // volatile state at the TAIL → stable system+tools prefix caches
  trimLiveMessages(app.liveMessages);
  const messages = app.liveMessages;
  app.thread = { kind: "live", live: true, entries: [{ role: "user", text: userText }] };
  ag.renderThread(); app.setPip("working", "thinking");
  const sys = await systemPrompt(app);
  const provider = getProvider(); const adapter = adapterFor(provider); const model = providerModel(provider);

  let emptyRetries = 0; const loop = newLoopState();
  for (let turn = 0; turn < 12; turn++) {   // headroom for multi-step flows like widget authoring (template → preview → fix → save)
    if (abort.aborted) break;
    const res = await agentStream(adapter.buildBody({ system: sys, messages, tools: TOOLS, maxTokens: 8192 }), { provider, model, store: app.currentStore() }, abort);
    // A pasted credential that's expired/invalid comes back 401/403. Detect it gracefully mid-run: flag it (so the
    // connection UI shows "expired"), tell the user plainly, and stop this turn — don't fall through to the generic
    // "unreachable" path (which throws + drops to the offline fallback).
    if ((res.status === 401 || res.status === 403) && loadCred()) {
      markCredExpired();
      app.thread.entries.push({ role: "agent", text: "Your Anthropic token was rejected — most likely the OAuth token expired. Open ⚙ connection and paste a fresh token, then resend." });
      ag.renderThread(); app.setPip("idle"); (app as any).onCredExpired?.(); return;
    }
    // TRANSIENT, retryable API errors (rate-limited / overloaded): say so plainly and STOP this turn — do NOT degrade to
    // the offline mock planner. The mock only handles a handful of scripted patterns, so on a real request it silently
    // does the wrong thing (a fabricated dot-plot, or nothing) AND the failed live turn drops the user message → the chat
    // "ghosts". Settle the exchange so the question + this note stay visible; the user just resends when the limit clears.
    if (res.status === 429 || res.status === 503 || res.status === 529) {
      const msg = res.status === 429
        ? "I'm being rate-limited by the model API right now — too many requests in a short window. Wait a few seconds and resend; your message wasn't lost."
        : "The model API is overloaded at the moment. Wait a few seconds and resend.";
      app.thread.entries.push({ role: "agent", text: msg }); ag.renderThread(); app.setPip("idle");
      ag.settleThread("model rate-limited — resend", msg); return;
    }
    if (!res.ok || !res.body) { app.thread.entries.push({ role: "agent", text: "(agent unreachable — using local fallback)" }); ag.renderThread(); throw new Error("live unreachable"); }
    const assistant: any[] = []; let curText = ""; let curTool: any = null; let curJson = ""; let textEntry: any = null; let stop = "";
    const pstate = adapter.newState();
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let ev: any; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        // provider adapter normalizes the SSE (Anthropic content_block_* OR OpenAI chat.completion.chunk) into the
        // same op stream; the fold below is provider-agnostic and builds the canonical assistant blocks + UI.
        for (const o of adapter.parseEvent(ev, pstate)) {
          if (o.op === "toolStart") { curTool = { type: "tool_use", id: o.id, name: o.name, input: {} }; curJson = ""; }
          else if (o.op === "textStart") { curText = ""; textEntry = { role: "agent", text: "" }; app.thread.entries.push(textEntry); }
          else if (o.op === "text") { curText += o.text; if (textEntry) { textEntry.text = curText; ag.renderThread(); } }
          else if (o.op === "toolArgs") { curJson += o.json; }
          else if (o.op === "blockStop") { if (curTool) { try { curTool.input = curJson ? JSON.parse(curJson) : {}; } catch { curTool.input = {}; } assistant.push(curTool); app.thread.entries.push({ tool: curTool.name, label: toolLabel(curTool), status: "active" }); ag.renderThread(); curTool = null; } else if (textEntry) { assistant.push({ type: "text", text: curText }); textEntry = null; } }
          else if (o.op === "stop") { stop = o.reason; }
        }
      }
    }
    // A 200 with no content (no tool_use, no text) is a transient API hiccup — retry the turn rather than silently
    // ending mid-task (which abandons an in-progress action and looks like a clean finish).
    if (!assistant.length && !(curText || "").trim()) { if (emptyRetries++ < 2) { turn--; continue; } break; }
    emptyRetries = 0;
    messages.push({ role: "assistant", content: assistant.length ? assistant : [{ type: "text", text: curText || "" }] });
    const toolUses = assistant.filter((b) => b.type === "tool_use");
    if (!toolUses.length || stop !== "tool_use") break;
    // LOOP-BREAKER: a weak model can get stuck re-issuing the EXACT same call after a "nothing to change"/rejection
    // and spin out the whole turn budget (seen with qwen3: 11× the identical update_view). We bail on the 3rd
    // identical call ONLY when it keeps making no progress — judged AFTER running the tools (see `progressed`), so a
    // byte-identical call that keeps APPLYING (e.g. triggering a widget control N times) is never mistaken for a spin.
    const sig = toolUses.map((t) => t.name + ":" + JSON.stringify(t.input)).join("|");
    // execute tools, append results
    const results: any[] = [];
    for (const tu of toolUses) {
      app.setPip("working", tu.name);
      // mirror data-fetch progress onto the ACTIVE step so a compute tool isn't a silent wait ("DE (compute) · fetching 60%").
      const active = [...app.thread.entries].reverse().find((e: any) => e.tool === tu.name && e.status === "active");
      const fview: any = (app as any).ctx?.view; let offFetch = () => {}, lastPaint = 0;
      if (active && typeof fview?.onFetchProgress === "function") {
        offFetch = fview.onFetchProgress((done: number, total: number) => {
          if (done >= total) return;
          active.detail = `fetching ${total ? Math.round(done / total * 100) : 0}%`;
          const t = Date.now(); if (t - lastPaint > 120) { lastPaint = t; ag.renderThread(); }
        });
      }
      let out = ""; try { out = await execTool(app, tu.name, tu.input); } catch (e) { out = "error: " + e; } finally { offFetch(); }
      // mark the step done — the MODEL gets the full `out` (pushed to results below); the CHAT gets a short summary
      // (displayDetail), so big payloads (the widget contract, recipe/template SOURCE, preview JSON) don't dump raw
      // code into the thread and reflow it ("long stretches of code, then jumps").
      const step = [...app.thread.entries].reverse().find((e: any) => e.tool === tu.name && e.status === "active"); if (step) { step.status = "done"; step.detail = displayDetail(tu.name, out); }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      ag.renderThread();
    }
    messages.push({ role: "user", content: results });
    // a result is a BOUNCE (no progress) if it's empty, an error, or a rejection with nothing applied. A turn that
    // applied/changed anything resets the guard — so legitimate repeats (trigger a control N times) don't trip it.
    const isBounce = (c: string) => { c = c.trim(); return !c || /^error\b/i.test(c) || (/REJECTED|no change|nothing to (change|do)/i.test(c) && !/applied:/i.test(c)); };
    const progressed = results.some((r) => !isBounce(String(r.content || "")));
    if (isStuck(sig, loop, progressed)) { const t = "(Stopped — I kept repeating an action that isn't changing anything. Try rephrasing, or ask for a different change.)"; app.thread.entries.push({ role: "agent", text: t }); messages.push({ role: "assistant", content: [{ type: "text", text: t }] }); ag.renderThread(); break; }   // close on an assistant turn so the next ask's user message alternates cleanly
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

// What to SHOW in the chat for a completed tool step. The model still gets the full `out` as the tool_result; the UI
// gets a short, plain-text summary — otherwise large payloads (the widget contract, recipe/template SOURCE, preview
// JSON) dump raw code into the thread and reflow the layout. Kept tiny; never includes source.
function displayDetail(name: string, out: string): string {
  const sz = (s: string) => (s.length >= 1024 ? (s.length / 1024).toFixed(1) + " KB" : s.length + " chars");
  if (name === "read_widget_contract") return "contract loaded · " + sz(out);
  if (name === "get_widget_template") return "template loaded · " + sz(out);
  if (name === "get_widget_recipe") return out.startsWith("no ") ? out.slice(0, 120) : "recipe source · " + sz(out);
  if (name === "find_widget_recipe" || name === "list_widget_recipes") {
    try { const a = JSON.parse(out); if (Array.isArray(a)) return a.length + " match(es): " + a.map((h: any) => h?.name || h).filter(Boolean).slice(0, 6).join(", "); } catch { /* fall through */ }
    return out.slice(0, 120);
  }
  if (name === "preview_widget" || name === "edit_widget") {
    try { const r = JSON.parse(out); if (r && typeof r === "object") {
      if (r.ok === false) return "preview FAILED · " + String(r.error || (r.failed ? "edits did not apply" : "error")).slice(0, 140);
      const bits = ["preview ok"]; const nApplied = Array.isArray(r.applied) ? r.applied.length : r.applied; if (nApplied) bits.push(nApplied + " edit(s)"); if (Array.isArray(r.logs) && r.logs.length) bits.push(r.logs.length + " log(s)"); if (Array.isArray(r.emitted) && r.emitted.length) bits.push("emitted " + r.emitted.join(", ").slice(0, 80)); return bits.join(" · ");
    } } catch { /* fall through */ }
    return out.slice(0, 120);
  }
  if (name === "fetch_url") return "fetched · " + sz(out);
  // most tools already return a short human string — just clamp it.
  return out.length > 200 ? out.slice(0, 197) + "…" : out;
}

function toolLabel(tu: any): string {
  const i = tu.input || {};
  if (tu.name === "describe_data") return "describe data fields";
  if (tu.name === "describe_panel") return `describe panel${i.id != null ? " #" + i.id : ""}`;
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
  if (tu.name === "manage_category") return `category · ${i.op}${i.name ? " " + i.name : ""}`;
  if (tu.name === "lookup_ontology") return `ontology · ${i.term}`;
  if (tu.name === "propose_label") return `suggest · ${i.name || i.label}`;
  if (tu.name === "propose_labels") return `suggest · ${(i.proposals || []).length} labels`;
  if (tu.name === "read_widget_contract") return "widget contract";
  if (tu.name === "get_widget_template") return "widget template";
  if (tu.name === "find_widget_recipe") return `find recipe · ${i.query || ""}`;
  if (tu.name === "list_widget_recipes") return "widget recipes";
  if (tu.name === "get_widget_recipe") return `recipe · ${i.name || ""}`;
  if (tu.name === "fetch_url") return "fetch web";
  if (tu.name === "preview_widget") return "preview widget";
  if (tu.name === "edit_widget") return `edit widget · ${(i.edits || []).length} edit(s)`;
  if (tu.name === "save_widget") return `widget · ${i.title || "custom"}`;
  if (tu.name === "inspect_widget") return "inspect widget";
  if (tu.name === "get_reconciliation") return "reconciliation";
  if (tu.name === "concordance_panel") return `concordance · ${i.scopeValue}`;
  if (tu.name === "propose_workspace") return `propose workspace · ${i.name}`;
  return tu.name.replace(/_/g, " ");
}
