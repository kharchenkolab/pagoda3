// Annotation layers — the data model behind the reconciliation panel. An annotation layer is a writable
// categorical (cell → label) that lives app-side and is surfaced to the rest of the viewer as if it were a
// zarr categorical (see ctx.setAnnotationLayer / view.overlays), so colour/scope/facet/dotplot/compute all
// work on it unchanged. These functions are PURE so they can be unit-tested with node --test.

export type Role = "annotation" | "partition" | "covariate" | "qc" | "other";
export type AnnoSource = "manual" | "agent" | "sctype" | "celltypist" | "imported" | "derived";

// Per-label CAP record — mirrors celltype.info/docs/cell-annotation-metadata-terms (the export target).
export interface CapRecord {
  label: string;
  fullName?: string;
  synonyms?: string[];
  ontologyTermId?: string;        // CL:xxxx (OLS)
  ontologyTermExists?: boolean;
  ontologyTerm?: string;
  category?: string;              // parent / broader term
  markerEvidence?: string[];      // genes from THIS dataset (auto-filled from DE)
  canonicalMarkers?: string[];    // known / literature markers
  rationale?: string;
  rationaleDoi?: string[];
  suggested?: boolean;            // the agent proposed this record (UI badges it as a reviewable suggestion)
}

export interface AnnotationLayer {
  name: string;                   // "annotation" = the working draft; "scType"/"CellTypist"/… = sources
  source: AnnoSource;
  codes: Int32Array;              // cell → category index, -1 = unlabeled
  categories: string[];
  confidence?: Float32Array;      // per-cell, when a source provides one (scType score / CellTypist prob)
  records?: Record<string, CapRecord>;
  provenance?: { method?: string; model?: string; when?: string; params?: Record<string, unknown> };
}

// Seed a layer by copying an existing categorical (non-destructive — the source array is not shared).
export function seedLayer(name: string, source: AnnoSource, src: { codes: ArrayLike<number>; categories: string[] }): AnnotationLayer {
  return { name, source, codes: Int32Array.from(src.codes), categories: src.categories.slice(), records: {} };
}

// A layer where every cell is unlabeled (-1) — the empty working draft.
export function emptyLayer(name: string, source: AnnoSource, nCells: number): AnnotationLayer {
  return { name, source, codes: new Int32Array(nCells).fill(-1), categories: [], records: {} };
}

// Set `label` on the given cells (last-write-wins). Adds the label as a new category if needed. Mutates
// + returns the layer (deterministic, testable). cellIds out of range are ignored.
export function setLabel(layer: AnnotationLayer, cellIds: ArrayLike<number>, label: string): AnnotationLayer {
  let idx = layer.categories.indexOf(label);
  if (idx < 0) { idx = layer.categories.length; layer.categories.push(label); }
  for (let i = 0; i < cellIds.length; i++) { const c = cellIds[i]; if (c >= 0 && c < layer.codes.length) layer.codes[c] = idx; }
  return layer;
}

// Clear the label on the given cells (back to -1 / unlabeled).
export function clearLabel(layer: AnnotationLayer, cellIds: ArrayLike<number>): AnnotationLayer {
  for (let i = 0; i < cellIds.length; i++) { const c = cellIds[i]; if (c >= 0 && c < layer.codes.length) layer.codes[c] = -1; }
  return layer;
}

// ---- hierarchy (optional, multi-level) ----------------------------------------------------------------
// The working annotation is always the FINEST level. Coarser levels are DERIVED: each label carries a lineage
// of broader terms (coarsest→finest, excluding the leaf), stored as a ">"-delimited path in CapRecord.category
// (e.g. "Myeloid > Monocyte" for the leaf "CD14 monocyte"). Base case = empty path → a flat, one-level
// annotation with no extra UI. Multi-level just fills the path; coarser views roll up by it.
export function parseLineage(category?: string): string[] {
  return (category || "").split(/[>›]/).map((s) => s.trim()).filter(Boolean);
}
// Full chain coarsest→finest INCLUDING the leaf label.
export function labelChain(label: string, category?: string): string[] { return [...parseLineage(category), label]; }
// Deepest hierarchy across the populated labels (1 = flat). Defines how many levels exist.
export function hierarchyDepth(categories: string[], records?: Record<string, CapRecord>): number {
  let d = 1; for (const c of categories) d = Math.max(d, labelChain(c, records?.[c]?.category).length); return d;
}
// Roll the annotation up to `level` (1-based from the COARSEST). For each cell, take its label's chain and pick
// the term at that level (labels with a shallower chain repeat their coarsest term). Returns a compact derived
// categorical for colour/group by a coarser level. Unlabeled (-1) stays -1.
export function rollupToLevel(codes: ArrayLike<number>, categories: string[], records: Record<string, CapRecord> | undefined, level: number): { codes: Int32Array; categories: string[] } {
  const term = categories.map((c) => { const chain = labelChain(c, records?.[c]?.category); return chain[Math.min(Math.max(0, level - 1), chain.length - 1)]; });
  const cats: string[] = []; const idx = new Map<string, number>();
  const out = new Int32Array(codes.length).fill(-1);
  for (let i = 0; i < codes.length; i++) { const c = codes[i]; if (c < 0 || c >= term.length) continue; const t = term[c]; let j = idx.get(t); if (j === undefined) { j = cats.length; cats.push(t); idx.set(t, j); } out[i] = j; }
  return { codes: out, categories: cats };
}

// Drop categories no cell uses (after relabeling) + remap codes. Keeps records for surviving labels.
export function compact(layer: AnnotationLayer): AnnotationLayer {
  const used = new Set<number>(); for (const c of layer.codes) if (c >= 0) used.add(c);
  if (used.size === layer.categories.length) return layer;
  const keep = layer.categories.map((_, i) => i).filter((i) => used.has(i));
  const remap = new Int32Array(layer.categories.length).fill(-1); keep.forEach((old, ni) => { remap[old] = ni; });
  for (let i = 0; i < layer.codes.length; i++) if (layer.codes[i] >= 0) layer.codes[i] = remap[layer.codes[i]];
  layer.categories = keep.map((i) => layer.categories[i]);
  return layer;
}

export type ReconStatus = "agree" | "conflict" | "single" | "none";
// A source's read of one base group: dominant label + coverage, plus the runner-up — so a cluster a source
// SPLITS (labels don't map 1:1 to clusters) is visible (frac<1, an `alt`), not hidden behind the majority.
export interface SrcRead { name: string; label: string | null; frac: number; alt?: string; altFrac?: number }
export interface ReconRow { group: string; n: number; sources: SrcRead[]; status: ReconStatus }

// Reconcile a base partition (usually the clustering) against source layers. For each base group, find the
// dominant + runner-up label each source assigns and their coverage, then classify agreement on the dominant.
// `restrict` (optional) = a per-cell mask (1 = in the focus subpopulation); when given, only those cells are
// counted, so reconcile reflects the focused subset and empty groups drop out.
export function reconcile(base: { codes: ArrayLike<number>; categories: string[] }, sources: { name: string; codes: ArrayLike<number>; categories: string[] }[], restrict?: ArrayLike<number>): ReconRow[] {
  const G = base.categories.length, N = base.codes.length;
  const counts = new Int32Array(G);
  for (let i = 0; i < N; i++) { if (restrict && !restrict[i]) continue; const g = base.codes[i]; if (g >= 0 && g < G) counts[g]++; }
  const rows: ReconRow[] = [];
  for (let g = 0; g < G; g++) {
    if (restrict && counts[g] === 0) continue;   // a cluster with no focus cells drops out
    const srcOut: SrcRead[] = sources.map((s) => {
      const tally = new Map<number, number>();
      for (let i = 0; i < N; i++) { if (restrict && !restrict[i]) continue; if (base.codes[i] !== g) continue; const c = s.codes[i]; if (c >= 0) tally.set(c, (tally.get(c) || 0) + 1); }
      let best = -1, bestN = 0, sec = -1, secN = 0;
      for (const [c, n] of tally) { if (n > bestN) { sec = best; secN = bestN; best = c; bestN = n; } else if (n > secN) { sec = c; secN = n; } }
      const tot = counts[g] || 1;
      const out: SrcRead = { name: s.name, label: best >= 0 ? s.categories[best] : null, frac: bestN / tot };
      if (sec >= 0 && secN > 0) { out.alt = s.categories[sec]; out.altFrac = secN / tot; }
      return out;
    });
    const opinions = srcOut.map((s) => s.label).filter((l): l is string => l != null);
    const status: ReconStatus = opinions.length === 0 ? "none" : opinions.length === 1 ? "single" : opinions.every((l) => l === opinions[0]) ? "agree" : "conflict";
    rows.push({ group: base.categories[g], n: counts[g], sources: srcOut, status });
  }
  return rows;
}

// Confusion matrix between two labelings — the vocabulary-agnostic reconciliation primitive. counts[a][b] =
// #cells labeled A-category a AND B-category b. A consistent off-diagonal (e.g. "CD14 mono" always ↔ "CD14+
// monocyte") reveals the mapping between vocabularies that a string compare would miss.
export interface CrossTab { rows: string[]; cols: string[]; counts: number[][]; rowTotals: number[] }
export function crosstab(A: { codes: ArrayLike<number>; categories: string[] }, B: { codes: ArrayLike<number>; categories: string[] }): CrossTab {
  const R = A.categories.length, C = B.categories.length;
  const counts = Array.from({ length: R }, () => new Array(C).fill(0));
  const rowTotals = new Array(R).fill(0);
  const n = Math.min(A.codes.length, B.codes.length);
  for (let i = 0; i < n; i++) { const a = A.codes[i], b = B.codes[i]; if (a >= 0 && a < R && b >= 0 && b < C) { counts[a][b]++; rowTotals[a]++; } }
  return { rows: A.categories, cols: B.categories, counts, rowTotals };
}
