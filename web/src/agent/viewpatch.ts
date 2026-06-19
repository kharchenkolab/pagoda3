// Pure validation + normalization of a declarative VIEW patch — the single agent-facing surface for
// "what to show" (colour, focus, display, and per-panel config). This replaces the enumerated config RPC
// verbs (set_color / set_focus / set_display / configure_panel / add_panel / show_marker_heatmap): a new
// knob is a FIELD here, not a new tool, so the cross-product never explodes.
//
// It is deliberately pure and dependency-free: it takes the raw patch plus a description of the world and
// returns validated operations + human-readable messages (so the agent can self-correct). No DOM, no app
// state — which is also why `node --test` can strip the types and unit-test it directly.

export type HeatMode = "heat" | "dot";

// The workbench grid can hold up to this many side-by-side columns. Not a conceptual limit — a practical
// width ceiling so a stray col:50 can't shred the layout into unreadable slivers. Generous enough that a
// normal ask ("three columns") never trips it; exceeding it clamps with a note rather than refusing.
export const MAX_COLS = 4;
const clampCol = (c: number): number => Math.max(0, Math.min(MAX_COLS - 1, Math.floor(c)));

// One panel operation: create (`add` = type), remove (`remove` + id), or configure (id + fields).
export interface RawPanelOp {
  id?: number;
  add?: string;            // create a panel of this TYPE (mutually exclusive with id)
  remove?: boolean;        // remove panel `id`
  title?: string;
  col?: number;            // pin to a workbench column (0 = leftmost) — same col stacks panels; grid grows to fit
  full?: boolean;          // span the full width (two full panels stack one under another)
  colorBy?: string;        // per-panel colour handle (meta:/gene:/qc:/geneset:)
  scopeGrouping?: string;
  scopeValue?: string;
  clearScope?: boolean;
  embedding?: string;
  colormap?: string;       // palette for numeric colourings (amber/viridis/rdbu/…); aliases like "red-to-blue" ok
  group?: string;          // Heatmap grouping
  heatMode?: string;       // "heatmap" | "dotplot" (also accepts "heat" | "dot")
  genes?: string[];        // Heatmap: pin these genes (merged with existing unless clearGenes)
  clearGenes?: boolean;
}

export interface RawViewPatch {
  color?: string;                                              // global colour handle
  focus?: { dim?: string; value?: string; set?: any; label?: string };   // global focus: a category (dim=value) OR a cell-SET (for populations spanning several labels, e.g. T cells)
  clearFocus?: boolean;
  select?: { dim?: string; value?: string };   // transient selection of a metadata value (cross-filters facets, highlights embedding)
  clearSelect?: boolean;
  display?: { labels?: boolean; legend?: boolean; alpha?: number; winsor?: number };
  panels?: RawPanelOp[];
  facet?: { by?: string; panel?: number; values?: string[]; layout?: string };   // split one panel into aligned copies
  arrange?: { rows?: number[][]; columns?: number[][] };   // place EXISTING panels into an N-col grid (pure reposition)
}

export interface Scope { grouping: string; value: string; }
export interface PanelSpec { type: string; title?: string; col?: number; full?: boolean; colorBy?: string; scope?: Scope; embedding?: string; colormap?: string; group?: string; heatMode?: HeatMode; genes?: string[]; }
export interface PanelPatch { title?: string; col?: number; full?: boolean; colorBy?: string; scope?: Scope | null; embedding?: string; colormap?: string; heatMode?: HeatMode; genes?: string[]; group?: string; }

export type NormOp =
  | { kind: "color"; handle: string }
  | { kind: "focus"; dim?: string; value?: string; set?: any; label?: string }
  | { kind: "clearFocus" }
  | { kind: "select"; dim?: string; value?: string }
  | { kind: "clearSelect" }
  | { kind: "display"; patch: { labels?: boolean; legend?: boolean; alpha?: number; winsor?: number } }
  | { kind: "addPanel"; spec: PanelSpec }
  | { kind: "configPanel"; id: number; patch: PanelPatch }
  | { kind: "removePanel"; id: number }
  | { kind: "facet"; by: string; values: string[]; panel?: number; layout: "stack" | "side" | "auto" }
  | { kind: "arrange"; place: { id: number; col?: number; full: boolean }[] };

// Everything the reducer needs to know about the live app — supplied by the caller so the reducer stays pure.
// `categoricals` are the colour-/scope-/focus-able metadata fields (cell_type, leiden, sample, condition…);
// `groupings` are the precomputed marker groupings a Heatmap can stack on (a subset of categoricals).
export interface World {
  panelTypes: string[];
  categoricals: string[];
  groupings: string[];
  valuesOf: (field: string) => string[];
  geneExists: (sym: string) => boolean;
  embeddings: string[];
  panelExists: (id: number) => boolean;
  panelType: (id: number) => string | undefined;
  panelGenes: (id: number) => string[];
  colormaps: string[];                                  // available palette names (for error messages)
  normalizeColormap: (name: string) => string | null;   // a spelling/alias → canonical palette, or null
}

export interface NormResult { ops: NormOp[]; rejected: string[]; notes: string[]; }

const HEAT_TYPE = "Heatmap";

function normHeatMode(v: string | undefined): HeatMode | undefined {
  if (v == null) return undefined;
  const s = String(v).toLowerCase();
  if (s === "dot" || s === "dotplot") return "dot";
  if (s === "heat" || s === "heatmap") return "heat";
  return undefined;
}

// Returns an error string if the colour handle is invalid, else null. qc:/geneset: pass without a catalog.
function colorError(handle: string, w: World): string | null {
  const i = handle.indexOf(":");
  const kind = i < 0 ? handle : handle.slice(0, i);
  const rest = i < 0 ? "" : handle.slice(i + 1);
  if (kind === "gene") return w.geneExists(rest) ? null : `unknown gene "${rest}"`;
  if (kind === "meta") return w.categoricals.includes(rest) ? null : `unknown field "${rest}" (have: ${w.categoricals.join(", ") || "—"})`;
  if (kind === "qc" || kind === "geneset" || kind === "conf" || kind === "code") return null;   // conf:=annotation-source confidence, code:=compute_code result
  return `unrecognized colour "${handle}" — use meta:<field>, gene:<SYMBOL>, qc:<metric>, geneset:<name>, or conf:<source>`;
}

function scopeFrom(grouping: string, value: string, w: World, where: string, rejected: string[]): Scope | undefined {
  if (!w.categoricals.includes(grouping)) { rejected.push(`${where}: unknown field "${grouping}" (have: ${w.categoricals.join(", ") || "—"})`); return undefined; }
  if (!w.valuesOf(grouping).includes(value)) { rejected.push(`${where}: "${value}" is not a value of ${grouping}`); return undefined; }
  return { grouping, value };
}

// Merge `wanted` gene symbols into `base` (deduped, order-preserving); unknown symbols are reported as notes.
function resolveGenes(base: string[], wanted: string[] | undefined, w: World, where: string, notes: string[]): string[] {
  const out = [...base]; const unknown: string[] = [];
  for (const raw of wanted || []) {
    const sym = String(raw).trim(); if (!sym) continue;
    if (!w.geneExists(sym)) unknown.push(sym);
    if (!out.includes(sym)) out.push(sym);   // keep even if unmeasured — the panel surfaces it as "not in this dataset" (visible feedback, not silence)
  }
  if (unknown.length) notes.push(`${where}: not measured in this dataset — ${unknown.join(", ")}`);
  return out;
}

export function normalizeViewPatch(patch: RawViewPatch, w: World): NormResult {
  const ops: NormOp[] = []; const rejected: string[] = []; const notes: string[] = [];
  if (!patch || typeof patch !== "object") return { ops, rejected: ["empty patch"], notes };

  // ---- global ----
  if (typeof patch.color === "string" && patch.color) {
    const e = colorError(patch.color, w);
    if (e) rejected.push(`color: ${e}`); else ops.push({ kind: "color", handle: patch.color });
  }
  if (patch.clearFocus) ops.push({ kind: "clearFocus" });
  else if (patch.focus && patch.focus.set && typeof patch.focus.set === "object") {   // cell-SET focus (a population over several labels, e.g. T cells) — the shell resolves + validates it
    ops.push({ kind: "focus", set: patch.focus.set, label: patch.focus.label || "subset" });
  } else if (patch.focus && patch.focus.dim && patch.focus.value) {
    const { dim, value } = patch.focus;
    if (!w.categoricals.includes(dim)) rejected.push(`focus: unknown field "${dim}" (have: ${w.categoricals.join(", ") || "—"})`);
    else if (!w.valuesOf(dim).includes(value)) rejected.push(`focus: "${value}" is not a value of ${dim}`);
    else ops.push({ kind: "focus", dim, value, label: `${dim} = ${value}` });
  }
  if (patch.clearSelect) ops.push({ kind: "clearSelect" });
  else if (patch.select && patch.select.dim && patch.select.value) {   // transient SELECTION of a metadata value (cross-filters the facets, highlights the embedding) — lighter than focus
    const { dim, value } = patch.select;
    if (!w.categoricals.includes(dim)) rejected.push(`select: unknown field "${dim}" (have: ${w.categoricals.join(", ") || "—"})`);
    else if (!w.valuesOf(dim).includes(value)) rejected.push(`select: "${value}" is not a value of ${dim}`);
    else ops.push({ kind: "select", dim, value });
  }
  if (patch.display && typeof patch.display === "object") {
    const d: { labels?: boolean; legend?: boolean; alpha?: number; winsor?: number } = {};
    if (typeof patch.display.labels === "boolean") d.labels = patch.display.labels;
    if (typeof patch.display.legend === "boolean") d.legend = patch.display.legend;
    if (typeof patch.display.alpha === "number") d.alpha = Math.max(0.02, Math.min(1, patch.display.alpha));
    if (typeof patch.display.winsor === "number") d.winsor = Math.max(0, Math.min(0.2, patch.display.winsor));   // quantile clipped off each tail of the numeric colour scale
    if (Object.keys(d).length) ops.push({ kind: "display", patch: d });
  }

  // ---- panels ----
  const panels = patch.panels || [];
  let hoistFacet: any = null;   // a `facet` misplaced INSIDE a panels[] op (a common model error) → hoisted to the top-level facet below
  for (let k = 0; k < panels.length; k++) {
    const op = panels[k]; const where = op.add ? `add ${op.add}` : `panel #${op.id}`;
    if (op.remove) {
      if (op.id == null || !w.panelExists(op.id)) rejected.push(`remove: no panel #${op.id}`);
      else ops.push({ kind: "removePanel", id: op.id });
      continue;
    }
    if (op.add) {
      if (!w.panelTypes.includes(op.add)) { rejected.push(`add: unknown panel type "${op.add}" (have: ${w.panelTypes.join(", ")})`); continue; }
      const isHeat = op.add === HEAT_TYPE;
      const spec: PanelSpec = { type: op.add };
      if (op.title) spec.title = op.title;
      // a column pin and full-width are mutually exclusive (full spans ALL columns, overriding col). When a model
      // sends both (e.g. col:2 + full:true), the explicit column WINS — otherwise the pin silently no-ops full-width.
      { const colPin = typeof op.col === "number" && op.col >= 0;
        if (colPin) spec.col = clampCol(op.col);
        if (typeof op.full === "boolean") spec.full = colPin && op.full ? false : op.full; }
      if (typeof op.colorBy === "string" && op.colorBy) { const e = colorError(op.colorBy, w); if (e) rejected.push(`${where} colorBy: ${e}`); else spec.colorBy = op.colorBy; }
      if (op.scopeGrouping && op.scopeValue) { const s = scopeFrom(op.scopeGrouping, op.scopeValue, w, where, rejected); if (s) spec.scope = s; }
      if (typeof op.embedding === "string" && op.embedding) { if (w.embeddings.includes(op.embedding)) spec.embedding = op.embedding; else rejected.push(`${where}: unknown embedding "${op.embedding}" (have: ${w.embeddings.join(", ") || "umap"})`); }
      if (typeof op.colormap === "string" && op.colormap) { const cm = w.normalizeColormap(op.colormap); if (cm) spec.colormap = cm; else rejected.push(`${where}: unknown colormap "${op.colormap}" (have: ${w.colormaps.join(", ")})`); }
      if (isHeat) {
        if (op.group) { if (w.groupings.includes(op.group)) spec.group = op.group; else rejected.push(`${where}: unknown grouping "${op.group}"`); }
        const hm = normHeatMode(op.heatMode); if (hm) spec.heatMode = hm; else if (op.heatMode != null) notes.push(`${where}: heatMode "${op.heatMode}" ignored (use heatmap|dotplot)`);
        const g = resolveGenes([], op.genes, w, where, notes); if (g.length) spec.genes = g;
      }
      ops.push({ kind: "addPanel", spec });
      continue;
    }
    // configure an existing panel
    if (op.id == null || !w.panelExists(op.id)) { rejected.push(`panel #${op.id}: no such panel`); continue; }
    const pp: PanelPatch = {}; const ptype = w.panelType(op.id); const isHeat = ptype === HEAT_TYPE; const groupable = isHeat || ptype === "Reconcile";
    // `facet` is a TOP-LEVEL update_view field, but models (esp. smaller ones) routinely nest it inside a panel op
    // (`panels:[{id, facet}]`) and then loop on the "nothing to change" rejection. Tolerate it: hoist to the top-level
    // facet with panel = this id so the split just works.
    const movedFacet = !!(op as any).facet;
    if (movedFacet && !hoistFacet) hoistFacet = { ...(op as any).facet, panel: op.id };
    else if (movedFacet) notes.push(`${where}: facet handles ONE panel per call — split the other panel in a separate update_view`);
    if (op.title) pp.title = op.title;
    // col pin and full-width are mutually exclusive (full overrides col) — when both are given, the column wins
    const colPin = typeof op.col === "number" && op.col >= 0;
    if (colPin) pp.col = clampCol(op.col);
    if (typeof op.full === "boolean") pp.full = colPin && op.full ? false : op.full;
    if (typeof op.colorBy === "string" && op.colorBy) { const e = colorError(op.colorBy, w); if (e) rejected.push(`${where} colorBy: ${e}`); else pp.colorBy = op.colorBy; }
    if (op.clearScope) pp.scope = null;
    else if (op.scopeGrouping && op.scopeValue) { const s = scopeFrom(op.scopeGrouping, op.scopeValue, w, where, rejected); if (s) pp.scope = s; }
    if (typeof op.embedding === "string" && op.embedding) { if (w.embeddings.includes(op.embedding)) pp.embedding = op.embedding; else rejected.push(`${where}: unknown embedding "${op.embedding}"`); }
    if (typeof op.colormap === "string" && op.colormap) { const cm = w.normalizeColormap(op.colormap); if (cm) pp.colormap = cm; else rejected.push(`${where}: unknown colormap "${op.colormap}" (have: ${w.colormaps.join(", ")})`); }
    if (groupable && op.group) { if (w.groupings.includes(op.group)) pp.group = op.group; else rejected.push(`${where}: unknown grouping "${op.group}"`); }   // Heatmap stacking / Reconcile base partition
    if (isHeat) {
      const hm = normHeatMode(op.heatMode); if (hm) pp.heatMode = hm; else if (op.heatMode != null) notes.push(`${where}: heatMode "${op.heatMode}" ignored`);
      if (op.clearGenes || op.genes) { const base = op.clearGenes ? [] : w.panelGenes(op.id); pp.genes = resolveGenes(base, op.genes, w, where, notes); }
    } else if (op.heatMode != null || op.genes != null || (op.group != null && !groupable)) {
      notes.push(`${where}: heatMode/genes apply only to Heatmap panels`);
    }
    if (Object.keys(pp).length) ops.push({ kind: "configPanel", id: op.id, patch: pp });
    else if (!movedFacet) rejected.push(`panel #${op.id}: nothing to change`);   // a hoisted-facet-only op is not "nothing"
  }

  // ---- facet: split one panel into aligned copies that differ ONLY in scope ----
  // Lenient: accept facet:"condition" (string) or {by|field|grouping:"condition"} — models reach for both shapes.
  const facetRaw: any = patch.facet ?? hoistFacet;   // top-level facet, OR one hoisted out of a panels[] op above
  if (facetRaw != null && facetRaw !== "") {
    const f: any = typeof facetRaw === "string" ? { by: facetRaw } : (typeof facetRaw === "object" && !Array.isArray(facetRaw)) ? facetRaw : null;
    const by = f ? (typeof f.by === "string" ? f.by : typeof f.field === "string" ? f.field : typeof f.grouping === "string" ? f.grouping : "") : "";
    if (!f) {
      rejected.push(`facet: must be {by:"<field>"} or a field-name string (got ${typeof facetRaw})`);
    } else if (!by || !w.categoricals.includes(by)) {
      rejected.push(`facet: unknown field "${by}" — give {by:"<field>"} with one of: ${w.categoricals.join(", ") || "—"}`);
    } else {
      const allVals = w.valuesOf(by);
      const asked: string[] = Array.isArray(f.values) ? f.values.map((x: any) => String(x)) : [];
      const bad = asked.filter((v) => !allVals.includes(v));
      if (bad.length) notes.push(`facet: ignored unknown ${by} value(s) ${bad.join(", ")}`);
      let values = (asked.length ? asked.filter((v) => allVals.includes(v)) : allVals);
      const MAXF = 12;
      if (values.length > MAXF) { notes.push(`facet by ${by}: ${values.length} values capped to first ${MAXF}`); values = values.slice(0, MAXF); }
      if (f.panel != null && !w.panelExists(f.panel)) rejected.push(`facet: no panel #${f.panel}`);
      else if (values.length < 2) rejected.push(`facet by ${by}: need ≥2 values (have ${values.length})`);
      else {
        const layout = f.layout === "stack" || f.layout === "side" ? f.layout : "auto";
        ops.push({ kind: "facet", by, values, panel: f.panel, layout });
      }
    }
  }

  // ---- arrange: place EXISTING panels into the grid (pure reposition, never recreates) ----
  // Lenient: accept arrange:{rows|columns}, arrange:[[…],…] (an array → rows), or top-level rows/columns.
  // The grid grows to as many columns as the layout asks for (up to MAX_COLS) — no fixed 2-column cap.
  const arrRaw: any = patch.arrange;
  const aRows = Array.isArray(arrRaw) ? arrRaw : (arrRaw?.rows ?? (patch as any).rows);
  const aCols = arrRaw?.columns ?? (patch as any).columns;
  if (arrRaw != null || Array.isArray(aRows) || Array.isArray(aCols)) {
    const mode = Array.isArray(aRows) ? "rows" : Array.isArray(aCols) ? "columns" : null;
    const grid = (mode === "rows" ? aRows : aCols) as number[][] | undefined;
    if (!mode || !grid) rejected.push("arrange: give rows:[[id,…],…] (each inner array is a grid ROW, left→right) or columns:[[…],…] (one array per COLUMN, top→bottom)");
    else {
      const flat = grid.flat();
      const bad = flat.filter((id) => typeof id !== "number" || !w.panelExists(id));
      if (!flat.length) rejected.push("arrange: no panel ids given");
      else if (bad.length) rejected.push(`arrange: unknown panel(s) ${bad.join(", ")}`);
      else if (flat.length !== new Set(flat).size) rejected.push("arrange: a panel id appears more than once");
      else if (mode === "rows" && grid.some((r) => r.length > MAX_COLS)) rejected.push(`arrange: a row can hold at most ${MAX_COLS} panels (${MAX_COLS} columns) — use more rows, or stack a column via columns:[…]`);
      else if (mode === "columns" && grid.length > MAX_COLS) rejected.push(`arrange: at most ${MAX_COLS} columns`);
      else {
        // a row's panels fan out across columns 0..n-1; a lone-id row spans the full width. the grid's actual
        // column count is derived later (from the widest row / highest col pin), so N columns just works.
        const place: { id: number; col?: number; full: boolean }[] = [];
        if (mode === "rows") {
          for (const row of grid) {
            if (row.length <= 1) { if (row[0] != null) place.push({ id: row[0], full: true }); }
            else row.forEach((id, c) => { if (id != null) place.push({ id, col: c, full: false }); });
          }
        } else {
          const single = grid.length === 1;   // one column → a full-width stack
          grid.forEach((col, c) => col.forEach((id) => { if (id != null) place.push(single ? { id, full: true } : { id, col: c, full: false }); }));
        }
        ops.push({ kind: "arrange", place });
      }
    }
  }

  // never leave the agent with a silent no-op: if nothing was recognized, say what it passed and what's valid
  if (!ops.length && !rejected.length && !notes.length) {
    const keys = Object.keys(patch || {}).filter((k) => (patch as any)[k] != null);
    rejected.push(`no recognized changes${keys.length ? ` in {${keys.join(", ")}}` : " (empty patch)"}. Valid fields: color, focus{dim,value}/clearFocus, select{dim,value}/clearSelect, display{labels,legend,alpha,winsor}, panels[{id|add|remove,…}], facet{by}, arrange{rows|columns}.`);
  }
  return { ops, rejected, notes };
}
