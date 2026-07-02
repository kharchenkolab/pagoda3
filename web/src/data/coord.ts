// The coordination space (plan1.md §I.2): slow-changing layout is elsewhere; this is
// the fast, agent-driven shared state every linked view reads. Tiny reactive store.
// A typed reference to a set of entities, placed on the bus by a selection. Receivers interpret it in
// THEIR vocabulary: directly if they speak its type, via cell-mediated translation if not, or ignore it.
// Native-typed — a category when you clicked a category, raw cells when you brushed — not collapsed at source.
export type EntityRef =
  | { kind: "category"; grouping: string; value: string }
  | { kind: "cells"; ids: Int32Array };

export interface CoordState {
  colorBy: string;            // "meta:leiden" | "gene:IL6" | "qc:mito"
  // FOCUS = an inter-panel restriction to a subpopulation. A labeled cell set every panel reads: the embedding
  // greys non-focus cells, the reconcile table restricts to clusters in the focus, compute defaults to it.
  // ids = the resolved cells (source of truth for masks); spec = the cell-set expression (serializable, re-resolved).
  focus: { label: string; ids: Int32Array; spec?: any } | null;
  selection: EntityRef | null;
  geneFocus: string | null;
  // ephemeral cross-panel hover cue — a typed EntityRef (a CELL when you hover the embedding, a CATEGORY
  // when you hover a category panel) that linked views interpret in their own vocabulary. NOT a committed
  // change: a subtle locator, no recolour, no checkpoint.
  hint: EntityRef | null;
  geneHint: string | null;    // ephemeral hovered GENE (a row in a dotplot) — linked panels highlight that gene's row

  // view options live HERE (not hardcoded in paint) so the agent AND direct manipulation both drive them
  // — the generative-UX premise. legend:null = auto (key for numeric colourings, hidden when labels carry it).
  display: { labels: boolean; legend: boolean | null; alpha: number; winsor: number };   // alpha = embedding point opacity (<1 shows density); winsor = quantile clipped off each tail of a numeric colour scale (0.01 = 1%)
  // The OPEN extension of `display`: global per-panel-TYPE style overrides (e.g. {Embedding:{point:{radius:4}, label:{fontSize:16}}}).
  // Every rendering constant the paint code used to hardcode is reachable here — the view escape hatch. A panel's own
  // view.style wins over this global default; both resolve through render/style.ts on each paint.
  style?: Record<string, any>;
}

type Listener = (s: CoordState, changed: (keyof CoordState)[]) => void;

export class Coord {
  private s: CoordState = { colorBy: "meta:leiden", focus: null, selection: null, geneFocus: null, hint: null, geneHint: null, display: { labels: true, legend: null, alpha: 0.7, winsor: 0.01 } };
  private listeners = new Set<Listener>();

  get state() { return this.s; }
  subscribe(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  set(patch: Partial<CoordState>) {
    const changed = (Object.keys(patch) as (keyof CoordState)[]).filter((k) => (this.s as any)[k] !== (patch as any)[k]);
    if (!changed.length) return;
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) fn(this.s, changed);
  }

  // convenience verbs (the agent and direct manipulation both call these)
  setColor(handle: string) { this.set({ colorBy: handle }); }
  // focus to a resolved subpopulation (caller resolves the cells); a null clears it.
  setFocus(focus: { label: string; ids: Int32Array; spec?: any } | null) { this.set({ focus }); }
  clearFocus() { this.set({ focus: null, selection: null }); }
  setSelection(ref: EntityRef | null) { this.set({ selection: ref }); }
  setHint(ref: EntityRef | null) { if (refEq(this.s.hint, ref)) return; this.set({ hint: ref }); }
  clearHint() { if (this.s.hint) this.set({ hint: null }); }
  setGeneHint(sym: string | null) { if (this.s.geneHint === sym) return; this.set({ geneHint: sym }); }
  clearGeneHint() { if (this.s.geneHint) this.set({ geneHint: null }); }
  setDisplay(patch: Partial<CoordState["display"]>) { this.set({ display: { ...this.s.display, ...patch } }); }
}

// Ref equality — dedupes hover spam (same cell / same category → no repaint). Multi-cell refs are
// treated as always-changed (cheap to recompute, rare on the hover path).
export function refEq(a: EntityRef | null, b: EntityRef | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "category" && b.kind === "category") return a.grouping === b.grouping && a.value === b.value;
  if (a.kind === "cells" && b.kind === "cells") return a.ids.length === 1 && b.ids.length === 1 && a.ids[0] === b.ids[0];
  return false;
}

export function handleLabel(handle: string): string {
  const [kind, rest] = handle.split(/:(.+)/);
  if (kind === "meta") return rest === "cell_type" ? "cell type" : rest;
  if (kind === "gene") return rest;
  if (kind === "qc") return rest;
  if (kind === "code") return rest;   // a custom per-cell score from compute_code
  if (kind === "conf") return rest + " confidence";   // annotation-source confidence (uncertain = where to look)
  return handle;
}
