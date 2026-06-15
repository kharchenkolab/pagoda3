// Pure validation + normalization of a declarative VIEW patch — the single agent-facing surface for
// "what to show" (colour, focus, display, and per-panel config). This replaces the enumerated config RPC
// verbs (set_color / set_focus / set_display / configure_panel / add_panel / show_marker_heatmap): a new
// knob is a FIELD here, not a new tool, so the cross-product never explodes.
//
// It is deliberately pure and dependency-free: it takes the raw patch plus a description of the world and
// returns validated operations + human-readable messages (so the agent can self-correct). No DOM, no app
// state — which is also why `node --test` can strip the types and unit-test it directly.

export type HeatMode = "heat" | "dot";

// One panel operation: create (`add` = type), remove (`remove` + id), or configure (id + fields).
export interface RawPanelOp {
  id?: number;
  add?: string;            // create a panel of this TYPE (mutually exclusive with id)
  remove?: boolean;        // remove panel `id`
  title?: string;
  col?: number;            // pin to a workbench column (0 left, 1 right) — stack panels in one column
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
  focus?: { dim?: string; value?: string };                   // global focus
  clearFocus?: boolean;
  display?: { labels?: boolean; legend?: boolean; alpha?: number };
  panels?: RawPanelOp[];
  facet?: { by?: string; panel?: number; values?: string[]; layout?: string };   // split one panel into aligned copies
  arrange?: { rows?: number[][]; columns?: number[][] };   // place EXISTING panels into a 2-col grid (pure reposition)
}

export interface Scope { grouping: string; value: string; }
export interface PanelSpec { type: string; title?: string; col?: 0 | 1; full?: boolean; colorBy?: string; scope?: Scope; embedding?: string; colormap?: string; group?: string; heatMode?: HeatMode; genes?: string[]; }
export interface PanelPatch { title?: string; col?: 0 | 1; full?: boolean; colorBy?: string; scope?: Scope | null; embedding?: string; colormap?: string; heatMode?: HeatMode; genes?: string[]; group?: string; }

export type NormOp =
  | { kind: "color"; handle: string }
  | { kind: "focus"; dim: string; value: string }
  | { kind: "clearFocus" }
  | { kind: "display"; patch: { labels?: boolean; legend?: boolean; alpha?: number } }
  | { kind: "addPanel"; spec: PanelSpec }
  | { kind: "configPanel"; id: number; patch: PanelPatch }
  | { kind: "removePanel"; id: number }
  | { kind: "facet"; by: string; values: string[]; panel?: number; layout: "stack" | "side" | "auto" }
  | { kind: "arrange"; place: { id: number; col?: 0 | 1; full: boolean }[] };

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
  if (kind === "qc" || kind === "geneset") return null;
  return `unrecognized colour "${handle}" — use meta:<field>, gene:<SYMBOL>, qc:<metric>, or geneset:<name>`;
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
  else if (patch.focus && patch.focus.dim && patch.focus.value) {
    const { dim, value } = patch.focus;
    if (!w.categoricals.includes(dim)) rejected.push(`focus: unknown field "${dim}" (have: ${w.categoricals.join(", ") || "—"})`);
    else if (!w.valuesOf(dim).includes(value)) rejected.push(`focus: "${value}" is not a value of ${dim}`);
    else ops.push({ kind: "focus", dim, value });
  }
  if (patch.display && typeof patch.display === "object") {
    const d: { labels?: boolean; legend?: boolean; alpha?: number } = {};
    if (typeof patch.display.labels === "boolean") d.labels = patch.display.labels;
    if (typeof patch.display.legend === "boolean") d.legend = patch.display.legend;
    if (typeof patch.display.alpha === "number") d.alpha = Math.max(0.02, Math.min(1, patch.display.alpha));
    if (Object.keys(d).length) ops.push({ kind: "display", patch: d });
  }

  // ---- panels ----
  const panels = patch.panels || [];
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
      if (op.col === 0 || op.col === 1) spec.col = op.col;
      if (typeof op.full === "boolean") spec.full = op.full;
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
    if (op.title) pp.title = op.title;
    if (op.col === 0 || op.col === 1) pp.col = op.col;
    if (typeof op.full === "boolean") pp.full = op.full;
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
    else rejected.push(`panel #${op.id}: nothing to change`);
  }

  // ---- facet: split one panel into aligned copies that differ ONLY in scope ----
  if (patch.facet && typeof patch.facet === "object") {
    const f = patch.facet; const by = typeof f.by === "string" ? f.by : "";
    if (!by || !w.categoricals.includes(by)) {
      rejected.push(`facet: unknown field "${by}" (have: ${w.categoricals.join(", ") || "—"})`);
    } else {
      const allVals = w.valuesOf(by);
      const asked = Array.isArray(f.values) ? f.values.map(String) : [];
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

  // ---- arrange: place EXISTING panels into the 2-column grid (pure reposition, never recreates) ----
  if (patch.arrange && typeof patch.arrange === "object") {
    const a = patch.arrange;
    const mode = Array.isArray(a.rows) ? "rows" : Array.isArray(a.columns) ? "columns" : null;
    const grid = (mode === "rows" ? a.rows : a.columns) as number[][] | undefined;
    if (!mode || !grid) rejected.push("arrange: give rows:[[id,id],…] (each inner array is a grid ROW) or columns:[[…],[…]] (one array per COLUMN)");
    else {
      const flat = grid.flat();
      const bad = flat.filter((id) => typeof id !== "number" || !w.panelExists(id));
      if (!flat.length) rejected.push("arrange: no panel ids given");
      else if (bad.length) rejected.push(`arrange: unknown panel(s) ${bad.join(", ")}`);
      else if (flat.length !== new Set(flat).size) rejected.push("arrange: a panel id appears more than once");
      else if (mode === "rows" && grid.some((r) => r.length > 2)) rejected.push("arrange: a row can hold at most 2 panels (two columns) — use more rows");
      else if (mode === "columns" && grid.length > 2) rejected.push("arrange: at most 2 columns");
      else {
        const place: { id: number; col?: 0 | 1; full: boolean }[] = [];
        if (mode === "rows") {
          for (const row of grid) {
            if (row.length === 1) place.push({ id: row[0], full: true });
            else { place.push({ id: row[0], col: 0, full: false }); place.push({ id: row[1], col: 1, full: false }); }
          }
        } else {
          const left = grid[0] || [], right = grid[1] || [], single = grid.length === 1;
          for (let i = 0; i < Math.max(left.length, right.length); i++) {
            if (left[i] != null) place.push(single ? { id: left[i], full: true } : { id: left[i], col: 0, full: false });
            if (right[i] != null) place.push({ id: right[i], col: 1, full: false });
          }
        }
        ops.push({ kind: "arrange", place });
      }
    }
  }

  return { ops, rejected, notes };
}
