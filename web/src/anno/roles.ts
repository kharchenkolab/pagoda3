// Field-role classification. L* just regularizes AnnData/Seurat, which rarely mark which obs column is a
// cell-type annotation vs a covariate/QC — so we can't read a role from the store. This pre-filter cheaply
// discards the OBVIOUS non-annotations (numeric metrics, id-like high-cardinality columns); whatever is left
// is a "candidate" the AGENT classifies by reading the category values (its strength). Pure + testable.

export type Role = "annotation" | "partition" | "covariate" | "qc" | "candidate";

export interface FieldInfo { name: string; kind: "categorical" | "numeric"; cardinality: number }

// Coarse role from shape alone — deliberately conservative: only call the clearly-mechanical ones, leave the
// genuine ambiguity (covariate vs partition vs annotation, all mid-cardinality) to the agent's value read.
export function prefilterRole(f: FieldInfo, nCells: number, nSamples: number): Role {
  if (f.kind === "numeric") return "qc";                       // continuous metric (mito %, n_genes, score)
  const c = f.cardinality;
  if (c < 2) return "covariate";                               // constant / single value
  if (c >= Math.min(nCells * 0.5, Math.max(50, nSamples * 4))) return "covariate";   // id-like (per-cell barcodes, free text)
  return "candidate";                                          // mid-cardinality categorical → agent decides
}

export function prefilterRoles(fields: FieldInfo[], nCells: number, nSamples: number): { name: string; role: Role }[] {
  return fields.map((f) => ({ name: f.name, role: prefilterRole(f, nCells, nSamples) }));
}

// The fields worth showing the agent for semantic classification (the candidates) — those the pre-filter
// couldn't settle. The agent reads their values and assigns annotation | partition | covariate.
export function candidateFields(fields: FieldInfo[], nCells: number, nSamples: number): string[] {
  return prefilterRoles(fields, nCells, nSamples).filter((r) => r.role === "candidate").map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Annotation-SOURCE detection — which tracks the Reconcile panel compares.
//
// A store like Azimuth+CellTypist output carries several cell-type tracks (predicted.celltype.l1/l2/l3,
// celltypist, celltypist_raw) alongside batch columns (sample, orig.ident) — and L*'s `role=label` does
// not distinguish them (both are just categorical labels over cells). Waiting for the agent to classify
// them left the panel empty on open, so we detect by NAME here (sync, catalog-only) and let the value-level
// checks (cluster placeholders, sample-id subset) refine at read time. Everything is user-overridable.
// ---------------------------------------------------------------------------

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Per-sample / design columns — never cell-type annotations, however "label"-shaped they look. Excluding
// them matters: on a 2-sample store `sample` scores 63.7% raw best-match agreement against a real cell-type
// track purely from class imbalance, which would read as corroboration.
const BATCH_NAMES = new Set([
  "sample", "samples", "sampleid", "origident", "batch", "donor", "donorid", "patient", "patientid",
  "subject", "subjectid", "individual", "library", "libraryid", "run", "lane", "channel", "well", "plate",
  "dataset", "study", "project", "condition", "treatment", "timepoint", "time", "replicate", "hto", "hashtag",
  "sex", "gender", "age", "tissue", "organ", "region", "disease", "status", "genotype", "stim",
]);

/** A per-sample / design column (batch, donor, condition…) rather than a cell-type annotation. */
export function looksLikeBatch(name: string, categories?: string[], sampleIds?: string[]): boolean {
  if (BATCH_NAMES.has(normalize(name))) return true;
  // value-level: the field's values ARE the sample ids (a differently-named batch column, e.g. "orig.ident"
  // copies or "library_x"). Subset rather than equality — a store may carry a field covering some samples.
  if (categories?.length && sampleIds?.length) {
    const ids = new Set(sampleIds.map(normalize));
    if (categories.every((c) => ids.has(normalize(c)))) return true;
  }
  return false;
}

/** A field whose NAME says "unsupervised partition" (leiden / louvain / *_clusters / snn_res / kmeans). */
export function looksLikeClusterField(name: string): boolean {
  return /(^|[._\- ])(clusters?|clustering|leiden|louvain|snn_res|res|kmeans|phenograph|metacell|sctype)([._\- ]|\d|$)/i.test(name);
}

/** Integer-valued, low-cardinality numeric column → a partition (cluster ids stored as numbers, which L*
 *  writes as `role=measure`/dense, making the real clustering invisible to categorical-only enumeration).
 *  Returns null when the values aren't integral or the cardinality is too high to be a partition. */
export function partitionFromNumeric(values: ArrayLike<number>, maxCard = 200): { codes: Int32Array; categories: string[] } | null {
  const n = values.length;
  if (!n) return null;
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v) || !Number.isInteger(v)) return null;   // a real measure (mito %, score) — not cluster ids
    seen.add(v);
    if (seen.size > maxCard) return null;                            // too many levels to be a clustering
  }
  if (seen.size < 2) return null;                                    // constant — carries no partition
  const levels = [...seen].sort((a, b) => a - b);
  const ix = new Map<number, number>(levels.map((v, k) => [v, k]));
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i++) codes[i] = ix.get(values[i])!;
  return { codes, categories: levels.map(String) };
}

/** The per-cell CONFIDENCE column that ships alongside an annotation track, if the store has one —
 *  `predicted.celltype.l2` → `predicted.celltype.l2.score`, `celltypist` → `celltypist_conf`. Reference
 *  mappers emit these next to every call and nothing was reading them, so a low-confidence track looked
 *  exactly as authoritative as a high-confidence one. Matched case-insensitively against real field names. */
export function confidenceFieldFor(track: string, fieldNames: string[]): string | undefined {
  const want = ["score", "conf", "confidence", "prob", "probability", "uncertainty"];
  const lower = new Map(fieldNames.map((f) => [f.toLowerCase(), f]));
  for (const sep of [".", "_", "-"]) for (const w of want) {
    const hit = lower.get((track + sep + w).toLowerCase());
    if (hit && hit !== track) return hit;
  }
  return undefined;
}

export interface TrackFamily { family: string; level: number; raw: boolean }

/** Split a track name into the METHOD that produced it and which level/variant of it this is:
 *  `predicted.celltype.l2` → {family:"predicted.celltype", level:2}; `celltypist_raw` → {family:"celltypist", raw:true}.
 *  Used only to choose ONE default track per method — the picker itself stays a flat list. */
export function trackFamily(name: string): TrackFamily {
  let s = name, raw = false, level = 0;
  const mRaw = /^(.*?)[._\- ](raw|unfiltered|percell)$/i.exec(s);
  if (mRaw) { s = mRaw[1]; raw = true; }
  const mLvl = /^(.*?)[._\- ]?l(?:evel)?[._\- ]?(\d+)$/i.exec(s);
  if (mLvl && mLvl[1]) { s = mLvl[1]; level = Number(mLvl[2]); }
  return { family: s, level, raw };
}

/** Choose the DEFAULT reconcile sources: one track per method, at the granularity closest to the base
 *  partition. Comparing across granularity manufactures disagreement — the same two methods score 72.9%
 *  (l1, 8 labels) or 88.5% (l2, 29 labels) against celltypist on the same data purely by which level is
 *  compared — so we match granularity to the base and prefer a curated variant over a raw per-cell one. */
export function pickDefaultSources(tracks: { name: string; cardinality: number }[], baseCardinality: number): string[] {
  const byFamily = new Map<string, { name: string; score: number }>();
  for (const t of tracks) {
    const f = trackFamily(t.name);
    // distance in granularity from the base, plus a nudge away from raw/per-cell variants
    const score = Math.abs(t.cardinality - baseCardinality) + (f.raw ? baseCardinality * 0.25 : 0);
    const cur = byFamily.get(f.family);
    if (!cur || score < cur.score) byFamily.set(f.family, { name: t.name, score });
  }
  const chosen = new Set([...byFamily.values()].map((v) => v.name));
  return tracks.filter((t) => chosen.has(t.name)).map((t) => t.name);   // keep the caller's ordering
}
