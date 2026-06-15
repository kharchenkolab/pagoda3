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
export interface ReconRow {
  group: string; n: number;
  sources: { name: string; label: string | null; frac: number }[];   // dominant label per source + its coverage of the group
  status: ReconStatus;
}

// Reconcile a base partition (usually the clustering) against source layers. For each base group, find the
// dominant label each source assigns and what fraction of the group it covers, then classify agreement.
export function reconcile(base: { codes: ArrayLike<number>; categories: string[] }, sources: { name: string; codes: ArrayLike<number>; categories: string[] }[]): ReconRow[] {
  const G = base.categories.length, N = base.codes.length;
  const counts = new Int32Array(G);
  for (let i = 0; i < N; i++) { const g = base.codes[i]; if (g >= 0 && g < G) counts[g]++; }
  const rows: ReconRow[] = [];
  for (let g = 0; g < G; g++) {
    const srcOut = sources.map((s) => {
      const tally = new Map<number, number>();
      for (let i = 0; i < N; i++) { if (base.codes[i] !== g) continue; const c = s.codes[i]; if (c >= 0) tally.set(c, (tally.get(c) || 0) + 1); }
      let best = -1, bestN = 0; for (const [c, n] of tally) if (n > bestN) { best = c; bestN = n; }
      return { name: s.name, label: best >= 0 ? s.categories[best] : null, frac: counts[g] ? bestN / counts[g] : 0 };
    });
    const opinions = srcOut.map((s) => s.label).filter((l): l is string => l != null);
    const status: ReconStatus = opinions.length === 0 ? "none" : opinions.length === 1 ? "single" : opinions.every((l) => l === opinions[0]) ? "agree" : "conflict";
    rows.push({ group: base.categories[g], n: counts[g], sources: srcOut, status });
  }
  return rows;
}
