import { mk, S } from "./dom.ts";
import { Ctx } from "../data/ctx.ts";
import { EmbeddingView } from "../render/embedding.ts";
import { colorsFor, focusMaskFor, categoryColorOf } from "../render/colors.ts";
import { themeIsDark } from "../render/theme.ts";
import { getStyle, resolveStyle } from "../render/style.ts";
import { registerPanelType, getPanelType } from "./panel-registry.ts";
import { EmbeddingStyle } from "../render/embedding.style.ts";
import "./heatmap.style.ts";   // side-effect: the Heatmap panel's style descriptor self-registers
import "./facets.style.ts";    // side-effect: the MetadataFacets panel's style descriptor self-registers
import "./composition.style.ts";   // side-effect: the CompositionBars panel's style descriptor self-registers
import "./volcano.style.ts";    // side-effect: the Volcano panel's style descriptor self-registers
import "./box.style.ts";        // side-effect: the BoxBySample panel's style descriptor self-registers
import { catColor } from "../data/view.ts";
import type { EntityRef } from "../data/coord.ts";
import { reconcile, crosstab, ReconRow, AnnotationLayer, CapRecord, labelChain } from "../anno/model.ts";
import { olsLookup } from "../anno/ols.ts";
import { mountWidget, WidgetHost, WidgetHandle } from "../widget/runtime.ts";

// Per-panel view spec — the agent's deep-control surface (configure_panel). Each property overrides the
// GLOBAL coord default for THIS panel only; the shared bus (selection/hint) stays global. See docs/deep-view-control.md.
export interface PanelView {
  colorBy?: string;     // override the panel's colouring handle (else falls back to coord.colorBy)
  scope?: EntityRef;    // restrict the panel to a cell set — the embedding reframes to it + desaturates the rest
  embedding?: string;   // which embedding this panel renders (e.g. "umap" vs "umap.unintegrated"); else the default
  colormap?: string;    // palette for NUMERIC colourings (gene/qc/score): amber (default), viridis, rdbu, bluered, …
  display?: { labels?: boolean; legend?: boolean; alpha?: number; winsor?: number };   // per-PANEL display overrides (independent of other panels)
  style?: Record<string, any>;   // per-PANEL style overrides (point/label/selection/… — see render/style.ts); wins over coord.style; the open generalization of `display`
}

export interface Panel {
  id: number; type: string; title: string; cap?: string; full?: boolean; col?: number;   // col pins a panel to a workbench column (0-based; else row-major)
  bind?: string; text?: string; q?: string; group?: string; gene?: string;
  aLabel?: string; bLabel?: string;   // DE mean-column headers (the two groups being contrasted)
  heatMode?: "heat" | "dot";          // Heatmap panel: colour grid vs dotplot (size = % expressing)
  genes?: string[];                   // Heatmap: extra genes pinned in beyond the precomputed markers (highlighted)
  view?: PanelView;
  split?: { levels: string[]; genes: string[]; means: number[][] };   // gene × donor concordance matrix (SplitHeat)
  rows?: { gene?: number; symbol: string; lfc?: number; padj?: number; score?: number; meanA?: number; meanB?: number }[];
  source?: string;                    // Widget panel: the author-written widget source (runs in a sandboxed iframe)
  controls?: { id: string; label: string }[];   // Widget panel: header controls the widget declared (folded into ⋯)
  params?: { id: string; label: string; type: string; value: any; min?: number; max?: number; step?: number; options?: string[] }[];   // Widget panel: typed value knobs (header inputs + describe_panel)
  version?: string;                                                          // Widget panel: declared module version (for sharing/import)
  description?: string;                                                      // Widget panel: declared description (shown at the consent gate)
  permissions?: { external?: string[]; compute?: boolean };                  // Widget panel: declared capabilities (shown at the consent gate for informed trust)
}

export interface PanelHooks {
  onGeneClick: (symbol: string) => void;
  onSelect: (ids: Int32Array, anchor: { left: number; top: number }) => void;
  registerEmbedding: (ev: EmbeddingView) => void;
  onCellHover: (index: number | null) => void;                 // embedding → cross-panel hint (hover tier)
  onCellClick: (index: number | null, anchor?: { left: number; top: number }) => void;   // embedding click → select cluster (+ selpop), or deselect (empty)
  registerComposition: (r: CompReactor) => void;               // a panel that reacts to selection + hint
  onCoord: (fn: (s: any, changed: string[]) => void) => void;  // managed coord subscription (colorBy/selection/focus reactivity); cleaned up on fullRender
  focusCategory: (field: string, value: string) => void;       // restrict the workspace to a metadata value (focus + chip)
  addPanel: (spec: any) => void;                               // add a panel to the workbench (e.g. → composition hand-off)
  openSelectionMenu: (anchor: { left: number; top: number; right?: number }) => void;   // open the selection ops menu (DE/label/ask); `right` right-aligns it to a right-side trigger
  onConfigurePanel: (panelId: number, patch: any) => void;     // a panel reconfiguring itself (e.g. dismissing pinned genes)
  registerGeneHover: (fn: (sym: string | null) => void) => void;   // a panel that highlights a gene's row on cross-panel geneHint
  // APP-DOMAIN capability namespace: the annotation WORKFLOW. Grouped (not flat) so the generic panel-module surface
  // above isn't polluted by a specific domain — only annotation panels (Reconcile/AnnoRecord) reach into here, and an
  // external module would have to DECLARE the "annotation" capability to get it (P4).
  annotation: {
    annotate: (cellIds: ArrayLike<number>, label: string, layer?: string) => void;   // write a label onto a cell set in an annotation layer (default the working draft)
    annoLayer: (name: string) => AnnotationLayer | undefined;   // the rich annotation layer (with CAP records)
    saveRecord: (layerName: string, record: CapRecord) => void; // persist a per-label CAP record
    adoptSource: (name: string) => void;                        // set the working draft to a source's per-cluster labeling
    renameLabel: (layerName: string, from: string, to: string) => void;   // rename a working label (to an existing one = merge)
    proposeRecord: (layerName: string, label: string) => void;  // ask the agent to suggest a CAP record for one label
    proposeAllNames: (layerName: string) => void;               // ask the agent to name+explain all working clusters
    splitLabel: (label: string) => void;                        // isolate a working label's cells to split it (brush a subset)
  };
  widgetHost: () => WidgetHost;                                // the coord/ctx/theme bridge a Widget panel's iframe talks to
  onTeardown: (fn: () => void) => void;                        // register cleanup (e.g. destroy a widget iframe) run on the next fullRender
  registerWidget: (panelId: number, handle: WidgetHandle) => void;   // expose a mounted widget so inspect_widget can read its live state
  widgetNeedsConsent?: (p: Panel) => boolean;                  // Item 2/C: true if this widget is untrusted (imported) → don't auto-run its code
  widgetIsImported?: (p: Panel) => boolean;                    // P4: true if this widget arrived via an imported session → BIND its declared permissions (foreign code held to stated terms); authored widgets aren't bound
  renderWidgetGate?: (p: Panel, wrap: HTMLElement) => void;    // render the consent placeholder instead of mounting
}

// A vocabulary-bound panel that reacts to the two tiers, distinctly: `setSelect` is the committed selection
// (strong), `setHover` the ephemeral hint (light). `grouping` is the categorical it stacks/keys on; each set
// holds the category values to lift (translated in via cells when vocabularies differ). null = clear that tier.
export interface CompReactor { grouping: string; setSelect: (values: Set<string> | null) => void; setHover: (values: Set<string> | null) => void; }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export interface BuiltBody { el: HTMLElement; afterAttach?: () => void; headerControls?: HTMLElement; widget?: WidgetHandle; }   // headerControls: a control the body puts in the panel header (e.g. a gene filter). widget: a mounted widget iframe (panelEl wires its folding toolbar controls).

export async function bodyFor(p: Panel, ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  const def = getPanelType(p.type);   // registry lookup — built-ins register at the bottom of this file; external modules register themselves
  return def ? def.body(p, ctx, hooks) : { el: mk("div", undefined, p.type) };   // unknown type → a labelled placeholder (no throw)
}

// A Widget panel hosts an author-written widget in a sandboxed iframe, bridged to coord/ctx/theme via the WidgetHost.
// Mount is DEFERRED to afterAttach (like the coord/reactor registrations) so a superseded fullRender build never
// leaves an orphan iframe + host subscription. panelEl reads built.widget to wire the folding toolbar controls.
function widgetBody(p: Panel, ctx: Ctx, hooks: PanelHooks): BuiltBody {
  const wrap = mk("div"); wrap.style.cssText = "position:absolute;inset:0;overflow:auto;background:transparent";
  const built: BuiltBody = { el: wrap };
  built.afterAttach = () => {
    // Item 2/C: an untrusted (imported) widget is GATED — show the consent placeholder instead of executing its code.
    if (hooks.widgetNeedsConsent?.(p) && hooks.renderWidgetGate) { hooks.renderWidgetGate(p, wrap); return; }
    const handle = mountWidget(wrap, p.source || "pagoda.ready({title:'(empty widget)'});", hooks.widgetHost(), undefined, hooks.widgetIsImported?.(p) ?? false);   // bind declared permissions only for imported (gate-trusted) widgets, never authored ones
    handle.iframe.style.height = "100%";
    hooks.onTeardown(() => handle.destroy());   // torn down (iframe + host subscription) on the next fullRender
    hooks.registerWidget(p.id, handle);         // discoverable by inspect_widget
    built.widget = handle;
  };
  return built;
}

function embeddingBody(p: Panel, ctx: Ctx, hooks: PanelHooks): BuiltBody {
  const host = mk("div", "embhost");
  const legend = mk("div", "emblegend");
  const wrap = mk("div"); wrap.style.cssText = "position:absolute;inset:0"; wrap.appendChild(host); wrap.appendChild(legend);
  const afterAttach = () => {
    const emb = ctx.embeddingOf(p.view?.embedding);          // the panel's chosen embedding (else the default)
    const ev = new EmbeddingView(host, emb.data, emb.n);
    ev.onSelect = (ids) => { const r = host.getBoundingClientRect(); hooks.onSelect(ids, { left: r.left + r.width * 0.55, top: r.top + 40 }); };
    ev.onHover = (idx) => hooks.onCellHover(idx);
    ev.onPick = (idx, x, y) => { const r = host.getBoundingClientRect(); hooks.onCellClick(idx, x != null && y != null ? { left: r.left + x, top: r.top + y } : undefined); };
    (ev as any)._legend = legend;
    (ev as any)._panel = p;            // carry the panel so paintEmbedding can read its per-panel view spec
    hooks.registerEmbedding(ev);
  };
  return { el: wrap, afterAttach };
}

// Resolve the effective style for a panel — GENERIC over the panel's registered descriptor (no panel named here):
// descriptor defaults ← global display(alias) ← coord.style[type] ← panel display(alias) ← panel style. The descriptor
// owns the display→style aliasing (`fromDisplay`). Shared by the renderer AND describe_panel (one source of truth).
export function resolvePanelStyleFor(ctx: Ctx, panelType: string, view?: PanelView): any {
  const d = getStyle(panelType); if (!d) return null;
  const c = ctx.coord.state as any;
  return resolveStyle(d, themeIsDark(), d.fromDisplay?.(c.display || {}), c.style?.[panelType], d.fromDisplay?.((view as any)?.display || {}), (view as any)?.style);
}

export async function paintEmbedding(ev: EmbeddingView, ctx: Ctx) {
  const c = ctx.coord.state;
  const view = (ev as any)._panel?.view as PanelView | undefined;
  const colorBy = view?.colorBy ?? c.colorBy;            // per-panel override (configure_panel) → else the global default
  // scope frames THIS panel on a cell set: reframe the viewport to it (once, on change — never fight the user's pan),
  // and desaturate everything outside. A scoped panel is the evidence-board building block (e.g. "zoom to CD8-T").
  const scopeCells = view?.scope ? ctx.refToCells(view.scope) : null;
  const scopeKey = view?.scope ? (view.scope.kind === "category" ? `c:${view.scope.grouping}=${view.scope.value}` : `n:${scopeCells!.length}`) : "";
  if ((ev as any)._scopeKey !== scopeKey) { (ev as any)._scopeKey = scopeKey; ev.fitTo(scopeCells && scopeCells.length ? scopeCells : undefined); }

  // dim mask = "restrict my view": only SCOPE (frames this panel) and FOCUS (the ⊙ act, with a notice+clear pill)
  // grey the map. A plain SELECTION must NOT — it's a transient highlight, not a restriction; greying it out reads
  // as a subset (the user can't tell it from a focus, yet there's no pill). The selection instead LIFTS its cells in
  // place (ev.setSelection → an accent overlay/halo in embedding.ts), leaving the rest of the map fully intact.
  const selCells = ctx.refToCells(c.selection);   // this panel is cell-space — read the selection as cells (for the lift)
  let mask: Uint8Array | undefined;
  if (scopeCells && scopeCells.length) { mask = new Uint8Array(ctx.n); for (let j = 0; j < scopeCells.length; j++) mask[scopeCells[j]] = 1; }
  else mask = focusMaskFor(c.focus, ctx.n);
  // display is PER-PANEL: a panel's own overrides win over the coord default, so panels are independent
  // (toggle labels on one embedding without touching another). coord.display is just the starting default.
  // STYLE resolved through the SHARED generic helper (so describe_panel reads the same surface the renderer paints from).
  const style = resolvePanelStyleFor(ctx, "Embedding", view) as EmbeddingStyle;
  const { rgba, legend } = await colorsFor(ctx.view, colorBy, mask, view?.colormap, style.color.winsor ?? 0);   // winsor clips outliers off the numeric scale
  ev.setStyle(style);
  ev.setColors(rgba);
  ev.setSelection(selCells.length ? selCells : null);
  const isCat = legend.kind === "categorical";
  ev.setLabels(style.label.show && isCat ? await categoryLabels(ctx, colorBy, ctx.embeddingOf(view?.embedding).data) : []);
  const showLegend = style.legend.show ?? !isCat;   // auto: key for numeric colourings; hidden when on-plot labels carry identity
  const lg = (ev as any)._legend as HTMLElement | undefined;
  if (lg) lg.innerHTML = showLegend
    ? `<span class="lt">${legend.title}</span>` + (legend.unvalidated ? `<span class="lbadge" title="custom agent code — unvalidated; sanity-check before trusting">~ custom</span>` : "") + legend.items.map((it) => `<span><span class="sw" style="background:rgb(${it.rgb.join(",")})"></span>${it.label}</span>`).join("")
    : "";
}

// On-plot label per category, for categorical colourings only (returns [] for gene/qc so the
// embedding clears its labels). Placement is the marginal MEDIAN (x,y) — robust to stray cells and
// multi-lobe clusters where a mean drifts into empty space. priority = cluster size, normalised to
// the [0,1000] the collision filter expects, so when two labels clash the larger cluster keeps its name.
async function categoryLabels(ctx: Ctx, colorBy: string, emb: Float32Array = ctx.embedding.data): Promise<{ text: string; p: [number, number]; priority: number }[]> {
  if (!colorBy.startsWith("meta:")) return [];
  const md = await ctx.metaOf(colorBy.slice(5)) as any;
  if (md.kind !== "categorical") return [];
  const K = md.categories.length, n = ctx.n;
  const xs: number[][] = Array.from({ length: K }, () => []), ys: number[][] = Array.from({ length: K }, () => []);
  for (let i = 0; i < n; i++) { const k = md.codes[i]; if (k < 0) continue; xs[k].push(emb[i * 2]); ys[k].push(emb[i * 2 + 1]); }
  const median = (a: number[]) => { a.sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  let maxC = 1; for (let k = 0; k < K; k++) if (xs[k].length > maxC) maxC = xs[k].length;
  const out: { text: string; p: [number, number]; priority: number }[] = [];
  for (let k = 0; k < K; k++) if (xs[k].length) out.push({ text: md.categories[k], p: [median(xs[k]), median(ys[k])], priority: (xs[k].length / maxC) * 1000 });
  return out;
}

// A filterable, sortable gene table — shared by DE tables and ranked gene lists. The search box filters by
// symbol; a header click sorts by that column (toggling asc/desc); a row click colours the embedding by that
// gene. No sort initially, so the upstream ranking is preserved until the user asks for another order.
type GCol = { key: string; label: string; num?: boolean; get: (r: any) => any; fmt?: (v: any, r: any) => string; cls?: (v: any) => string };
const GTABLE_CAP = 200;   // max ROWS rendered at once — the table holds the FULL ranked list (all tested genes) for
                          // search, but only renders the top slice / matches so the DOM stays light on big gene sets.
function geneTable(initial: any[], cols: GCol[], onPick: (symbol: string) => void): BuiltBody & { setRows: (r: any[]) => void } {
  let rows = initial;   // mutable so a reactive panel (Variable genes) can swap the list in place, keeping the search box + its text
  const wrap = mk("div", "gtable");
  const search = Object.assign(document.createElement("input"), { className: "gsearch", placeholder: "filter genes…" }) as HTMLInputElement;
  const scroll = mk("div", "gscroll"), table = document.createElement("table");
  const thead = document.createElement("thead"), tb = document.createElement("tbody");
  table.appendChild(thead); table.appendChild(tb); scroll.appendChild(table);
  const more = mk("div", "gmore");   // "showing N of M — filter to find any gene"
  wrap.appendChild(scroll); wrap.appendChild(more);   // the search box lives in the panel header (returned as headerControls)
  let sortKey: string | null = null, dir = 1;
  const render = () => {
    thead.innerHTML = `<tr>${cols.map((c) => `<th data-k="${c.key}" class="sortable${sortKey === c.key ? " sorted" : ""}">${esc(c.label)}${sortKey === c.key ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr>`;
    thead.querySelectorAll<HTMLElement>("th").forEach((th) => th.onclick = () => { const k = th.dataset.k!; if (sortKey === k) dir = -dir; else { sortKey = k; dir = cols.find((c) => c.key === k)?.num ? -1 : 1; } render(); });
    const q = search.value.trim().toLowerCase();
    let rs = q ? rows.filter((r) => String(r.symbol).toLowerCase().includes(q)) : rows.slice();
    if (sortKey) { const c = cols.find((x) => x.key === sortKey)!; rs.sort((a, b) => { const av = c.get(a), bv = c.get(b); return (av < bv ? -1 : av > bv ? 1 : 0) * dir; }); }
    const shown = rs.slice(0, GTABLE_CAP);   // cap the DOM; the full list stays searchable via `rows`
    tb.innerHTML = shown.map((r) => `<tr class="gene">${cols.map((c) => { const v = c.get(r); return `<td class="${c.cls ? c.cls(v) : ""}">${c.fmt ? c.fmt(v, r) : esc(String(v))}</td>`; }).join("")}</tr>`).join("");
    [...tb.children].forEach((tr, i) => (tr as HTMLElement).onclick = () => { [...tb.children].forEach((x) => x.classList.remove("on")); tr.classList.add("on"); onPick(shown[i].symbol); });
    more.textContent = rs.length > GTABLE_CAP ? `showing top ${GTABLE_CAP} of ${rs.length.toLocaleString()}${q ? " matches" : ` genes`} — ${q ? "refine the filter" : "filter to find any gene"}`
      : q ? `${rs.length.toLocaleString()} match${rs.length === 1 ? "" : "es"}` : (rows.length ? `${rows.length.toLocaleString()} genes` : "");
  };
  search.oninput = render; render();
  return { el: wrap, headerControls: search, setRows: (r: any[]) => { rows = r; render(); } };
}

// Reactive "Variable genes" panel: top OVERDISPERSED genes for the current selection (or all cells), recomputed
// kernel-side (ctx.view.overdispersedGenes — the same path the `compute` tool uses) whenever the selection changes.
// Reuses geneTable, so it has the full gene list + the header search/render-cap; updates rows in place (setRows).
function variableGenesBody(p: Panel, ctx: Ctx, hooks: PanelHooks): BuiltBody {
  const gt = geneTable([], [
    { key: "symbol", label: "gene", get: (r: any) => r.symbol },
    { key: "score", label: "overdispersion", num: true, get: (r: any) => r.score ?? 0, fmt: (v: number) => v.toFixed(2), cls: () => "up" },
  ], hooks.onGeneClick);
  const w = mk("div"); w.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden";
  const scope = mk("div", "vgscope"); w.appendChild(scope); w.appendChild(gt.el);
  let busy = false, again = false;
  const recompute = async () => {
    if (busy) { again = true; return; } busy = true;
    try {
      const sc = p.view?.scope ? ctx.refToCells(p.view.scope) : null;   // a pinned panel scope wins; else the live selection; else all cells
      const sel = ctx.coord.state.selection;
      let ids: number[], label: string;
      if (sc && sc.length) { ids = Array.from(sc); label = (p.view!.scope as any).value || "scope"; }
      else if (sel) { ids = Array.from(ctx.refToCells(sel)); label = sel.kind === "category" ? (sel as any).value : "selection"; }
      else { ids = Array.from({ length: ctx.n }, (_, i) => i); label = "all cells"; }
      scope.textContent = `${label} · ${ids.length.toLocaleString()} cells · top overdispersed genes`;
      const hv = await ctx.view.overdispersedGenes(ids, 1e9);
      gt.setRows(hv.map((h: any) => ({ symbol: h.symbol, score: h.resid })));
      if (!hv.length) scope.textContent = `${label} — no overdispersion (this store has no cell-major counts panel)`;
    } finally { busy = false; if (again) { again = false; recompute(); } }
  };
  recompute();
  return { el: w, headerControls: gt.headerControls, afterAttach: () => {
    const pb = w.parentElement as HTMLElement | null; if (pb) { pb.style.position = "relative"; if (pb.clientHeight < 80) pb.style.height = "320px"; }   // anchor the absolute body to THIS panel (mirrors facetsBody)
    hooks.onCoord((_s: any, changed: string[]) => { if (changed.some((k) => k === "selection" || k === "focus")) recompute(); });
  } };
}

// Subsample DE is fold-change RANKING (no p-value by design — see the caveat), so we show the real effect
// size (logFC = Δ mean log1p) and each side's mean expression — never a fabricated p.adj.
function deBody(p: Panel, _ctx: Ctx, hooks: PanelHooks): BuiltBody {
  const rows = p.rows || [];
  // Two row shapes share this table: a true two-group DE carries per-group means (A/B); a marker table
  // (one group vs rest) carries only logFC. Show the mean columns ONLY when they exist — otherwise the
  // table renders misleading 0.00s for genes whose logFC is plainly non-zero.
  const hasMeans = rows.some((r) => r.meanA != null || r.meanB != null);
  const short = (s: string) => (s.length > 11 ? s.slice(0, 10) + "…" : s);
  const cols: any[] = [
    { key: "symbol", label: "gene", get: (r: any) => r.symbol },
    { key: "lfc", label: "logFC", num: true, get: (r: any) => r.lfc ?? 0, fmt: (v: number) => (v > 0 ? "+" : "") + v.toFixed(2), cls: (v: number) => (v > 0 ? "up" : "dn") },
  ];
  if (hasMeans) {
    cols.push({ key: "meanA", label: p.aLabel ? short(p.aLabel) : "A", num: true, get: (r: any) => r.meanA ?? 0, fmt: (v: number) => v.toFixed(2) });
    cols.push({ key: "meanB", label: p.bLabel ? short(p.bLabel) : "B", num: true, get: (r: any) => r.meanB ?? 0, fmt: (v: number) => v.toFixed(2) });
  }
  return geneTable(rows, cols, hooks.onGeneClick);
}

// A ranked gene list with a single score column (e.g. scope-aware overdispersion).
function geneListBody(p: Panel, hooks: PanelHooks): BuiltBody {
  return geneTable(p.rows || [], [
    { key: "symbol", label: "gene", get: (r) => r.symbol },
    { key: "score", label: p.cap || "score", num: true, get: (r) => r.score ?? 0, fmt: (v) => v.toFixed(2), cls: () => "up" },
  ], hooks.onGeneClick);
}

async function compositionBody(panel: Panel, ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  const s = resolvePanelStyleFor(ctx, "CompositionBars", panel.view);   // panel style (bar width/gap, ribbon opacities, axis font)
  const grouping = panel.view?.colorBy?.startsWith("meta:") ? panel.view.colorBy.slice(5) : ctx.defaultGrouping();   // per-panel stack grouping
  const { samples, conds, groups, props } = await ctx.composition(grouping);
  // remember each category's segment box per sample — geometry for the hover ribbons; recomputed each draw()
  const seg: ({ x: number; yTop: number; yBot: number } | null)[][] = groups.map(() => samples.map(() => null));
  let bw = 40;   // live bar width, set by draw() — ribbonOf reads it
  const w = mk("div"); w.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden";
  const host = mk("div", "comphost"); host.style.cssText = "flex:1 1 auto;min-height:0;position:relative";
  host.innerHTML = `<svg class="compsvg" width="100%" height="100%" preserveAspectRatio="none"><g class="cbars"></g><g class="cribbons"></g></svg>`;
  const leg = mk("div", "legend"); leg.innerHTML = groups.map((gr, i) => `<span class="lgi" data-g="${esc(gr)}"><span class="sw" style="background:rgb(${catColor(i).join(",")})"></span>${esc(gr)}</span>`).join("");
  w.appendChild(host); w.appendChild(leg);
  // Responsive: the bars fill the host's live height (no fixed aspect → no wasted vertical space). Re-lays on
  // resize. A faint 0/50/100% scale reads the stacked proportions now that the bars are tall.
  const draw = () => {
    // Hide the legend by DEFAULT when it would crowd the panel — if its (wrapped) height is ≥ ~50% of the widget,
    // drop it; identity is still available on hover (the segment tooltip + legend-driven highlight). Re-evaluated on
    // every resize (wrapping changes with width). An explicit display.legend override always wins.
    const explicitLegend = panel.view?.display?.legend;
    leg.style.display = "";                                          // reset so scrollHeight reads the natural height
    const totalH = w.clientHeight, legH = leg.scrollHeight;
    leg.style.display = (explicitLegend != null ? !!explicitLegend : (totalH <= 0 || legH < totalH * 0.5)) ? "" : "none";
    const W = host.clientWidth, H = host.clientHeight; if (W < 12 || H < 12) return;
    const svg = host.querySelector(".compsvg") as SVGSVGElement;   // size the SVG to the host in px (height:100% won't resolve against a flex parent)
    svg.setAttribute("width", String(W)); svg.setAttribute("height", String(H)); svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const p = 30, botH = 24, topPad = 6, barH = Math.max(20, H - botH - topPad);
    const step = (W - p - 6) / samples.length; bw = Math.min(s.bar.maxWidth, step - s.bar.gap);
    let g = "";
    for (const f of [0, 0.5, 1]) { const y = topPad + barH * f; g += `<line x1="${p}" y1="${y.toFixed(1)}" x2="${W - 6}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-opacity="0.5" stroke-width="0.5"/><text class="axis" x="${p - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" style="font-size:${s.axis.font}px">${Math.round((1 - f) * 100)}</text>`; }
    samples.forEach((sm, i) => {
      const x = p + i * step + (step - 6 - bw) / 2; let ya = topPad + barH;
      props[i].forEach((pr, t) => { const h = pr * barH; const yTop = ya - h; seg[t][i] = { x, yTop, yBot: ya };
        g += `<rect class="cseg" data-g="${esc(groups[t])}" data-sm="${esc(sm)}" data-pct="${(pr * 100).toFixed(1)}" x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="rgb(${catColor(t).join(",")})"/>`; ya = yTop; });
      g += `<text class="axis" x="${(x + bw / 2).toFixed(1)}" y="${H - 13}" text-anchor="middle">${esc(sm)}</text>`;
      g += `<text class="axis" x="${(x + bw / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle" fill="${conds[i] === "disease" ? "var(--bad)" : "var(--cyan)"}">${esc(conds[i])}</text>`;
    });
    (host.querySelector(".cbars") as SVGGElement).innerHTML = g;
    render();   // re-apply highlight/ribbon state against the new geometry
  };
  const tip = mk("div"); tip.style.cssText = "position:absolute;display:none;background:var(--ink);border:1px solid var(--line2);border-radius:6px;padding:3px 8px;font-size:11px;color:var(--text);pointer-events:none;z-index:20;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.45)"; w.appendChild(tip);
  const showTip = (e: PointerEvent, html: string) => { tip.innerHTML = html; tip.style.display = "block"; const r = w.getBoundingClientRect(); let x = e.clientX - r.left + 13; if (x + tip.offsetWidth > r.width - 4) x = e.clientX - r.left - tip.offsetWidth - 8; tip.style.left = Math.max(2, x) + "px"; tip.style.top = (e.clientY - r.top + 13) + "px"; };

  // React to BOTH tiers, distinctly: select = committed (heavy dim + bold + bright ribbon), hover = ephemeral
  // (soft dim + thin cue + faint ribbon). State is internal; re-rendered when either tier updates.
  const ribbons = host.querySelector(".cribbons") as SVGGElement;
  let selSet: Set<string> | null = null, hovSet: Set<string> | null = null;
  const ribbonOf = (name: string, opacity: number) => {
    const t = groups.indexOf(name); if (t < 0) return "";
    let d = ""; for (let i = 0; i + 1 < samples.length; i++) { const a = seg[t][i], b = seg[t][i + 1]; if (!a || !b) continue;
      const xr = a.x + bw, xl = b.x, mx = (xr + xl) / 2;
      d += `<path d="M${xr} ${a.yTop.toFixed(1)} C${mx} ${a.yTop.toFixed(1)} ${mx} ${b.yTop.toFixed(1)} ${xl} ${b.yTop.toFixed(1)} L${xl} ${b.yBot.toFixed(1)} C${mx} ${b.yBot.toFixed(1)} ${mx} ${a.yBot.toFixed(1)} ${xr} ${a.yBot.toFixed(1)} Z" fill="rgb(${catColor(t).join(",")})" fill-opacity="${opacity}"/>`; }
    return d;
  };
  const render = () => {
    const hasSel = !!(selSet && selSet.size), hasHov = !!(hovSet && hovSet.size);
    host.querySelectorAll<SVGRectElement>(".cseg").forEach((s) => { const n = s.dataset.g!, inSel = !!selSet?.has(n), inHov = !!hovSet?.has(n);
      s.classList.toggle("sel", inSel); s.classList.toggle("seldim", hasSel && !inSel);
      s.classList.toggle("hov", inHov && !inSel); s.classList.toggle("hovdim", !hasSel && hasHov && !inHov); });
    leg.querySelectorAll<HTMLElement>(".lgi").forEach((e) => { const n = e.dataset.g!; e.classList.toggle("sel", !!selSet?.has(n)); e.classList.toggle("hov", !!hovSet?.has(n)); });
    let paths = "";
    if (hasSel) for (const n of selSet!) paths += ribbonOf(n, s.ribbon.selOpacity);
    if (hasHov) for (const n of hovSet!) if (!selSet?.has(n)) paths += ribbonOf(n, s.ribbon.hovOpacity);
    ribbons.innerHTML = paths;
  };
  // emit on hover (hint, light); click commits a SELECTION — the exact cell-set any panel would produce
  const nameAt = (e: Event) => ((e.target as Element).closest(".cseg, .lgi") as HTMLElement | null)?.dataset.g || null;
  w.addEventListener("pointermove", (e) => { const n = nameAt(e); if (n) ctx.coord.setHint({ kind: "category", grouping, value: n }); else ctx.coord.clearHint();
    const sg = (e.target as Element).closest(".cseg") as HTMLElement | null;
    if (sg) showTip(e as PointerEvent, `<b>${esc(sg.dataset.g!)}</b>${sg.dataset.pct ? ` · ${sg.dataset.pct}%` : ""}${sg.dataset.sm ? `<br><span style="color:var(--faint)">in ${esc(sg.dataset.sm)}</span>` : ""}`); else tip.style.display = "none"; });
  w.addEventListener("pointerleave", () => { ctx.coord.clearHint(); tip.style.display = "none"; });
  w.addEventListener("click", (e) => { const n = nameAt(e); ctx.coord.setSelection(n ? { kind: "category", grouping, value: n } : null); });   // block → select; empty → deselect (mirrors the UMAP)

  return { el: w, afterAttach: () => {
    hooks.registerComposition({ grouping, setSelect: (v) => { selSet = v; render(); }, setHover: (v) => { hovSet = v; render(); } });
    const pb = w.parentElement as HTMLElement | null; if (pb) { pb.style.position = "relative"; if (pb.clientHeight < 80) pb.style.height = "300px"; }   // contain the absolute w within the body
    draw();
    let ro: ResizeObserver; ro = new ResizeObserver(() => { if (!w.isConnected) ro.disconnect(); else draw(); });   // fill on resize; self-cleans
    ro.observe(host);
  } };
}

// METADATA FACETS — a fast browser over every per-cell metadata field (experimental design · technical covariates ·
// annotation/clusters), the general analogue of cellxgene's left sidebar. A FIELD row expands to its values; the
// droplet colours the embedding by that field; clicking a VALUE emits a selection event (the embedding + other panels
// react in their own vocabulary); hovering locates it. Occupancy bars are a live crosstab vs the ACTIVE colour-by
// (so e.g. "donor" bars show the cell-type mix per donor), and recompute to the current SELECTION (cross-filter).
// Numeric covariates render a histogram you can drag-brush to select a value range.
const fmtNum = (v: number) => Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(+v.toFixed(2));
async function facetsBody(p: Panel, ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  const s = resolvePanelStyleFor(ctx, "MetadataFacets", p.view);   // panel style (histogram bins)
  const fields = ctx.metadataFields();
  const meta = new Map<string, any>();        // warmed categorical metadata (codes/categories/colors)
  const numMeta = new Map<string, any>();     // warmed numeric metadata (values/min/max)
  for (const f of fields) { try { const m = await ctx.metaOf(f.name); if (m.kind === "categorical") meta.set(f.name, m); else numMeta.set(f.name, m); } catch { /* unreadable — skip */ } }
  const countCache = new Map<string, { value: string; count: number; ci: number }[]>();
  // per-value cell counts over ALL cells, sorted desc — the STABLE row order (kept under a cross-filter so rows
  // don't jump around when you select).
  const valueStats = (field: string) => {
    if (countCache.has(field)) return countCache.get(field)!;
    const m = meta.get(field); if (!m) return [];
    const counts = new Int32Array(m.categories.length);
    for (let i = 0; i < m.codes.length; i++) { const c = m.codes[i]; if (c >= 0) counts[c]++; }
    const rows = m.categories.map((value: string, i: number) => ({ value, count: counts[i], ci: m.colors?.[i] ?? i }))
      .filter((r: any) => r.count > 0).sort((a: any, b: any) => b.count - a.count);
    countCache.set(field, rows); return rows;
  };
  // counts (+ optional per-active-colour segments) for field G over a cell universe (selection subset, or all).
  const tally = (G: any, F: any | null, subset: Int32Array | null) => {
    const R = G.categories.length, C = F ? F.categories.length : 0;
    const counts = new Int32Array(R);
    const seg = F ? Array.from({ length: R }, () => new Int32Array(C)) : null;
    const N = subset ? subset.length : G.codes.length;
    for (let k = 0; k < N; k++) { const i = subset ? subset[k] : k; const a = G.codes[i]; if (a < 0 || a >= R) continue; counts[a]++; if (seg) { const b = F.codes[i]; if (b >= 0 && b < C) seg[a][b]++; } }
    return { counts, seg };
  };

  const w = mk("div"); w.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;font-size:12px";
  const hdr = mk("div"); hdr.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:7px;padding:6px 10px;border-bottom:1px solid var(--line2)";
  const search = document.createElement("input"); search.placeholder = "filter fields…"; search.className = "facetsearch"; search.style.cssText = "flex:1;min-width:0;font-size:11px;padding:3px 8px";
  let sortMode: "count" | "name" = (p as any).facetSort === "name" ? "name" : "count";
  const sortBtn = mk("button", "mini facetsort") as HTMLButtonElement; sortBtn.title = "sort values: count ↔ name";
  const setSortLabel = () => { sortBtn.textContent = sortMode === "count" ? "↓ #" : "a–z"; };
  sortBtn.onclick = () => { sortMode = sortMode === "count" ? "name" : "count"; (p as any).facetSort = sortMode; setSortLabel(); render(); };
  hdr.appendChild(search); hdr.appendChild(sortBtn); w.appendChild(hdr); setSortLabel();
  const host = mk("div"); host.style.cssText = "flex:1 1 auto;min-height:0;overflow:auto"; w.appendChild(host);
  const brush = (p as any).facetBrush || ((p as any).facetBrush = { field: "", lo: 0, hi: 0, mn: 0, mx: -1 });   // persisted histogram brush

  // expanded fields persist on the panel (instanceof guard: a workspace-switch JSON round-trip turns a Set into {})
  let open: Set<string> = (p as any).facetOpen instanceof Set ? (p as any).facetOpen : ((p as any).facetOpen = new Set<string>());
  if (!open.size) { const cb = ctx.coord.state.colorBy; const m = cb.startsWith("meta:") ? cb.slice(5) : ""; const def = (meta.has(m) && m) || fields.find((f) => ["annotation", "cell_type", "leiden"].includes(f.name))?.name; if (def) open.add(def); }

  const activeField = () => { const cb = ctx.coord.state.colorBy; return cb.startsWith("meta:") ? cb.slice(5) : cb.startsWith("qc:") ? cb.slice(3) : ""; };
  const GROUPS: [string, string][] = [["annotation", "annotation & clusters"], ["design", "experimental design"], ["covariate", "technical covariates"]];

  const valuesEl = (f: any, sel: any, selCells: Int32Array | null, vq: string) => {
    const G = meta.get(f.name); if (!G) return mk("div");
    let order = valueStats(f.name);                              // count-sorted (stable order)
    if (vq) order = order.filter((r: any) => r.value.toLowerCase().includes(vq));   // search matched VALUES (field name didn't match) → show only those
    if (sortMode === "name") order = [...order].sort((a: any, b: any) => a.value.localeCompare(b.value, undefined, { numeric: true }));
    const act = activeField();
    const F = (act && act !== f.name && meta.has(act)) ? meta.get(act) : null;   // crosstab vs the active colour-by (categorical only)
    // A SELECTION does NOT cross-filter the facet counts — that zeroed every non-matching row (they read as disabled),
    // too drastic for a lightweight highlight. Counts/bars stay over ALL cells; the selected value just gets a subtle
    // row shade (.facetv.on). (The banner above announces the selection + its actions.)
    const t = tally(G, F, null);                                // counts (+ segments) over all cells, always
    const Fcol = F ? F.categories.map((c: string, i: number) => `rgb(${(categoryColorOf(act, c) || catColor(F.colors?.[i] ?? i)).join(",")})`) : null;   // colour-by segments honour per-value overrides
    const idx = new Map<string, number>(G.categories.map((c: string, i: number) => [c, i]));
    const maxC = order.reduce((mx: number, r: any) => Math.max(mx, t.counts[idx.get(r.value)!]), 1);
    const wrap = mk("div", "facetvals");
    wrap.innerHTML = order.map((r: any) => {
      const gi = idx.get(r.value)!; const cnt = t.counts[gi]; const self = `rgb(${(categoryColorOf(f.name, r.value) || catColor(r.ci)).join(",")})`;   // the value's swatch honours a per-value override
      const seg = (F && cnt > 0) ? F.categories.map((_: any, fi: number) => { const s = t.seg![gi][fi]; return s ? `<i style="width:${(s / cnt * 100).toFixed(2)}%;background:${Fcol![fi]}" title="${esc(r.value)} › ${esc(F.categories[fi])}: ${s.toLocaleString()} (${(s / cnt * 100).toFixed(0)}%)"></i>` : ""; }).join("")
                                 : (cnt > 0 ? `<i style="width:100%;background:${self}"></i>` : "");
      const selfOn = sel && sel.kind === "category" && sel.grouping === f.name && sel.value === r.value;
      return `<div class="facetv${selfOn ? " on" : ""}" data-v="${esc(r.value)}" title="${esc(r.value)} · ${cnt.toLocaleString()} cells · click to select, ⌘-click to add, ⊙ to focus">
        <span class="vsw" style="background:${self}"></span><span class="vname">${esc(r.value)}</span>
        <span class="vbar"><span class="vbarfill" style="width:${(cnt / maxC * 100).toFixed(1)}%">${seg}</span></span>
        <span class="vcount">${cnt.toLocaleString()}</span><span class="vfocus" title="restrict the workspace to this value">⊙</span></div>`;
    }).join("");
    wrap.querySelectorAll<HTMLElement>(".facetv").forEach((el) => {
      const value = el.dataset.v!;
      el.onclick = (e) => {
        if ((e.target as HTMLElement).closest(".vfocus")) return;
        if (e.metaKey || e.shiftKey || e.ctrlKey) {   // additive: union this value's cells into the selection (across fields)
          const cur = ctx.coord.state.selection, curCells = cur ? ctx.refToCells(cur) : new Int32Array(0);
          const add = ctx.cellsOfCategory(f.name, value); const set = new Set<number>();
          for (let j = 0; j < curCells.length; j++) set.add(curCells[j]); for (let j = 0; j < add.length; j++) set.add(add[j]);
          ctx.coord.setSelection(set.size ? { kind: "cells", ids: Int32Array.from(set) } : null);
        } else {
          const c = ctx.coord.state.selection; const same = !!c && c.kind === "category" && (c as any).grouping === f.name && (c as any).value === value;
          ctx.coord.setSelection(same ? null : { kind: "category", grouping: f.name, value });
        }
      };
      (el.querySelector(".vfocus") as HTMLElement).onclick = (e) => { e.stopPropagation(); hooks.focusCategory(f.name, value); };
      el.addEventListener("pointerenter", () => ctx.coord.setHint({ kind: "category", grouping: f.name, value }));
      el.addEventListener("pointerleave", () => ctx.coord.clearHint());
    });
    return wrap;
  };

  // a numeric covariate's distribution — drag across the bars to brush a value range → selects those cells. The FULL
  // distribution is always the (grey) backdrop so it never disappears; the current selection's subset is overlaid in
  // accent (the brushed range, or — if the selection came from elsewhere — that population's distribution here). A ✕
  // on the readout returns to the full, unrestricted set.
  const numericEl = (f: any, selCells: Int32Array | null) => {
    const nm = numMeta.get(f.name); if (!nm) return mk("div", "facetvals");
    const vals: Float32Array = nm.values, lo = nm.min, hi = nm.max, BINS = Math.round(s.hist.bins), wbin = (hi - lo) / BINS || 1;
    const binOf = (v: number) => { let bi = Math.floor((v - lo) / wbin); return bi < 0 ? 0 : bi >= BINS ? BINS - 1 : bi; };
    const full = new Int32Array(BINS); for (let i = 0; i < vals.length; i++) full[binOf(vals[i])]++;
    const sub = selCells ? new Int32Array(BINS) : null; if (sub) for (let k = 0; k < selCells!.length; k++) sub[binOf(vals[selCells![k]])]++;
    const maxH = full.reduce((m, x) => Math.max(m, x), 1);
    const mine = brush.field === f.name && ctx.coord.state.selection?.kind === "cells";   // the selection is THIS field's brush → show its range readout
    const readout = mine ? `${fmtNum(brush.lo)}–${fmtNum(brush.hi)} <span class="hclear" title="clear range — back to full">✕</span>`
                         : selCells ? `${selCells.length.toLocaleString()} selected` : "drag to brush a range";
    const wrap = mk("div", "facethist");
    wrap.innerHTML = `<div class="hbars">${Array.from(full, (h, i) => `<span class="hbin" data-i="${i}"><span class="hf" style="height:${(h / maxH * 100).toFixed(1)}%"></span>${sub ? `<span class="hs" style="height:${(sub[i] / maxH * 100).toFixed(1)}%"></span>` : ""}</span>`).join("")}</div>
      <div class="hmeta"><span>${fmtNum(lo)}</span><span class="hrange">${readout}</span><span>${fmtNum(hi)}</span></div>`;
    const bars = wrap.querySelector(".hbars") as HTMLElement;
    const hclear = wrap.querySelector(".hclear") as HTMLElement | null;
    if (hclear) hclear.onclick = (e) => { e.stopPropagation(); brush.field = ""; brush.mn = 0; brush.mx = -1; ctx.coord.setSelection(null); };
    let down = -1;
    const binAt = (e: PointerEvent) => { const r = bars.getBoundingClientRect(); return Math.max(0, Math.min(BINS - 1, Math.floor((e.clientX - r.left) / r.width * BINS))); };
    const paint = (a: number, b: number) => { const mn = Math.min(a, b), mx = Math.max(a, b); bars.querySelectorAll<HTMLElement>(".hbin").forEach((el, i) => el.classList.toggle("brushing", i >= mn && i <= mx)); };
    bars.addEventListener("pointerdown", (e) => { down = binAt(e); paint(down, down); try { bars.setPointerCapture(e.pointerId); } catch { /* */ } });
    bars.addEventListener("pointermove", (e) => { if (down >= 0) paint(down, binAt(e)); });
    bars.addEventListener("pointerup", (e) => {
      if (down < 0) return; const b = binAt(e), mn = Math.min(down, b), mx = Math.max(down, b); down = -1;
      const vlo = lo + mn * wbin, vhi = lo + (mx + 1) * wbin, ids: number[] = [];
      for (let i = 0; i < vals.length; i++) if (vals[i] >= vlo && vals[i] <= vhi) ids.push(i);
      brush.field = f.name; brush.lo = vlo; brush.hi = vhi; brush.mn = mn; brush.mx = mx;   // MUTATE (the closure holds this ref) so the readout survives re-render
      ctx.coord.setSelection(ids.length ? { kind: "cells", ids: Int32Array.from(ids) } : null);
    });
    return wrap;
  };

  const fieldEl = (f: any, act: string, sel: any, selCells: Int32Array | null, q: string) => {
    const isOpen = open.has(f.name) || !!q;   // an active search auto-expands matching fields
    const box = mk("div"); box.dataset.field = f.name;
    const row = mk("div", "facetf");
    const count = f.kind === "categorical" ? `<span class="fcount">${meta.get(f.name)?.categories.length ?? 0}</span>` : `<span class="fnum" title="numeric covariate">#</span>`;
    row.innerHTML = `<span class="fchev${isOpen ? " open" : ""}">▶</span><span class="fname">${esc(f.name)}</span>${count}<span style="flex:1"></span>`;
    if (f.group === "annotation") {   // composition-by-sample is meaningful for cell-type/cluster groupings (proportions per sample)
      const comp = mk("button", "fcomp mini", "▤"); comp.title = `open composition by sample, stacked by ${f.name}`;
      comp.onclick = (e) => { e.stopPropagation(); hooks.addPanel({ type: "CompositionBars", title: `Composition · ${f.name}`, cap: "by sample", bind: "composition:bySample", view: { colorBy: "meta:" + f.name } }); };
      row.appendChild(comp);
    }
    const drop = mk("button", "fdrop mini" + (act === f.name ? " on" : ""), "◉"); drop.title = `colour the embedding by ${f.name}`;
    drop.onclick = (e) => { e.stopPropagation(); ctx.coord.setColor("meta:" + f.name); };
    row.appendChild(drop);
    row.onclick = (e) => { if ((e.target as HTMLElement).closest(".fdrop,.fcomp")) return; if (open.has(f.name)) open.delete(f.name); else open.add(f.name); render(); };
    box.appendChild(row);
    // if the search matched VALUES (not the field name), filter the shown values to the query
    const vq = q && !f.name.toLowerCase().includes(q) ? q : "";
    if (isOpen) box.appendChild(f.kind === "categorical" ? valuesEl(f, sel, selCells, vq) : numericEl(f, selCells));
    return box;
  };

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const top = host.scrollTop; host.innerHTML = "";
    const act = activeField(); const sel = ctx.coord.state.selection; const selCells = sel ? ctx.refToCells(sel) : null;
    if (sel && selCells) {   // selection action bar — announces the selection + its operations; sits atop the list
      const lbl = sel.kind === "category" ? (sel as any).value : `${selCells.length.toLocaleString()} cells`;
      const banner = mk("div", "facetfilter");
      banner.innerHTML = `<span class="fftext"><b>${esc(lbl)}</b> · ${selCells.length.toLocaleString()} cells selected</span><button class="ffact mini" title="operations on this selection: run DE, label / create a group, ask">actions ▾</button><span class="ffclear" title="clear the selection">✕</span>`;
      (banner.querySelector(".ffact") as HTMLElement).onclick = (e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); hooks.openSelectionMenu({ left: r.left, top: r.bottom + 4, right: r.right }); };   // right-align the menu under the BUTTON (stays inside the panel)
      (banner.querySelector(".ffclear") as HTMLElement).onclick = () => ctx.coord.setSelection(null);
      host.appendChild(banner);
    }
    const allFields = ctx.metadataFields();   // recompute each render → newly created derived categories appear
    // a field matches the search if its NAME matches OR (categorical) any of its VALUE names match (so "cd4" surfaces
    // the cell_type facet showing its CD4 rows). Value-matched fields auto-expand and show only the matching values.
    const matchField = (f: any) => { if (!q) return true; if (f.name.toLowerCase().includes(q)) return true; const m = meta.get(f.name); return !!m && m.categories.some((c: string) => c.toLowerCase().includes(q)); };
    for (const [g, label] of GROUPS) {
      const fs = allFields.filter((f) => f.group === g && matchField(f));
      if (!fs.length) continue;
      host.appendChild(mk("div", "facetsub", label));
      for (const f of fs) host.appendChild(fieldEl(f, act, sel, selCells, q));
    }
    if (!host.querySelector(".facetf")) host.innerHTML = `<div style="color:var(--faint);padding:12px;font-size:11px">no fields match “${esc(q)}”</div>`;
    host.scrollTop = top;
  };

  // CREATE DERIVED CATEGORY — derive a new grouping from existing metadata (the checkboxes live here). Four modes:
  // regroup an existing field's values (merge into named groups), cross two fields, bin a covariate, or name the
  // current selection. The result is a real derived grouping (ctx.setDerivedGrouping) — colourable/selectable like
  // any field, and it shows up in the list immediately.
  const showCreateCard = () => {
    if (w.querySelector(".facetcreate")) return;
    const catFields = ctx.metadataFields().filter((f) => f.kind === "categorical");
    const numFields = ctx.metadataFields().filter((f) => f.kind === "numeric");
    let mode: "values" | "cross" | "bin" | "selection" = ctx.coord.state.selection ? "selection" : "values";
    let regroupSrc = catFields[0]?.name || "";
    const assign = new Map<string, string>();   // srcValue → group label (regroup mode)
    const ov = mk("div", "facetcreate");
    ov.innerHTML = `<div class="fchead"><b>Create derived category</b><span class="fcx" title="cancel">✕</span></div>
      <label class="fcname">name <input class="fcnameinp" placeholder="my_category"></label>
      <div class="fcseg">${[["values", "regroup values"], ["cross", "cross fields"], ["bin", "bin covariate"], ["selection", "from selection"]].map(([m, l]) => `<button class="mini fcm" data-m="${m}">${l}</button>`).join("")}</div>`;
    const body = mk("div", "fcbody"); ov.appendChild(body);
    const err = mk("div", "fcerr"); ov.appendChild(err);
    const foot = mk("div", "fcfoot"); foot.innerHTML = `<button class="mini fccancel">cancel</button><button class="mini fcok">create</button>`; ov.appendChild(foot);
    const setErr = (m: string) => { err.textContent = m || ""; };

    const buildBody = () => {
      body.innerHTML = ""; ov.querySelectorAll(".fcm").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.m === mode));
      if (mode === "values") {
        body.innerHTML = `<div class="fcrow">source <select class="fcsrc">${catFields.map((f) => `<option${f.name === regroupSrc ? " selected" : ""}>${esc(f.name)}</option>`).join("")}</select></div>
          <div class="fcrow"><input class="fcgname" placeholder="group name"><button class="mini fcadd">group selected →</button></div>
          <div class="fcvlist">${valueStats(regroupSrc).map((r: any) => `<label class="fcvrow"><input type="checkbox" data-v="${esc(r.value)}"><span class="fcvn">${esc(r.value)}</span><span class="fcvg">${esc(assign.get(r.value) || "")}</span><span class="fcvc">${r.count.toLocaleString()}</span></label>`).join("")}</div>
          <div class="fchint">checked rows take the group name; unchecked keep their own label</div>`;
        (body.querySelector(".fcsrc") as HTMLSelectElement).onchange = (e) => { regroupSrc = (e.target as HTMLSelectElement).value; assign.clear(); buildBody(); };
        (body.querySelector(".fcadd") as HTMLElement).onclick = () => { const g = (body.querySelector(".fcgname") as HTMLInputElement).value.trim(); if (!g) return setErr("type a group name first"); body.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked").forEach((c) => assign.set(c.dataset.v!, g)); setErr(""); buildBody(); };
      } else if (mode === "cross") {
        body.innerHTML = `<div class="fcrow">field A <select class="fca">${catFields.map((f) => `<option>${esc(f.name)}</option>`).join("")}</select></div>
          <div class="fcrow">field B <select class="fcb">${catFields.map((f, i) => `<option${i === 1 ? " selected" : ""}>${esc(f.name)}</option>`).join("")}</select></div>
          <div class="fchint">one value per present A × B combination</div>`;
      } else if (mode === "bin") {
        body.innerHTML = `<div class="fcrow">covariate <select class="fcnum">${numFields.map((f) => `<option>${esc(f.name)}</option>`).join("")}</select></div>
          <div class="fcrow">cut points <input class="fccuts" placeholder="e.g. 5, 10"></div>
          <div class="fchint">split into bins at the cut points (e.g. &lt; 5 · 5–10 · ≥ 10)</div>`;
      } else {
        const sc = ctx.coord.state.selection ? ctx.refToCells(ctx.coord.state.selection).length : 0;
        body.innerHTML = sc
          ? `<div class="fchint">label the current selection (${sc.toLocaleString()} cells) as a new value; the rest become “other”.</div><div class="fcrow">value name <input class="fcselname" placeholder="my_group"></div>`
          : `<div class="fchint">no active selection — click a value, brush the embedding, or brush a histogram first.</div>`;
      }
    };

    const doCreate = () => {
      const name = (ov.querySelector(".fcnameinp") as HTMLInputElement).value.trim();
      if (!name) return setErr("give the category a name");
      if (ctx.metadataFields().some((f) => f.name === name)) return setErr(`“${name}” already exists`);
      let codes: Int32Array | null = null; let categories: string[] = [];
      if (mode === "values") {
        const G = meta.get(regroupSrc); if (!G) return setErr("pick a source field");
        const idx = new Map<string, number>(); const labelOf = (v: string) => assign.get(v) || v;
        G.categories.forEach((v: string) => { const l = labelOf(v); if (!idx.has(l)) { idx.set(l, categories.length); categories.push(l); } });
        codes = new Int32Array(ctx.n); for (let i = 0; i < ctx.n; i++) { const sc = G.codes[i]; codes[i] = sc >= 0 ? idx.get(labelOf(G.categories[sc]))! : -1; }
      } else if (mode === "cross") {
        const a = (body.querySelector(".fca") as HTMLSelectElement).value, b = (body.querySelector(".fcb") as HTMLSelectElement).value;
        const A = meta.get(a), B = meta.get(b); if (!A || !B || a === b) return setErr("pick two different fields");
        const idx = new Map<string, number>(); codes = new Int32Array(ctx.n);
        for (let i = 0; i < ctx.n; i++) { const ac = A.codes[i], bc = B.codes[i]; if (ac < 0 || bc < 0) { codes[i] = -1; continue; } const key = `${A.categories[ac]} · ${B.categories[bc]}`; let k = idx.get(key); if (k == null) { k = categories.length; categories.push(key); idx.set(key, k); } codes[i] = k; }
      } else if (mode === "bin") {
        const fld = (body.querySelector(".fcnum") as HTMLSelectElement).value; const nm = numMeta.get(fld); if (!nm) return setErr("pick a covariate");
        const cuts = (body.querySelector(".fccuts") as HTMLInputElement).value.split(",").map((s) => parseFloat(s.trim())).filter((x) => !isNaN(x)).sort((p, q) => p - q);
        if (!cuts.length) return setErr("enter at least one cut point");
        categories = cuts.map((c, i) => i === 0 ? `< ${fmtNum(c)}` : `${fmtNum(cuts[i - 1])}–${fmtNum(c)}`).concat(`≥ ${fmtNum(cuts[cuts.length - 1])}`);
        codes = new Int32Array(ctx.n); const vals = nm.values; for (let i = 0; i < ctx.n; i++) { let bi = cuts.findIndex((c) => vals[i] < c); if (bi < 0) bi = cuts.length; codes[i] = bi; }
      } else {
        const sel = ctx.coord.state.selection; if (!sel) return setErr("no active selection");
        const cells = ctx.refToCells(sel); const set = new Set<number>(); for (let j = 0; j < cells.length; j++) set.add(cells[j]);
        const val = (body.querySelector(".fcselname") as HTMLInputElement)?.value.trim() || "selected";
        categories = [val, "other"]; codes = new Int32Array(ctx.n); for (let i = 0; i < ctx.n; i++) codes[i] = set.has(i) ? 0 : 1;
      }
      if (!codes || categories.length < 2) return setErr("that produces fewer than two groups");
      ctx.setDerivedGrouping(name, codes, categories);
      meta.set(name, { kind: "categorical", codes, categories, colors: categories.map((c) => ctx.labelColorIndex(c)) });
      countCache.delete(name); ov.remove(); open.add(name); ctx.coord.setColor("meta:" + name); render();
    };

    ov.querySelectorAll(".fcm").forEach((b) => ((b as HTMLElement).onclick = () => { mode = (b as HTMLElement).dataset.m as any; setErr(""); buildBody(); }));
    (ov.querySelector(".fcx") as HTMLElement).onclick = () => ov.remove();
    (ov.querySelector(".fccancel") as HTMLElement).onclick = () => ov.remove();
    (ov.querySelector(".fcok") as HTMLElement).onclick = doCreate;
    buildBody(); w.appendChild(ov); (ov.querySelector(".fcnameinp") as HTMLInputElement).focus();
  };

  const foot = mk("div", "facetfoot"); const cbtn = mk("button", "mini", "＋ create category"); cbtn.onclick = showCreateCard; foot.appendChild(cbtn); w.appendChild(foot);

  search.oninput = () => render();
  render();

  return { el: w, afterAttach: () => {
    const pb = w.parentElement as HTMLElement | null; if (pb) { pb.style.position = "relative"; if (pb.clientHeight < 80) pb.style.height = "320px"; }
    // re-render on colour-by (crosstab basis), selection (cross-filter), or focus; ignore hover spam (hint/geneHint)
    hooks.onCoord((_s, changed) => { if (changed.some((k) => k === "colorBy" || k === "selection" || k === "focus")) render(); });
  } };
}

function volcanoBody(p: Panel, ctx: Ctx): BuiltBody {
  const s = resolvePanelStyleFor(ctx, "Volcano", p.view);   // hit thresholds, dot radius, label cutoff, axis limits
  const W = 420, H = 240, pad = 28, lT = s.thresh.lfc, pT = s.thresh.p, xm = s.axis.xMax, ym = s.axis.yMax;
  const rows = (p.rows || []);
  const sx = (v: number) => pad + (Math.max(-xm, Math.min(xm, v)) + xm) / (2 * xm) * (W - pad - 6);
  const sy = (v: number) => H - pad - Math.min(v, ym) / ym * (H - 2 * pad);
  let g = `<line class="gl" x1="${sx(0)}" y1="6" x2="${sx(0)}" y2="${H - pad}"/>`;
  for (const r of rows) {
    const lfc = r.lfc ?? 0, pj = r.padj ?? 1;
    const y = -Math.log10(Math.max(pj, 1e-12)); const hit = Math.abs(lfc) >= lT && pj <= pT;
    g += `<circle cx="${sx(lfc).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="${s.dot.radius}" fill="${hit ? (lfc > 0 ? "var(--bad)" : "var(--cyan)") : "var(--faint)"}"/>`;
    if (hit && Math.abs(lfc) > s.label.lfc) g += `<text class="axis" x="${(sx(lfc) + 5).toFixed(1)}" y="${(sy(y) + 3).toFixed(1)}">${r.symbol}</text>`;
  }
  g += `<text class="axis" x="${W / 2}" y="${H - 3}" text-anchor="middle">log2 fold-change</text>`;
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}` }); svg.innerHTML = g;
  const w = mk("div"); w.appendChild(svg); return { el: w };
}

async function boxBody(p: Panel, ctx: Ctx): Promise<BuiltBody> {
  const s = resolvePanelStyleFor(ctx, "BoxBySample", p.view);   // point radius/opacity, decimation cap, mean-line width
  const gene = p.gene || "IL6";
  const bins = await ctx.exprBySample(gene, p.group);
  const W = 540, H = 180, pad = 28; const allMax = Math.max(...bins.flatMap((b) => b.vals), 1);
  const sx = (i: number) => pad + i * ((W - pad - 6) / bins.length) + 20;
  const sy = (v: number) => H - pad - v / allMax * (H - 2 * pad);
  let g = "";
  bins.forEach((b, i) => {
    const x = sx(i), col = b.cond === "disease" ? "var(--bad)" : "var(--cyan)";
    const step = Math.max(1, Math.floor(b.vals.length / s.dot.maxPer));
    for (let k = 0; k < b.vals.length; k += step) g += `<circle cx="${(x + (k % 9 - 4)).toFixed(1)}" cy="${sy(b.vals[k]).toFixed(1)}" r="${s.dot.radius}" fill="${col}" fill-opacity="${s.dot.opacity}"/>`;
    g += `<line x1="${x - 13}" y1="${sy(b.mean).toFixed(1)}" x2="${x + 13}" y2="${sy(b.mean).toFixed(1)}" stroke="${col}" stroke-width="${s.mean.width}"/>`;
    g += `<text class="axis" x="${x}" y="${H - 12}" text-anchor="middle">${b.sample}</text><text class="axis" x="${x}" y="${H - 3}" text-anchor="middle" fill="${col}">${b.cond}</text>`;
  });
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}` }); svg.innerHTML = g;
  const w = mk("div"); w.appendChild(svg); return { el: w };
}

// Reconciliation table: rows = base-partition clusters; columns = the working draft + each annotation source's
// dominant label (+ its coverage of the cluster). Clicking a source cell ACCEPTS that label into the working
// draft for the cluster's cells (last-write-wins). Exact agreement across sources gets a ✓; we deliberately do
// NOT flag "conflict" on a string mismatch (vocabulary differs across sources — the matrix view + agent judge).
async function reconcileBody(p: Panel, ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  const base = p.group || (ctx.groupings().includes("leiden") ? "leiden" : ctx.defaultGrouping());
  const baseMeta: any = await ctx.view.metadata(base);
  if (baseMeta.kind !== "categorical") { const m = mk("div", "panelerr"); m.textContent = `base "${base}" is not a categorical partition`; return { el: m }; }
  const srcNames = ctx.annotationSources();
  const sources: { name: string; codes: ArrayLike<number>; categories: string[] }[] = [];
  for (const n of srcNames) { const m: any = await ctx.view.metadata(n); if (m.kind === "categorical") sources.push({ name: n, codes: m.codes, categories: m.categories }); }
  // FOCUS restricts the table to the focused subpopulation (a cross-panel restriction): only clusters with
  // focus cells appear, counts/fractions are within-focus. (The embedding greys non-focus cells in parallel.)
  const focus = ctx.coord.state.focus;
  const restrict = focus ? focusMaskFor(focus, ctx.n) : undefined;
  const rows = reconcile({ codes: baseMeta.codes, categories: baseMeta.categories }, sources, restrict);
  const workMeta: any = ctx.annotationLayers().includes("annotation") ? await ctx.view.metadata("annotation") : null;
  const workRows = workMeta ? reconcile({ codes: baseMeta.codes, categories: baseMeta.categories }, [{ name: "annotation", codes: workMeta.codes, categories: workMeta.categories }], restrict) : null;
  // base cluster → cell count, and working label → the base clusters carrying it (so the card can show the
  // selected cluster's context and note when one label spans several clusters — why two rows show the same card).
  const grpN = new Map<string, number>(rows.map((r) => [r.group, r.n]));
  const grpToRow = new Map<string, ReconRow>(rows.map((r) => [r.group, r]));
  const labelClusters = new Map<string, string[]>();   // working label → the base clusters carrying it
  const grpWork = new Map<string, string>();           // base cluster → its working label
  if (workRows) workRows.forEach((wr, gi) => { const wl = wr.sources[0].label; if (wl) { grpWork.set(rows[gi].group, wl); const a = labelClusters.get(wl) || []; a.push(rows[gi].group); labelClusters.set(wl, a); } });

  const w = mk("div"); w.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;font-size:12px";
  const hdr = mk("div"); hdr.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:7px;padding:6px 10px;border-bottom:1px solid var(--line2);flex-wrap:wrap";
  const nResolved = workRows ? workRows.filter((r) => r.sources[0].label != null).length : 0;
  hdr.innerHTML = `<span style="color:var(--faint)">base</span> <b>${esc(base)}</b> · <span style="color:var(--faint)">${rows.length} clusters, ${nResolved} labeled</span> <span style="color:var(--faint)">·</span> ${sources.length ? sources.map((s) => `<span style="border:1px solid var(--line2);border-radius:5px;padding:1px 6px;color:var(--dim)">${esc(s.name)} <span class="rcadopt" data-adopt="${esc(s.name)}" title="adopt this source as the working draft" style="cursor:pointer;color:var(--cyan)">⤵</span></span>`).join(" ") + ' <span style="color:var(--faint);font-size:11px">— click a cell to accept one label, ⤵ to adopt a whole source</span>' : '<span style="color:var(--amber,#e0a458)">no sources — run scType or add one</span>'}`;
  hdr.querySelectorAll<HTMLElement>(".rcadopt").forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); hooks.annotation.adoptSource(el.dataset.adopt!); }));
  // view toggle: table (reconcile) · matrix (confusion, vocab-agnostic) · labels (review the working draft)
  const layers = [...(workMeta ? [{ name: "working", codes: workMeta.codes, categories: workMeta.categories }] : []), ...sources];
  const seg = mk("div", "segtog"); seg.style.marginLeft = "auto";
  const segItems: [string, string][] = [["table", "table"]];
  if (layers.length >= 2) segItems.push(["matrix", "matrix"]);
  if (workMeta) segItems.push(["labels", "labels"]);
  // persist the chosen view across re-renders (a Suggest/accept triggers fullRender; the view must NOT snap
  // back to "table"). Fall back to table if the persisted mode isn't available this render.
  let mode = (segItems.some(([m]) => m === (p as any).reconMode) ? (p as any).reconMode : "table") as "table" | "matrix" | "labels";
  for (const [m, lbl] of segItems) { const b = mk("button", "mini" + (m === mode ? " on" : ""), lbl) as HTMLButtonElement; b.dataset.m = m; seg.appendChild(b); }
  if (segItems.length >= 2) hdr.appendChild(seg);
  w.appendChild(hdr);
  const host = mk("div"); host.style.cssText = "flex:1 1 auto;min-height:0;overflow:auto"; w.appendChild(host);
  const mhost = mk("div"); mhost.style.cssText = "flex:1 1 auto;min-height:0;overflow:auto;display:none;padding:8px 10px"; w.appendChild(mhost);
  const lhost = mk("div"); lhost.style.cssText = "flex:1 1 auto;min-height:0;overflow:auto;display:none;padding:8px 10px"; w.appendChild(lhost);
  // the CAP record for the selected cluster's working label — folded in here (cohesive single panel, not a
  // separate full-width one). Follows the selection; updates on accept.
  const recDetail = mk("div", "rcrec"); recDetail.style.cssText = "flex:0 0 auto;max-height:46%;overflow:auto;border-top:1px solid var(--line);padding:8px 10px;background:var(--card)"; w.appendChild(recDetail);
  const workLayer = hooks.annotation.annoLayer("annotation");
  let recLabel: string | null = (p as any).recordLabel || null;
  let selCluster: string | null = null;   // the base cluster the user last clicked (drives the card's context line)
  let recCollapsed: boolean = !!(p as any).recCollapsed;   // user minimized the card (frees space, esp. in matrix view)
  const flashCard = () => { recDetail.style.transition = "none"; recDetail.style.background = "var(--sel)"; requestAnimationFrame(() => { recDetail.style.transition = "background .5s"; recDetail.style.background = "var(--card)"; }); };
  const showRecord = (lbl: string | null) => {
    // show the card ONLY for a real selection — no fallback to an arbitrary first label (which made a record
    // appear on load with no row selected). No valid label → hide the panel entirely.
    const l = (workLayer && lbl && workLayer.categories.includes(lbl)) ? lbl : null;
    if (!l) { recDetail.style.display = "none"; return; }
    recDetail.style.display = "";
    recLabel = l; (p as any).recordLabel = l;
    if (recCollapsed) {   // minimized: a thin bar with the label + an expand affordance
      recDetail.style.maxHeight = ""; recDetail.style.overflow = "hidden";
      recDetail.innerHTML = `<div class="reccollapsed" title="show the label record" style="cursor:pointer;font-size:11.5px;display:flex;align-items:center;gap:6px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:rgb(${catColor(ctx.labelColorIndex(l)).join(",")})"></span><b style="color:var(--dim);font-weight:500">${esc(l)}</b><span style="color:var(--faint)">— record hidden · click to show ▸</span></div>`;
      (recDetail.querySelector(".reccollapsed") as HTMLElement).onclick = () => { recCollapsed = false; (p as any).recCollapsed = false; showRecord(l); };
      return;
    }
    recDetail.style.maxHeight = "46%"; recDetail.style.overflow = "auto";
    // context line: which base cluster you clicked + a note when this label spans several clusters (so two rows
    // mapping to the same label visibly differ — the "why doesn't the card change?" fix).
    let context: string | undefined;
    let accept: { cluster: string; current: string; options: { label: string; sources: string[] }[]; onAccept: (lab: string) => void } | undefined;
    if (selCluster != null) {
      const others = (labelClusters.get(l) || []).filter((g) => g !== selCluster);
      context = `selected: ${esc(base)} ${esc(selCluster)} · ${(grpN.get(selCluster) || 0).toLocaleString()} cells` + (others.length ? ` <span style="color:var(--amber,#e0a458)">· “${esc(l)}” also covers ${esc(base)} ${others.map(esc).join(", ")}</span>` : "");
      // accept options for THIS cluster: each source's read (deduped by label), to set as the working label
      const row = grpToRow.get(selCluster);
      if (row) {
        const byLabel = new Map<string, string[]>();
        for (const s of row.sources) if (s.label) { const e = byLabel.get(s.label) || []; e.push(s.name); byLabel.set(s.label, e); }
        const options = [...byLabel].map(([label, srcs]) => ({ label, sources: srcs }));
        if (options.length) accept = { cluster: selCluster, current: l, options, onAccept: (lab) => { (p as any).recordLabel = lab; hooks.annotation.annotate(ctx.cellsOfCategory(base, selCluster!), lab); } };
      }
    }
    renderCapRecord(recDetail, workLayer!, l, ctx, hooks, { context, accept, onRename: (to) => { (p as any).recordLabel = to; hooks.annotation.renameLabel("annotation", l, to); }, onCollapse: () => { recCollapsed = true; (p as any).recCollapsed = true; showRecord(l); } });
    flashCard();
  };
  // "labels" view: review the whole working annotation before export — each label's colour, cell count, and
  // CAP completeness (ontology term set? rationale?). Click a label to load its record below.
  const renderLabels = () => {
    if (!workLayer || !workLayer.categories.length) { lhost.innerHTML = '<span style="color:var(--faint);font-size:11.5px">no working draft yet — accept/adopt labels first</span>'; return; }
    const cnt = new Int32Array(workLayer.categories.length); for (const c of workLayer.codes) if (c >= 0) cnt[c]++;
    const recs = workLayer.records || {};
    const live = workLayer.categories.map((c, i) => ({ c, i, n: cnt[i] })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    const withOnt = live.filter((x) => recs[x.c]?.ontologyTermId).length, withRat = live.filter((x) => recs[x.c]?.rationale).length;
    let unlabeled = 0; for (const c of workLayer.codes) if (c < 0) unlabeled++;
    let h = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        <span style="font-size:11px;color:var(--faint)">${live.length} labels · <span style="color:${withOnt === live.length ? "var(--good,#6bbf73)" : "var(--amber,#e0a458)"}">${withOnt} with ontology</span> · ${withRat} with rationale${unlabeled ? ` · <span style="color:var(--amber,#e0a458)">${unlabeled} cells unlabeled</span>` : ""}</span>
        <button id="lsuggest" class="mini" title="ask the agent to propose names + rationales for all clusters from their markers" style="margin-left:auto;border-color:var(--amber,#e0a458);color:var(--amber,#e0a458)">✨ Suggest names</button>
        <button id="lexport" class="mini" title="download all labels as CAP-schema JSON (for deposition)">export CAP</button>
      </div><table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>`;
    for (const { c, i, n } of live) { const r = recs[c] || {};
      h += `<tr class="lrow" data-l="${esc(c)}" style="border-top:1px solid var(--line);cursor:pointer">
        <td style="padding:3px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:rgb(${catColor(ctx.labelColorIndex(c)).join(",")});margin-right:6px"></span>${esc(c)}</td>
        <td style="padding:3px 6px;color:var(--faint);text-align:right">${n}</td>
        <td style="padding:3px 6px;font-size:10.5px;white-space:nowrap">${r.ontologyTermId ? `<span style="color:var(--cyan)">${esc(r.ontologyTermId)}</span>` : '<span style="color:var(--amber,#e0a458)">⚠ no ontology</span>'}</td>
        <td style="padding:3px 6px;color:${r.rationale ? "var(--good,#6bbf73)" : "var(--faint)"};font-size:10.5px">${r.rationale ? "✓ rationale" : "—"}</td></tr>`;
    }
    h += `</tbody></table>`;
    lhost.innerHTML = h;
    lhost.querySelectorAll<HTMLElement>("tr.lrow").forEach((tr) => tr.addEventListener("click", () => { selCluster = null; showRecord(tr.dataset.l!); }));
    const sb = lhost.querySelector("#lsuggest") as HTMLButtonElement | null; if (sb) sb.onclick = () => { sb.disabled = true; sb.textContent = "✨ thinking…"; hooks.annotation.proposeAllNames(workLayer!.name); };
    const eb = lhost.querySelector("#lexport") as HTMLButtonElement | null; if (eb) eb.onclick = () => exportCap(workLayer!, ctx);
  };

  const colorOf = (_cats: string[], label: string | null) => label == null ? "var(--faint)" : `rgb(${catColor(ctx.labelColorIndex(label)).join(",")})`;   // stable label-name colour
  // a source's read of a cluster; when it SPLITS the cluster (dominant <70%) the runner-up is shown in amber,
  // so labelings that don't map 1:1 to clusters are visible (the matrix view + brush/agent resolve the split).
  // a source column is INFORMATIONAL — it shows what that source called the cluster (for comparison). It is NOT a
  // button: clicking anywhere in the row selects the cluster (→ card), where accepting a source's label is an
  // explicit action. (Previously clicking a source cell silently overwrote the working label — confusing.)
  const cell = (s: ReconRow["sources"][number], wl: string | null) => {
    if (s.label == null) return `<td style="color:var(--faint);padding:3px 8px">—</td>`;
    const mixed = s.frac < 0.7 && !!s.alt;
    const pct = s.frac < 0.999 ? `<span style="color:var(--faint);font-size:10.5px">${(s.frac * 100).toFixed(0)}%</span>` : "";
    const altTxt = mixed ? `<div style="font-size:10px;color:var(--amber,#e0a458)">+ ${esc(s.alt!)} ${((s.altFrac || 0) * 100).toFixed(0)}%</div>` : "";
    const isWork = wl != null && s.label === wl;   // this source matches the current working label → subtle tick
    const tip = mixed ? `splits this cluster: ${esc(s.label)} ${(s.frac * 100).toFixed(0)}% / ${esc(s.alt!)} ${((s.altFrac || 0) * 100).toFixed(0)}%` : esc(s.label);
    return `<td style="padding:3px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px${isWork ? ";color:var(--good,#6bbf73)" : ""}" title="${tip}">${esc(s.label)} ${pct}${altTxt}</td>`;
  };
  // the working-annotation column is the canonical OUTPUT (what you're building); the source columns are
  // informational reads. A subtle tint sets the working column apart from the sources.
  const WORKBG = "var(--warm)";   // the canonical "working annotation" column — a warm designation tint (theme-aware)
  // header row sits on a distinct shade (--inset) so it reads apart from the body rows (on --panel)
  const HEADBG = "var(--inset)";
  const th = (label: string, extra = "") => `<th style="padding:4px 8px;position:sticky;top:0;background:${HEADBG};border-bottom:1px solid var(--line)${extra}">${label}</th>`;
  let html = `<table class="rctab" style="width:100%;border-collapse:collapse"><thead><tr style="color:var(--faint);text-align:left">
    ${th("cluster")}
    ${th("working annotation", `;box-shadow:inset 0 0 0 999px ${WORKBG};color:var(--dim)`)}
    ${sources.map((s) => th(esc(s.name))).join("")}
    ${th("")}</tr></thead><tbody>`;
  rows.forEach((r: ReconRow, gi) => {
    const wl = workRows ? workRows[gi].sources[0].label : null;
    const opinions = r.sources.map((s) => s.label).filter((l): l is string => l != null);
    const allAgree = opinions.length >= 2 && opinions.every((l) => l === opinions[0]) && (wl == null || wl === opinions[0]);
    const wcolor = colorOf(workMeta?.categories || [], wl);
    html += `<tr class="rcrow" data-g="${gi}" data-grp="${esc(r.group)}" style="border-top:1px solid var(--line);cursor:pointer">
      <td style="padding:3px 8px;color:var(--dim);white-space:nowrap">${esc(r.group)} <span style="color:var(--faint);font-size:10.5px">${r.n}</span></td>
      <td style="padding:3px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;background:${WORKBG}">${wl ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${wcolor};margin-right:5px"></span>${esc(wl)}` : '<span style="color:var(--faint)">—</span>'}</td>
      ${r.sources.map((s) => cell(s, wl)).join("")}
      <td style="padding:3px 8px;color:var(--good,#6bbf73)">${allAgree ? "✓" : ""}</td></tr>`;
  });
  html += `</tbody></table>`;
  host.innerHTML = html;

  // coordination: row hover/click selects the cluster everywhere (every cell — accept lives in the card now)
  let selRows: Set<string> | null = null;
  // Highlight: the directly-selected row(s) PROMINENTLY; sibling clusters that share the selected cluster's
  // working label get a fainter tint (so "this annotation also covers these clusters" is visible immediately,
  // not only after a Suggest re-selects by label). When the selection IS a label (selRows already spans all its
  // clusters), there are no extra siblings.
  const paint = () => {
    let siblings: Set<string> | null = null;
    if (selCluster != null) { const wl = grpWork.get(selCluster); if (wl) siblings = new Set((labelClusters.get(wl) || []).filter((g) => !selRows?.has(g))); }
    host.querySelectorAll<HTMLElement>("tr.rcrow").forEach((tr) => {
      const g = tr.dataset.grp!;
      tr.style.background = selRows?.has(g) ? "var(--sel)" : (siblings?.has(g) ? "var(--sel2)" : "");
    });
  };
  host.querySelectorAll<HTMLElement>("tr.rcrow").forEach((tr) => {
    const grp = tr.dataset.grp!;
    tr.addEventListener("pointerenter", () => ctx.coord.setHint({ kind: "category", grouping: base, value: grp }));
    tr.addEventListener("pointerleave", () => ctx.coord.clearHint());
    tr.addEventListener("click", () => {
      // a row click always OPENS the record (un-collapse) — clicking a cluster means "show me this one"; no
      // second click on a collapsed bar. (Minimize is for hiding the card in matrix/other views.)
      const wasCollapsed = recCollapsed; recCollapsed = false; (p as any).recCollapsed = false;
      const prev = ctx.coord.state.selection;
      ctx.coord.setSelection({ kind: "category", grouping: base, value: grp });
      // re-clicking the already-selected row while collapsed dedupes in coord (reactor won't fire) → open it here
      if (wasCollapsed && prev && prev.kind === "category" && prev.value === grp) { selCluster = grp; const wl = grpWork.get(grp); if (wl) showRecord(wl); }
      host.focus({ preventScroll: true });
    });
  });
  // ↑/↓ move the SELECTED cluster (not scroll the div); Enter = a click (open/expand the card for that row).
  // Focus the table on click so the keys take over; the selection drives the card + embedding, and we scroll
  // just the selected row into view.
  const grpOrder = rows.map((r) => r.group);
  host.tabIndex = 0; host.style.outline = "none";
  host.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {   // open/expand the record card for the selected row (esp. after minimizing it)
      e.preventDefault(); if (selCluster == null) return;
      recCollapsed = false; (p as any).recCollapsed = false;
      const wl = grpWork.get(selCluster); if (wl) showRecord(wl);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();   // override the default scroll-the-whole-div behaviour
    const cur = selCluster != null ? grpOrder.indexOf(selCluster) : -1;
    const next = Math.max(0, Math.min(grpOrder.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
    const grp = grpOrder[next]; if (grp == null) return;
    ctx.coord.setSelection({ kind: "category", grouping: base, value: grp });
    host.querySelector<HTMLElement>(`tr.rcrow[data-grp="${CSS.escape(grp)}"]`)?.scrollIntoView({ block: "nearest" });
  });
  // matrix view: a confusion grid between two chosen layers (row-normalized intensity). A/B default to the
  // first two layers; dropdowns re-render locally. Reveals the cross-vocabulary mapping the table can't.
  let mA = layers[0]?.name, mB = layers[1]?.name;
  const renderMatrix = () => {
    const A = layers.find((l) => l.name === mA), B = layers.find((l) => l.name === mB);
    if (!A || !B) { mhost.innerHTML = '<span style="color:var(--faint)">need two layers</span>'; return; }
    const ct = crosstab({ codes: A.codes, categories: A.categories }, { codes: B.codes, categories: B.categories });
    const sel = (val: string, id: string) => `<select data-ax="${id}" class="inline" style="font-size:11px">${layers.map((l) => `<option${l.name === val ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select>`;
    let h = `<div style="margin-bottom:6px;font-size:11px;color:var(--faint)">rows ${sel(mA!, "a")} × cols ${sel(mB!, "b")} <span style="margin-left:4px">cell = #cells; shade = row %</span></div>`;
    h += `<table style="border-collapse:collapse;font-size:10px"><thead><tr><th></th>${ct.cols.map((c) => `<th style="padding:2px 3px;font-weight:400;color:var(--faint);writing-mode:vertical-rl;transform:rotate(180deg);max-height:90px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(c)}">${esc(c.length > 16 ? c.slice(0, 15) + "…" : c)}</th>`).join("")}</tr></thead><tbody>`;
    ct.counts.forEach((row, ri) => {
      const tot = ct.rowTotals[ri] || 1;
      h += `<tr><td style="padding:2px 6px 2px 0;color:var(--dim);white-space:nowrap;text-align:right;max-width:140px;overflow:hidden;text-overflow:ellipsis" title="${esc(ct.rows[ri])}">${esc(ct.rows[ri])} <span style="color:var(--faint)">${tot}</span></td>${row.map((c, ci) => { const f = c / tot; return `<td class="${c ? "mcell" : ""}" data-r="${ri}" data-c="${ci}" style="text-align:center;padding:2px 4px;color:${f > 0.5 ? "#0d1117" : "var(--dim)"};background:${c ? `rgba(92,200,255,${(0.1 + f * 0.85).toFixed(2)})` : ""}${c ? ";cursor:pointer" : ""}" title="${c} cells${c ? " — click to select these cells" : ""}">${c || ""}</td>`; }).join("")}</tr>`;
    });
    h += `</tbody></table>`;
    mhost.innerHTML = h;
    mhost.querySelectorAll<HTMLSelectElement>("select[data-ax]").forEach((s) => s.onchange = () => { if (s.dataset.ax === "a") mA = s.value; else mB = s.value; renderMatrix(); });
    // click a matrix cell → select the A∩B intersection AND offer to label it (via onSelect → selpop). This is
    // the answer to "labels don't map to the same clusters": reconcile by INTERSECTION, not by base cluster —
    // isolate the cells where A says X but B says Y, see them spatially, then label that exact set directly.
    mhost.querySelectorAll<HTMLElement>("td.mcell").forEach((td) => td.addEventListener("click", () => {
      const ri = +td.dataset.r!, ci = +td.dataset.c!; const ids: number[] = [];
      const n = Math.min(A.codes.length, B.codes.length);
      for (let i = 0; i < n; i++) if (A.codes[i] === ri && B.codes[i] === ci) ids.push(i);
      if (ids.length) { const r = td.getBoundingClientRect(); hooks.onSelect(Int32Array.from(ids), { left: r.left, top: r.top }); }
    }));
  };
  const applyMode = () => {
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", (x as HTMLElement).dataset.m === mode));
    host.style.display = mode === "table" ? "" : "none"; mhost.style.display = mode === "matrix" ? "" : "none"; lhost.style.display = mode === "labels" ? "" : "none";
    if (mode === "matrix") renderMatrix(); else if (mode === "labels") renderLabels();
  };
  seg.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.onclick = () => { mode = b.dataset.m as any; (p as any).reconMode = mode; applyMode(); });

  return { el: w, afterAttach: () => {
    const pb = w.parentElement as HTMLElement | null; if (pb) { pb.style.position = "relative"; if (pb.clientHeight < 80) pb.style.height = "320px"; }
    if (mode !== "table") applyMode();   // restore the persisted view (matrix/labels) on re-render instead of snapping to table
    hooks.registerComposition({ grouping: base, setSelect: (v) => { selRows = v; selCluster = v && v.size === 1 ? [...v][0] : null; paint(); }, setHover: (v) => { if (!selRows?.size) { selRows = v; paint(); } } });
    // a selected cluster's WORKING label drives the folded record detail (translate the selection into the draft).
    // The base reactor above runs first (registration order), so selCluster is set before showRecord reads it.
    hooks.registerComposition({ grouping: "annotation", setSelect: (labels) => { if (labels && labels.size) {
      // dismiss an OPEN edit field (e.g. the rename input) when the selection changes — but do NOT blur the
      // focused table host, or keyboard ↑/↓ navigation dies after the first press.
      const ae = document.activeElement as HTMLElement | null; if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) ae.blur();
      showRecord([...labels][0]);
    } }, setHover: () => {} });
    showRecord(null);   // initial: nothing selected → the record card stays hidden
  } };
}

// Render the CAP record form for ONE label into `host` (dark-themed, matches the app). Shared by the
// reconcile panel's detail section and the standalone record panel. CAP schema (celltype.info): name/full
// name, Cell-Ontology term (live OLS lookup), parent category, marker evidence (auto from derived markers),
// canonical markers, rationale. Edits persist to the layer; export → JSON. opts.picker adds a label dropdown.
async function renderCapRecord(host: HTMLElement, layer: AnnotationLayer, label: string, ctx: Ctx, hooks: PanelHooks, opts?: { picker?: boolean; onPick?: (l: string) => void; onRename?: (to: string) => void; context?: string; accept?: { cluster: string; current: string; options: { label: string; sources: string[] }[]; onAccept: (lab: string) => void }; onCollapse?: () => void }): Promise<void> {
  const layerName = layer.name; layer.records = layer.records || {};
  const rec: CapRecord = { ...(layer.records[label] || {}), label };
  host.dataset.recLabel = label;   // staleness tag: a slow async fill must not overwrite a card the user has since switched away from
  // NOTE: do NOT await markers here — that DE call blocks the whole card (the "took a while to pop up" lag).
  // Render the form now with whatever evidence we have; fill it asynchronously below.
  const haveEvidence = !!(rec.markerEvidence && rec.markerEvidence.length);
  // genes are clickable chips → colour the embedding by that gene's expression (hooks.onGeneClick). Used for
  // marker evidence (auto) and canonical markers — so you can eyeball a marker's pattern without leaving the card.
  const geneChip = (g: string) => `<span class="genechip" data-gene="${esc(g)}" title="colour the embedding by ${esc(g)} expression" style="font-family:var(--mono);font-size:11px;border:1px solid var(--line2);border-radius:5px;padding:1px 6px;margin:0 4px 4px 0;display:inline-block;cursor:pointer">${esc(g)}</span>`;
  const geneChips = (arr: string[]) => arr.map(geneChip).join("");
  // hierarchy breadcrumb: coarsest ▸ … ▸ leaf (the leaf bold). Derived live from the lineage path in `category`.
  const crumb = (cat?: string) => labelChain(label, cat).map((t, i, a) => i === a.length - 1 ? `<b style="color:var(--dim);font-weight:600">${esc(t)}</b>` : `<span style="color:var(--faint)">${esc(t)}</span>`).join(' <span style="color:var(--line)">▸</span> ');
  const counts = new Int32Array(layer.categories.length); for (const c of layer.codes) if (c >= 0) counts[c]++;
  const idx = layer.categories.indexOf(label); const n = idx >= 0 ? counts[idx] : 0;
  const live = layer.categories.filter((c, i) => counts[i] > 0 || c === label);
  const dot = `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:rgb(${catColor(ctx.labelColorIndex(label)).join(",")})"></span>`;
  const head = opts?.picker
    ? `<select id="arlabel" class="inline" style="font-size:13px;font-weight:600;max-width:220px">${live.map((c) => `<option${c === label ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>`
    : dot + (opts?.onRename
      ? `<input id="arname" value="${esc(label)}" title="rename this label — type an existing label to merge" style="font-size:13px;font-weight:500;width:180px">`
      : `<b style="font-size:13px">${esc(label)}</b>`);
  const suggestedBadge = rec.suggested ? `<span id="arsug" title="the agent proposed this — review & edit, then it's yours" style="color:var(--amber,#e0a458);font-size:10px;border:1px solid var(--amber,#e0a458);border-radius:5px;padding:0 5px">✨ suggested</span>` : "";
  host.innerHTML = `
   <div style="max-width:720px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">${head}
      <span style="color:var(--faint);font-size:11px">${n} cells</span>
      ${suggestedBadge}
      <span id="arsaved" style="color:var(--good,#6bbf73);font-size:11px;opacity:0;transition:opacity .2s">saved ✓</span>
      <button id="arsuggest" class="mini" title="ask the agent to propose a name, category, ontology term, markers + rationale from this cluster's genes" style="margin-left:auto;border-color:var(--amber,#e0a458);color:var(--amber,#e0a458)">✨ Suggest</button>
      ${opts?.onCollapse ? `<button id="armin" class="mini" title="hide the record (more room for the table / matrix)" style="padding:3px 8px">▾</button>` : ""}</div>
    ${opts?.context ? `<div style="font-size:10.5px;color:var(--faint);margin:-4px 0 8px">${opts.context}</div>` : ""}
    ${opts?.accept ? `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 9px;font-size:11px"><span style="color:var(--faint)">set from source:</span>${opts.accept.options.map((o, i) => { const on = o.label === opts.accept!.current; return `<button class="mini rcacc" data-acc="${i}" title="set ${esc(opts!.accept!.cluster)}'s working label to “${esc(o.label)}” (${esc(o.sources.join(", "))})"${on ? " disabled" : ""} style="${on ? "border-color:var(--good,#6bbf73);color:var(--good,#6bbf73)" : ""}">${esc(o.label)} ${on ? "✓" : `<span style="color:var(--faint)">· ${esc(o.sources.join(","))}</span>`}</button>`; }).join("")}</div>` : ""}
    <div style="display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:11px">
      <span style="color:var(--faint);flex:0 0 auto">hierarchy</span>
      <span id="ar_crumb" style="flex:1 1 auto;min-width:0;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${crumb(rec.category)}</span>
      <input id="ar_cat" value="${esc(rec.category || "")}" placeholder="broader › … (coarse to fine)" title="coarser categories as a coarse › fine path, e.g. 'Myeloid › Monocyte' — defines L1/L2 levels you can colour by; leave blank for a flat annotation" style="flex:0 0 200px;font-size:11px">
    </div>
    <div style="display:flex;gap:16px;font-size:12px;align-items:stretch">
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:8px">
        <label>full name<input id="ar_full" value="${esc(rec.fullName || "")}"></label>
        <label>ontology · Cell Ontology
          <span style="display:flex;gap:6px"><input id="ar_oid" value="${esc(rec.ontologyTermId || "")}" placeholder="CL:…" style="flex:0 0 92px"><input id="ar_oterm" value="${esc(rec.ontologyTerm || "")}" placeholder="term name" style="flex:1;min-width:0"><button id="ar_ols" class="mini">lookup</button></span>
          <div id="ar_olshits"></div></label>
        <label style="flex:1 1 auto;min-height:0">rationale<textarea id="ar_rat" style="resize:vertical;min-height:58px;flex:1 1 auto">${esc(rec.rationale || "")}</textarea></label>
      </div>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:8px">
        <label>marker evidence <span style="color:var(--faint)">· this dataset (click to colour)</span>
          <div id="ar_mev">${haveEvidence ? geneChips(rec.markerEvidence || []) : '<span style="color:var(--faint);font-size:11px">computing…</span>'}</div></label>
        <label>canonical markers <span style="color:var(--faint)">(click to colour)</span>
          <input id="ar_canon" value="${esc((rec.canonicalMarkers || []).join(", "))}" placeholder="comma-separated">
          <div id="ar_canonchips">${geneChips(rec.canonicalMarkers || [])}</div></label>
      </div>
    </div>
    ${opts?.onRename ? `<div style="display:flex;align-items:center;gap:7px;margin-top:10px;border-top:1px solid var(--line2);padding-top:9px">
      <button id="ar_split" class="mini" title="isolate this label's cells, then brush a subset to break out as a new label">⋔ split…</button>
      <button id="ar_merge" class="mini" title="merge this label into another working label">⋃ merge into…</button>
      <select id="ar_mergesel" class="inline" style="display:none;font-size:11px"></select>
      <span style="margin-left:auto;color:var(--faint);font-size:10.5px">the working draft is the finest level</span>
    </div>` : ""}</div>`;
  host.querySelectorAll<HTMLElement>("label").forEach((l) => l.style.cssText = "display:flex;flex-direction:column;gap:3px;color:var(--faint);font-size:11px");
  const val = (id: string) => (host.querySelector("#" + id) as HTMLInputElement | null)?.value || "";
  const flash = () => { const s = host.querySelector("#arsaved") as HTMLElement | null; if (s) { s.style.opacity = "1"; setTimeout(() => { s.style.opacity = "0"; }, 1200); } };
  const save = () => { hooks.annotation.saveRecord(layerName, { label, fullName: val("ar_full"), category: val("ar_cat"), ontologyTermId: val("ar_oid"), ontologyTerm: val("ar_oterm"), canonicalMarkers: val("ar_canon").split(",").map((s) => s.trim()).filter(Boolean), rationale: val("ar_rat"), markerEvidence: rec.markerEvidence }); flash(); };
  host.querySelectorAll("input:not(#arname),textarea").forEach((i) => i.addEventListener("change", save));
  // click any gene chip (marker evidence / canonical) → colour the embedding by that gene's expression.
  // onclick (NOT addEventListener): renderCapRecord re-runs on the SAME persistent host every card re-render —
  // addEventListener would stack a new listener each time, firing N times per click (N duplicate toasts).
  host.onclick = (e) => { const c = (e.target as HTMLElement).closest(".genechip") as HTMLElement | null; if (c?.dataset.gene) hooks.onGeneClick(c.dataset.gene); };
  // edited canonical markers → refresh the clickable chips to match
  (host.querySelector("#ar_canon") as HTMLInputElement | null)?.addEventListener("input", () => { const box = host.querySelector("#ar_canonchips") as HTMLElement | null; if (box) box.innerHTML = geneChips(val("ar_canon").split(",").map((s) => s.trim()).filter(Boolean)); });
  // edited hierarchy path → live-update the breadcrumb (the change-event saves it + rebuilds the level groupings)
  (host.querySelector("#ar_cat") as HTMLInputElement | null)?.addEventListener("input", () => { const c = host.querySelector("#ar_crumb") as HTMLElement | null; if (c) c.innerHTML = crumb(val("ar_cat")); });
  if (opts?.picker) (host.querySelector("#arlabel") as HTMLSelectElement).onchange = (e) => { save(); opts.onPick?.((e.target as HTMLSelectElement).value); };
  if (opts?.onRename) { const ni = host.querySelector("#arname") as HTMLInputElement; ni.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") ni.blur(); }); ni.addEventListener("change", () => { const v = ni.value.trim(); if (v && v !== label) opts.onRename!(v); }); }
  (host.querySelector("#ar_ols") as HTMLButtonElement).onclick = async () => {
    const box = host.querySelector("#ar_olshits") as HTMLElement; box.innerHTML = '<span style="color:var(--faint);font-size:11px">searching OLS…</span>';
    const hits = await olsLookup(label);
    box.innerHTML = hits.length ? hits.map((h) => `<div class="olshit" data-id="${esc(h.id)}" data-label="${esc(h.label)}" style="cursor:pointer;padding:2px 4px;font-size:11px;border-radius:4px"><b style="color:var(--cyan)">${esc(h.id)}</b> ${esc(h.label)}</div>`).join("") : '<span style="color:var(--faint);font-size:11px">no CL match (or offline) — enter manually</span>';
    box.querySelectorAll<HTMLElement>(".olshit").forEach((el) => el.onclick = () => { (host.querySelector("#ar_oid") as HTMLInputElement).value = el.dataset.id!; (host.querySelector("#ar_oterm") as HTMLInputElement).value = el.dataset.label!; save(); box.innerHTML = ""; });
  };
  const sug = host.querySelector("#arsuggest") as HTMLButtonElement;
  sug.onclick = () => { sug.disabled = true; sug.textContent = "✨ thinking…"; save(); hooks.annotation.proposeRecord(layerName, label); };   // save current edits, then let the agent propose (re-renders on propose_label)
  const minBtn = host.querySelector("#armin") as HTMLButtonElement | null; if (minBtn && opts?.onCollapse) minBtn.onclick = () => { save(); opts.onCollapse!(); };
  // SPLIT: isolate this label's cells (focus), then the user brushes a subset + labels it (the rest stay). MERGE:
  // pick another working label → rename-to-existing collapses the two (the existing merge path).
  const splitBtn = host.querySelector("#ar_split") as HTMLButtonElement | null; if (splitBtn) splitBtn.onclick = () => hooks.annotation.splitLabel(label);
  const mergeBtn = host.querySelector("#ar_merge") as HTMLButtonElement | null; const mergeSel = host.querySelector("#ar_mergesel") as HTMLSelectElement | null;
  if (mergeBtn && mergeSel) {
    const others = layer.categories.filter((c) => c !== label && layer.codes.some((x) => x === layer.categories.indexOf(c)));
    mergeBtn.onclick = () => { if (!others.length) return; mergeSel.innerHTML = `<option value="">merge “${esc(label)}” into…</option>` + others.map((c) => `<option>${esc(c)}</option>`).join(""); mergeBtn.style.display = "none"; mergeSel.style.display = ""; mergeSel.focus(); };
    mergeSel.onchange = () => { const to = mergeSel.value; if (to) hooks.annotation.renameLabel("annotation", label, to); };
  }
  if (opts?.accept) host.querySelectorAll<HTMLButtonElement>(".rcacc").forEach((b) => b.onclick = () => { const o = opts.accept!.options[+b.dataset.acc!]; if (o) opts.accept!.onAccept(o.label); });
  // fill marker evidence asynchronously (the DE call is slow — don't block the card). Staleness-guarded: if the
  // user has switched the card to another label by the time markers resolve, drop this update.
  if (!haveEvidence) {
    ctx.markers(layerName).then((mm: any) => {
      if (host.dataset.recLabel !== label) return;   // user moved on — stale
      const ev = (mm.get(label) || []).slice(0, 8).map((m: any) => m.symbol);
      rec.markerEvidence = ev;
      const box = host.querySelector("#ar_mev") as HTMLElement | null;
      if (box) box.innerHTML = ev.length ? geneChips(ev) : '<span style="color:var(--faint);font-size:11px">no markers</span>';
    }).catch(() => {});
  }
}

// Export every working-draft label as CAP-schema JSON. Rare (full annotations only) — lives in the labels
// OVERVIEW header (the review-before-deposit view), not on the per-label card.
async function exportCap(layer: AnnotationLayer, ctx: Ctx): Promise<void> {
  const mm = await ctx.markers(layer.name);
  const recs = layer.categories.map((c) => ({ ...((layer.records || {})[c] || {}), label: c, markerEvidence: ((layer.records || {})[c]?.markerEvidence) || (mm.get(c) || []).slice(0, 8).map((m: any) => m.symbol) }));
  const blob = new Blob([JSON.stringify(recs, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "annotation_cap.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Standalone record panel (optional) — a label picker + the shared CAP form, following the selection.
async function annoRecordBody(p: Panel, ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  const layer = hooks.annotation.annoLayer("annotation");
  if (!layer || !layer.categories.length) { const m = mk("div", "panelerr"); m.textContent = "No working annotation yet — accept labels in the Reconcile panel first."; return { el: m }; }
  const w = mk("div"); w.style.cssText = "position:absolute;inset:0;overflow:auto;font-size:12px;padding:10px 12px";
  let current = (p as any).recordLabel && layer.categories.includes((p as any).recordLabel) ? (p as any).recordLabel : layer.categories[0];
  const draw = () => renderCapRecord(w, layer, current, ctx, hooks, { picker: true, onPick: (l) => { current = l; (p as any).recordLabel = l; draw(); } });
  await draw();
  return { el: w, afterAttach: () => {
    const pb = w.parentElement as HTMLElement | null; if (pb) { pb.style.position = "relative"; if (pb.clientHeight < 80) pb.style.height = "300px"; }
    hooks.registerComposition({ grouping: "annotation", setSelect: (labels) => { if (!labels || !labels.size) return; const lab = [...labels][0]; if (lab === current || !layer.categories.includes(lab)) return; (document.activeElement as HTMLElement | null)?.blur?.(); current = lab; (p as any).recordLabel = lab; draw(); }, setHover: () => {} });
  } };
}

async function overdispBody(ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  // gene programs (aspects) are an optional pipeline product — many datasets (e.g. this PBMC store) lack them.
  // Show a clear notice instead of throwing, so the panel degrades gracefully rather than breaking the render.
  if (!ctx.view.ds.axisNames().includes("aspects") || !ctx.view.ds.hasField("aspect_adjvar")) {
    const m = mk("div", "panelerr"); m.textContent = "No gene programs (aspects) were computed for this dataset.";
    return { el: m };
  }
  const names = await ctx.view.ds.axisLabels("aspects");
  const adj = (await ctx.view.ds.fieldDense("aspect_adjvar")).data as Float32Array;
  const order = names.map((n, i) => ({ n, v: adj[i] })).sort((a, b) => b.v - a.v);
  const t = document.createElement("table");
  t.innerHTML = `<thead><tr><th>program</th><th>adj.var</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const o of order) {
    const on = ctx.coord.state.colorBy === `geneset:${o.n}`;
    const tr = mk("tr", "gene" + (on ? " on" : ""));
    tr.innerHTML = `<td style="text-align:left">${o.n}</td><td>${o.v.toFixed(1)}</td>`;
    tr.onclick = () => { [...tb.children].forEach((x) => x.classList.remove("on")); tr.classList.add("on"); ctx.coord.setColor(`geneset:${o.n}`); };
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  return { el: t };
}

// Per-donor concordance heat (gene × donor mean expression, row-normalised). A marker reading the SAME across
// donors = a genuinely merged cell type; bright in one donor and dim in the other = residual batch / divergence.
function splitHeatBody(p: Panel): BuiltBody {
  const d = p.split; if (!d || !d.genes.length || !d.levels.length) return { el: mk("div", undefined, "no split data") };
  const D = d.levels.length, padL = 96, padT = 26, cw = Math.max(42, Math.min(70, (320 - padL) / D)), rh = 17;
  const W = padL + D * cw + 6, H = padT + d.genes.length * rh + 6;
  let g = "";
  d.levels.forEach((lv, j) => { const short = lv.length > 9 ? "…" + lv.slice(-6) : lv; g += `<text class="axis" x="${padL + j * cw + cw / 2}" y="${padT - 9}" text-anchor="middle">${esc(short)}</text>`; });
  d.genes.forEach((gene, i) => {
    const row = d.means[i], mx = Math.max(...row, 1e-9);
    g += `<text class="axis" x="${padL - 6}" y="${padT + i * rh + rh - 5}" text-anchor="end">${esc(gene)}</text>`;
    row.forEach((v, j) => { const t = v / mx;
      g += `<rect x="${padL + j * cw}" y="${padT + i * rh}" width="${cw - 2}" height="${rh - 2}" rx="1" fill="${ramp(t)}"/>`;
      // value label: dark on the bright (high-t) cells, faint grey on the pale low cells — both flipped per theme
      const txt = t > 0.55 ? (themeIsDark() ? "#0d1117" : "#2a1c08") : (themeIsDark() ? "#7d8a9a" : "#8a8576");
      g += `<text x="${padL + j * cw + cw / 2}" y="${padT + i * rh + rh - 5}" text-anchor="middle" style="font-size:8px;font-family:var(--mono)" fill="${txt}">${v.toFixed(1)}</text>`;
    });
  });
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}` }); svg.innerHTML = g; (svg as any).style.cssText = "width:100%;height:auto;max-width:340px";
  const w = mk("div"); w.appendChild(svg); return { el: w };
}

async function heatmapBody(p: Panel, ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  const grouping = p.group || ctx.defaultGrouping();
  const markers = await ctx.markers(grouping);   // ROWS: all-cell markers — shared across scopes so two faceted panels align
  // FACETING: if the panel is scoped (e.g. condition=day0), compute the dots WITHIN that population. Columns stay in
  // the grouping's full order, so two scoped panels (day0 / day7) share identical rows AND columns — directly comparable.
  const scope = p.view?.scope as any;
  const scopeCells = scope ? ctx.refToCells(scope) : null;
  const scoped = !!(scopeCells && scopeCells.length);
  const scopeLabel = scoped ? (scope.kind === "category" ? scope.value : `${scopeCells!.length} cells`) : "";
  const gs = scoped
    ? await ctx.groupStatsForCells(grouping, scopeCells!, scope.kind === "category" ? `${scope.grouping}=${scope.value}` : undefined)
    : await ctx.groupStatsCached(grouping);
  // top 3 genes per group, unique
  const seen = new Set<number>(); const markerRows: { gene: number; symbol: string; pinned?: boolean }[] = [];
  for (const grp of gs.groups) for (const m of (markers.get(grp) || []).slice(0, 3)) if (!seen.has(m.gene)) { seen.add(m.gene); markerRows.push({ gene: m.gene, symbol: m.symbol }); }
  // pinned custom genes (agent/user added) — resolved to indices, placed FIRST and highlighted; any marker dup is
  // folded in. A requested gene that isn't in this dataset is collected into `missing` and shown as a panel
  // footnote, so an unmeasured request (e.g. IL17B in a panel that lacks it) gives visible feedback, not silence.
  const pinnedRows: { gene: number; symbol: string; pinned?: boolean }[] = []; const pinnedSet = new Set<number>(); const missing: string[] = [];
  if (p.genes?.length) { await ctx.view.genes();
    for (const sym of p.genes) { const gi = await ctx.view.geneCol(sym); if (gi == null) { if (!missing.includes(sym)) missing.push(sym); continue; } if (pinnedSet.has(gi)) continue; pinnedSet.add(gi); pinnedRows.push({ gene: gi, symbol: sym, pinned: true }); } }
  const rows = [...pinnedRows, ...markerRows.filter((r) => !pinnedSet.has(r.gene))];
  const nPinned = pinnedRows.length;
  const G = gs.groups.length, R = rows.length, x0 = 70, y0 = 6;
  const s = resolvePanelStyleFor(ctx, "Heatmap", p.view);   // the panel's resolved style (dot/cell/font/ramp/highlight)
  const xLabMax = Math.max(1, ...gs.groups.map((s) => s.length));   // longest column label — drives rotate vs horizontal
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  let mode: "heat" | "dot" = p.heatMode === "heat" ? "heat" : "dot";   // dotplot is the default; "heat" only when explicitly set
  // cross-panel coordination state: which groups (columns) are selected / hovered elsewhere, translated into THIS
  // panel's grouping by the App (registerComposition). geomCw/geomCh are the live column size, set by draw().
  let selGroups: Set<string> | null = null, hovGroups: Set<string> | null = null, geomCw = 0, geomCh = 0;
  let hovGene: string | null = null;   // a gene hovered in ANOTHER dotplot (coord.geneHint) → highlight its row here

  // Responsive: the grid is re-laid to fill the panel — cell size derives from the live width/height and
  // re-draws on resize. Axis labels stay faint and are read on hover, so dense rows remain fine.
  const w = mk("div"); w.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden";   // fills the panel, out of flow → can't grow it
  if (missing.length) {   // click to dismiss — drops the unmeasured genes from the panel's pins so they don't reappear
    const warn = mk("div"); warn.style.cssText = "flex:0 0 auto;font-size:10.5px;color:var(--amber,#e0a458);padding:5px 8px 0;line-height:1.4;cursor:pointer";
    warn.title = "click to dismiss"; warn.innerHTML = `⚠ not in this dataset: ${esc(missing.join(", "))} <span style="opacity:.55">✕</span>`;
    warn.onclick = () => hooks.onConfigurePanel(p.id, { genes: (p.genes || []).filter((g) => !missing.includes(g)) });
    w.appendChild(warn);
  }
  const host = mk("div"); host.style.cssText = "flex:1 1 auto;min-height:0;overflow:auto"; w.appendChild(host);
  const tip = mk("div"); tip.style.cssText = "position:absolute;display:none;background:var(--ink);border:1px solid var(--line2);border-radius:6px;padding:3px 8px;font-size:11px;color:var(--text);pointer-events:none;z-index:20;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.45)";
  w.appendChild(tip);
  const hint = mk("div"); hint.style.cssText = "flex:0 0 auto;font-size:10.5px;color:var(--faint);padding:5px 7px 2px;line-height:1.4";
  hint.textContent = (scoped ? `within ${scopeLabel} · ` : "") + "hover to read mean & % expressing · dot size = % expressing · click a gene to colour";
  w.appendChild(hint);
  const showTip = (e: PointerEvent, html: string) => {
    tip.innerHTML = html; tip.style.display = "block";
    const r = w.getBoundingClientRect(); let x = e.clientX - r.left + 13;
    if (x + tip.offsetWidth > r.width - 4) x = e.clientX - r.left - tip.offsetWidth - 8;
    tip.style.left = Math.max(2, x) + "px"; tip.style.top = (e.clientY - r.top + 13) + "px";
  };

  // Cross-panel reaction: tint the columns whose group is selected/hovered elsewhere (translated into this
  // panel's grouping by the App), and lift their labels. Cheap — only rewrites the overlay group + label styles,
  // so it re-applies on every hover/selection tick without a full redraw. draw() also calls it after a re-lay.
  const paintCols = () => {
    const svg = host.querySelector("svg"); if (!svg) return;
    const hl = svg.querySelector(".hcolhl"); if (!hl) return;
    let hlSvg = "";
    gs.groups.forEach((grp, c) => {
      const sel = !!selGroups?.has(grp), hov = !sel && !!hovGroups?.has(grp);
      if (sel || hov) hlSvg += `<rect x="${(x0 + c * geomCw).toFixed(1)}" y="${y0}" width="${geomCw.toFixed(1)}" height="${(R * geomCh).toFixed(1)}" fill="rgba(92,200,255,${sel ? s.highlight.selOpacity : s.highlight.hovOpacity})" pointer-events="none"/>`;
    });
    hl.innerHTML = hlSvg;
    svg.querySelectorAll<SVGElement>(".hgrp").forEach((el) => { const grp = gs.groups[+el.getAttribute("data-c")!]; const sel = !!selGroups?.has(grp), hov = !sel && !!hovGroups?.has(grp); el.style.fill = sel ? "var(--cyan)" : ""; el.style.fontWeight = sel ? "600" : ""; el.style.opacity = sel || hov ? "1" : ""; });
  };

  // Cross-panel GENE hover: highlight the row whose gene matches coord.geneHint (set when a cell is hovered in any
  // dotplot) + lift its label. Together with paintCols, a hover in one dotplot shows the full row+column crosshair here.
  const paintGeneRow = () => {
    const svg = host.querySelector("svg"); if (!svg) return;
    const hl = svg.querySelector(".hrowhl"); if (!hl) return;
    const ri = hovGene ? rows.findIndex((r) => r.symbol === hovGene) : -1;
    hl.innerHTML = ri >= 0 ? `<rect x="${x0}" y="${(y0 + ri * geomCh).toFixed(2)}" width="${(G * geomCw).toFixed(1)}" height="${geomCh.toFixed(2)}" fill="rgba(92,200,255,0.14)" pointer-events="none"/>` : "";
    svg.querySelectorAll<SVGElement>(".hgene").forEach((el) => { const r = rows[+el.getAttribute("data-ri")!]; if (r.pinned) return; const on = hovGene != null && r.symbol === hovGene; el.style.fontWeight = on ? "600" : ""; el.style.opacity = on ? "1" : ""; });
  };

  // scale each gene row to its max-across-groups for contrast; cells/labels carry their row+col index so
  // hover can read the names. Re-runs on resize against the panel body's live dimensions.
  const draw = () => {
    const availW = host.clientWidth - 4, availH = host.clientHeight - 2;   // the GIVEN box; w is absolute so the svg can never grow it
    const cw = clamp((availW - x0 - 6) / G, s.cell.colMin, s.cell.colMax);
    // x-axis labels: horizontal when they fit a column, else rotate −45° (scanpy/Seurat style) so every group
    // stays legible without thinning. Reserve bottom space for the rotated band, capped so it can't eat the plot.
    const estLabW = xLabMax * 5.4;   // ≈ mono char width at 9px
    const rotX = estLabW > cw - 1;
    const axisH = rotX ? clamp(estLabW * 0.72 + 10, 22, Math.max(40, availH * 0.42)) : 16;
    const ch = clamp((availH - y0 - axisH) / R, s.cell.rowMin, s.cell.rowMax);
    geomCw = cw; geomCh = ch;   // remember live column size so paintCols can place the highlight bands
    const W = x0 + G * cw + 6, H = y0 + R * ch + axisH;
    let g = "";
    const maxR = Math.max(1.4, Math.min(cw, ch) / 2 - 1.2) * s.dot.sizeScale;   // dot radius at 100% expressing (× a user size scale)
    // Adaptive label density (both axes): shrink the font to the available pitch first; when even the floor
    // font would collide, THIN (render every Nth label). Hover still reads any hidden label. FLOOR = legibility.
    const FLOOR = s.font.floor;
    const geneFs = Math.max(FLOOR, Math.min(s.font.max, ch * 0.92));                          // gene rows: fit the row height
    const grpPitch = rotX ? cw * 0.707 : cw;                                                  // (rotated) column labels: perpendicular spacing
    const grpFs = rotX ? Math.max(FLOOR, Math.min(s.font.max, grpPitch)) : Math.max(FLOOR, Math.min(s.font.max, (cw - 2) / Math.max(1, xLabMax) / 0.6));
    const grpStride = grpPitch >= FLOOR ? 1 : Math.max(1, Math.ceil(FLOOR / grpPitch));       // groups: hide every Nth when too dense
    const geneStride = ch >= FLOOR ? 1 : Math.max(1, Math.ceil(FLOOR / ch));                  // genes: same (rare — rows are ≥7px, then scroll)
    rows.forEach((r, ri) => {
      if (r.pinned) g += `<rect x="${x0.toFixed(1)}" y="${(y0 + ri * ch).toFixed(2)}" width="${(G * cw).toFixed(1)}" height="${(ch - 0.5).toFixed(2)}" fill="rgba(92,200,255,.12)" pointer-events="none"/>`;
      let mx = 1e-6; for (let c = 0; c < G; c++) mx = Math.max(mx, gs.mean[c * gs.nGenes + r.gene]);
      for (let c = 0; c < G; c++) { const t = Math.min(1, gs.mean[c * gs.nGenes + r.gene] / mx);
        if (mode === "dot") { const fr = gs.frac[c * gs.nGenes + r.gene]; const rad = Math.max(s.dot.minRadius, Math.sqrt(fr) * maxR);   // area ∝ fraction expressing
          // visible dot is decorative; a full-cell transparent rect on top carries the hover/click so even tiny dots stay hittable
          g += `<circle cx="${(x0 + c * cw + cw / 2).toFixed(2)}" cy="${(y0 + ri * ch + ch / 2).toFixed(2)}" r="${rad.toFixed(2)}" fill="${ramp(t, s.ramp)}" pointer-events="none"/>`;
          g += `<rect class="hcell" data-ri="${ri}" data-c="${c}" x="${(x0 + c * cw).toFixed(2)}" y="${(y0 + ri * ch).toFixed(2)}" width="${(cw - 0.5).toFixed(2)}" height="${(ch - 0.5).toFixed(2)}" fill="transparent" pointer-events="all"/>`; }
        else g += `<rect class="hcell" data-ri="${ri}" data-c="${c}" x="${(x0 + c * cw).toFixed(2)}" y="${(y0 + ri * ch).toFixed(2)}" width="${(cw - 0.5).toFixed(2)}" height="${(ch - 0.5).toFixed(2)}" fill="${ramp(t, s.ramp)}"/>`; }
      if (ri % geneStride === 0 || r.pinned) g += `<text class="axis hgene" data-ri="${ri}" x="${x0 - 4}" y="${(y0 + ri * ch + ch * 0.72).toFixed(1)}" text-anchor="end" style="font-size:${geneFs.toFixed(1)}px${r.pinned ? ";fill:var(--cyan);font-weight:600" : ""}">${r.pinned ? "● " : ""}${esc(r.symbol)}</text>`;
    });
    if (nPinned > 0 && nPinned < R) g += `<line x1="${x0.toFixed(1)}" y1="${(y0 + nPinned * ch).toFixed(1)}" x2="${(x0 + G * cw).toFixed(1)}" y2="${(y0 + nPinned * ch).toFixed(1)}" stroke="var(--cyan)" stroke-opacity="0.4" stroke-width="0.6"/>`;
    const bottomY = y0 + R * ch;
    const xFit = rotX ? Math.max(3, Math.floor((axisH - 8) / 0.72 / (grpFs * 0.6))) : 99;   // chars that fit the rotated band at the live font (rest ellipsised; hover gives full)
    gs.groups.forEach((grp, c) => {
      if (c % grpStride !== 0) return;   // thinned when very dense — the column + dots still render; hover reads the name
      const cx = x0 + c * cw + cw / 2;
      const lab = grp.length > xFit ? grp.slice(0, xFit - 1) + "…" : grp;
      g += rotX
        ? `<text class="axis hgrp" data-c="${c}" x="${cx.toFixed(1)}" y="${(bottomY + 4).toFixed(1)}" text-anchor="end" transform="rotate(-45 ${cx.toFixed(1)} ${(bottomY + 4).toFixed(1)})" style="font-size:${grpFs.toFixed(1)}px">${esc(lab)}</text>`
        : `<text class="axis hgrp" data-c="${c}" x="${cx.toFixed(1)}" y="${(bottomY + 11).toFixed(1)}" text-anchor="middle" style="font-size:${grpFs.toFixed(1)}px">${esc(lab)}</text>`;
    });
    g += `<g class="hrowhl"></g><g class="hcolhl"></g>`;   // cross-panel hovered gene-row band + selected/hovered column bands
    g += `<rect class="hrowg" x="${x0}" width="${(G * cw).toFixed(1)}" height="${ch.toFixed(1)}" fill="rgba(150,225,255,.14)" pointer-events="none" style="display:none"/>`;
    g += `<rect class="hcolg" y="${y0}" width="${cw.toFixed(1)}" height="${(R * ch).toFixed(1)}" fill="rgba(150,225,255,.14)" pointer-events="none" style="display:none"/>`;
    host.innerHTML = `<svg viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="${W.toFixed(1)}" height="${H.toFixed(1)}" style="display:block">${g}</svg>`;
    const svg = host.querySelector("svg")!;
    const rowg = svg.querySelector<SVGRectElement>(".hrowg")!, colg = svg.querySelector<SVGRectElement>(".hcolg")!;
    svg.addEventListener("pointerleave", () => { tip.style.display = "none"; rowg.style.display = colg.style.display = "none"; ctx.coord.clearHint(); ctx.coord.clearGeneHint(); });
    // two-tier coordination — HOVER: row/col guide + name readout + UMAP locator (no recolour); CLICK: commit.
    svg.querySelectorAll<SVGElement>(".hcell").forEach((el) => {
      const ri = +el.getAttribute("data-ri")!, c = +el.getAttribute("data-c")!, sym = rows[ri].symbol, grp = gs.groups[c]; el.style.cursor = "pointer";
      el.addEventListener("pointermove", (e) => { rowg.setAttribute("y", String(y0 + ri * ch)); colg.setAttribute("x", String(x0 + c * cw)); rowg.style.display = colg.style.display = "block";
        showTip(e as PointerEvent, `<b>${esc(sym)}</b> · ${esc(grp)} <span style="color:var(--faint)">mean ${gs.mean[c * gs.nGenes + rows[ri].gene].toFixed(2)} · ${(gs.frac[c * gs.nGenes + rows[ri].gene] * 100).toFixed(0)}% expr</span>`); ctx.coord.setHint({ kind: "category", grouping, value: grp }); ctx.coord.setGeneHint(sym); });
      el.addEventListener("click", () => hooks.onGeneClick(sym));
    });
    svg.querySelectorAll<SVGElement>(".hgene").forEach((el) => {
      const ri = +el.getAttribute("data-ri")!, sym = rows[ri].symbol; el.style.cursor = "pointer";
      el.addEventListener("pointermove", (e) => { rowg.setAttribute("y", String(y0 + ri * ch)); rowg.style.display = "block"; colg.style.display = "none"; showTip(e as PointerEvent, `<b>${esc(sym)}</b>`); ctx.coord.setGeneHint(sym); });
      el.addEventListener("click", () => hooks.onGeneClick(sym));
    });
    svg.querySelectorAll<SVGElement>(".hgrp").forEach((el) => {
      const c = +el.getAttribute("data-c")!, grp = gs.groups[c]; el.style.cursor = "pointer";
      el.addEventListener("pointermove", (e) => { colg.setAttribute("x", String(x0 + c * cw)); colg.style.display = "block"; rowg.style.display = "none"; showTip(e as PointerEvent, `<b>${esc(grp)}</b>`); ctx.coord.setHint({ kind: "category", grouping, value: grp }); });
      el.addEventListener("click", () => ctx.coord.setSelection({ kind: "category", grouping, value: grp }));   // commit a selection (clusters/cell types coordinate everywhere)
    });
    paintCols(); paintGeneRow();   // re-apply cross-panel highlights after the (re)layout
  };

  const afterAttach = () => {
    const pb = w.parentElement as HTMLElement | null;
    // the heatmap fills a GIVEN box and (being absolute) can never grow it. Canvas bodies are sized by the
    // grid; rail cards aren't, so give those a bounded height rather than letting the heatmap stretch them.
    if (pb) { pb.style.position = "relative"; if (pb.clientHeight < 80) pb.style.height = "300px"; }
    draw();
    // react to cross-panel selection + hover like the composition panel: the App translates the current
    // selection/hint into THIS panel's grouping and calls setSelect/setHover, which tint the matching columns.
    hooks.registerComposition({ grouping, setSelect: (v) => { selGroups = v; paintCols(); }, setHover: (v) => { hovGroups = v; paintCols(); } });
    hooks.registerGeneHover((sym) => { hovGene = sym; paintGeneRow(); });   // another dotplot hovered a gene → highlight its row here
    let ro: ResizeObserver;
    ro = new ResizeObserver(() => { if (!w.isConnected) ro.disconnect(); else draw(); });   // re-fill on resize; self-cleans
    if (pb) ro.observe(pb);
  };
  // header toggle: heatmap (colour grid) ↔ dotplot (dot size = % expressing). Redraws in place; mode persists on the panel.
  const toggle = mk("div", "segtog");
  const setMode = (m: "heat" | "dot") => { if (mode === m) return; mode = m; p.heatMode = m; toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-m") === m)); draw(); };
  for (const [m, label] of [["heat", "heat"], ["dot", "dot"]] as const) {
    const b = mk("button", "mini" + (mode === m ? " on" : ""), label) as HTMLButtonElement;
    b.setAttribute("data-m", m); b.title = m === "dot" ? "dotplot — dot size = % of cells expressing, colour = mean" : "heatmap — colour = mean expression";
    b.onclick = () => setMode(m); toggle.appendChild(b);
  }
  return { el: w, afterAttach, headerControls: toggle };
}

// dotplot/heatmap fill ramp — theme-aware: on dark, low fades into the dark canvas (slate→amber); on white, low
// fades into white (paper→deep orange), so low expression stays faint and high reads, instead of inverting.
function ramp(t: number, override?: { lo: number[]; hi: number[] }): string {
  const dark = themeIsDark();
  const a = override?.lo || (dark ? [27, 34, 48] : [244, 240, 228]), b = override?.hi || (dark ? [224, 164, 88] : [186, 96, 22]);
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`;
}

// ── Built-in panel-type registrations ── (the old hardcoded `bodyFor` switch + agent.ts REGISTRY, now a registry the
// core looks up; `agent:true` = the model may add/reference it. An EXTERNAL module registers itself the same way —
// zero edits here. Body signatures are normalized to (p, ctx, hooks).)
registerPanelType({ type: "Embedding", body: embeddingBody, agent: true });
registerPanelType({ type: "DeTable", body: deBody, agent: true });
registerPanelType({ type: "Volcano", body: (p, ctx) => volcanoBody(p, ctx), agent: true });
registerPanelType({ type: "CompositionBars", body: compositionBody, agent: true });
registerPanelType({ type: "MetadataFacets", body: facetsBody, agent: true });
registerPanelType({ type: "BoxBySample", body: (p, ctx) => boxBody(p, ctx), agent: true });
registerPanelType({ type: "Overdispersion", body: (_p, ctx, hooks) => overdispBody(ctx, hooks), agent: true });
registerPanelType({ type: "Heatmap", body: heatmapBody, agent: true });
registerPanelType({ type: "Reconcile", body: reconcileBody, agent: true });
registerPanelType({ type: "AnnoRecord", body: annoRecordBody, agent: true });
registerPanelType({ type: "GeneList", body: (p, _ctx, hooks) => geneListBody(p, hooks), agent: true });
registerPanelType({ type: "VariableGenes", body: variableGenesBody, agent: true });
registerPanelType({ type: "Widget", body: widgetBody, agent: true });
registerPanelType({ type: "Note", body: (p) => { const d = mk("div", "notebody"); d.innerHTML = p.text || ""; d.style.cssText = "font-size:12.5px;line-height:1.5"; return { el: d }; }, agent: true });
registerPanelType({ type: "SplitHeat", body: (p) => splitHeatBody(p) });   // app-created only (not agent-addable) — matches the old REGISTRY which omitted it
