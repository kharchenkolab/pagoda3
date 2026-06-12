// The coordination space (plan1.md §I.2): slow-changing layout is elsewhere; this is
// the fast, agent-driven shared state every linked view reads. Tiny reactive store.
export interface CoordState {
  colorBy: string;            // "meta:leiden" | "gene:IL6" | "qc:mito" | "geneset:Inflammatory response"
  focus: { dim: string; value: string } | null;
  selection: Int32Array | null;
  geneFocus: string | null;
  // ephemeral cross-panel hover cue (a group a linked panel is pointing at) — a light correspondence
  // hint, NOT a committed change: panels show a subtle locator, no recolour, no checkpoint.
  hint: { grouping: string; value: string } | null;
  // view options live HERE (not hardcoded in paint) so the agent AND direct manipulation both drive them
  // — the generative-UX premise. legend:null = auto (key for numeric colourings, hidden when labels carry it).
  display: { labels: boolean; legend: boolean | null };
}

type Listener = (s: CoordState, changed: (keyof CoordState)[]) => void;

export class Coord {
  private s: CoordState = { colorBy: "meta:leiden", focus: null, selection: null, geneFocus: null, hint: null, display: { labels: true, legend: null } };
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
  setFocus(dim: string, value: string) { this.set({ focus: { dim, value } }); }
  clearFocus() { this.set({ focus: null, selection: null }); }
  setSelection(ids: Int32Array | null) { this.set({ selection: ids }); }
  setHint(grouping: string, value: string) { const h = this.s.hint; if (h && h.grouping === grouping && h.value === value) return; this.set({ hint: { grouping, value } }); }
  clearHint() { if (this.s.hint) this.set({ hint: null }); }
  setDisplay(patch: Partial<CoordState["display"]>) { this.set({ display: { ...this.s.display, ...patch } }); }
}

export function handleLabel(handle: string): string {
  const [kind, rest] = handle.split(/:(.+)/);
  if (kind === "meta") return rest === "cell_type" ? "cell type" : rest;
  if (kind === "gene") return rest;
  if (kind === "qc") return rest;
  if (kind === "geneset") return rest;
  return handle;
}
