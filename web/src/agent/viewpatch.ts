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
  colorBy?: string;        // per-panel colour handle (meta:/gene:/qc:/geneset:)
  scopeGrouping?: string;
  scopeValue?: string;
  clearScope?: boolean;
  embedding?: string;
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
}

export interface Scope { grouping: string; value: string; }
export interface PanelSpec { type: string; title?: string; colorBy?: string; scope?: Scope; embedding?: string; group?: string; heatMode?: HeatMode; genes?: string[]; }
export interface PanelPatch { title?: string; colorBy?: string; scope?: Scope | null; embedding?: string; heatMode?: HeatMode; genes?: string[]; }

export type NormOp =
  | { kind: "color"; handle: string }
  | { kind: "focus"; dim: string; value: string }
  | { kind: "clearFocus" }
  | { kind: "display"; patch: { labels?: boolean; legend?: boolean; alpha?: number } }
  | { kind: "addPanel"; spec: PanelSpec }
  | { kind: "configPanel"; id: number; patch: PanelPatch }
  | { kind: "removePanel"; id: number };

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
      if (typeof op.colorBy === "string" && op.colorBy) { const e = colorError(op.colorBy, w); if (e) rejected.push(`${where} colorBy: ${e}`); else spec.colorBy = op.colorBy; }
      if (op.scopeGrouping && op.scopeValue) { const s = scopeFrom(op.scopeGrouping, op.scopeValue, w, where, rejected); if (s) spec.scope = s; }
      if (typeof op.embedding === "string" && op.embedding) { if (w.embeddings.includes(op.embedding)) spec.embedding = op.embedding; else rejected.push(`${where}: unknown embedding "${op.embedding}" (have: ${w.embeddings.join(", ") || "umap"})`); }
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
    const pp: PanelPatch = {}; const isHeat = w.panelType(op.id) === HEAT_TYPE;
    if (op.title) pp.title = op.title;
    if (typeof op.colorBy === "string" && op.colorBy) { const e = colorError(op.colorBy, w); if (e) rejected.push(`${where} colorBy: ${e}`); else pp.colorBy = op.colorBy; }
    if (op.clearScope) pp.scope = null;
    else if (op.scopeGrouping && op.scopeValue) { const s = scopeFrom(op.scopeGrouping, op.scopeValue, w, where, rejected); if (s) pp.scope = s; }
    if (typeof op.embedding === "string" && op.embedding) { if (w.embeddings.includes(op.embedding)) pp.embedding = op.embedding; else rejected.push(`${where}: unknown embedding "${op.embedding}"`); }
    if (isHeat) {
      const hm = normHeatMode(op.heatMode); if (hm) pp.heatMode = hm; else if (op.heatMode != null) notes.push(`${where}: heatMode "${op.heatMode}" ignored`);
      if (op.clearGenes || op.genes) { const base = op.clearGenes ? [] : w.panelGenes(op.id); pp.genes = resolveGenes(base, op.genes, w, where, notes); }
    } else if (op.heatMode != null || op.genes != null) {
      notes.push(`${where}: heatMode/genes apply only to Heatmap panels`);
    }
    if (Object.keys(pp).length) ops.push({ kind: "configPanel", id: op.id, patch: pp });
    else rejected.push(`panel #${op.id}: nothing to change`);
  }

  return { ops, rejected, notes };
}
