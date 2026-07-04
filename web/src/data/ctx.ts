// Cached derived-data context the panels + agent read from. Holds the view, the
// embedding positions, cached metadata, and the data-handle catalog (provenance +
// cacoa caveats that TRAVEL WITH THE HANDLE — plan1.md I.7).
import type { LstarView, Metadata } from "./view.ts";
import type { Coord, EntityRef } from "./coord.ts";
import type { Role } from "../anno/roles.ts";

export interface HandleMeta { prov?: string; caveat?: string; }

// The label fields warmed first at init, in this preference order (a sensible default grouping order):
// clusterings, then cell types, then the common design covariates. Any OTHER label field the store carries
// is warmed too (below), just after these. Also the canonical ordering key for categoricalFields().
const COMMON_LABELS = ["leiden", "cell_type", "sample", "condition", "patient", "outcome"];

export class Ctx {
  view: LstarView;
  coord: Coord;
  embedding!: { data: Float32Array; n: number };                  // the default embedding ("umap")
  embeddings = new Map<string, { data: Float32Array; n: number }>(); // every 2D cell embedding, by field name
  private meta = new Map<string, Metadata>();
  private metaInflight = new Map<string, Promise<Metadata>>();   // in-flight metadata reads, so concurrent metaOf() calls for the same field dedupe onto ONE read (init() fires them in parallel)
  private markerCache = new Map<string, Map<string, { gene: number; symbol: string; lfc: number; padj: number }[]>>();
  private annoNames = new Set<string>();   // app-side annotation layers (overlays), surfaced as categoricals
  private fieldRoles = new Map<string, Role>();   // app-side field classification (agent-inferred, user-overridable)

  constructor(view: LstarView, coord: Coord) { this.view = view; this.coord = coord; }

  // session-wide gene-ignore filter (markers/DE/variable-genes rankings only) — passthrough to the view
  setGeneFilter(patterns: string[]): Promise<void> { return this.view.setGeneFilter(patterns); }
  geneFilterPatterns(): string[] { return this.view.geneFilterPatterns(); }
  excludedGeneCount(): number { return this.view.excludedGeneCount(); }

  async init() {
    const ds = this.view.ds;
    const names = ds.fieldNames();
    const roleOf = (nm: string) => (ds.field(nm) as any)?.role;
    // UNIVERSAL MINIMUM only: warm the 2D cell embeddings (the shared spatial frame every workspace needs to
    // render at all; small + cheap), in parallel. Labels / group-stats / markers are NOT warmed here — each
    // panel materializes what IT renders, lazily (deduped by metaOf/the reader cache), and enumeration reads the
    // CATALOG (catalogCategoricals), so the boot no longer warms a field just to make it enumerable. (Was: warm
    // all embeddings + COMMON_LABELS + every label — a central recipe coupled to the default workspaces; the
    // modular-provisioning refactor dissolves it so it can't go stale as data/panels/workspaces broaden.)
    const embFields = names.filter((nm) => roleOf(nm) === "embedding");
    // ALSO warm the default grouping — the field the embedding colours by on first paint — CONCURRENTLY with the
    // embeddings, so first paint isn't delayed one round-trip (measured: warming it here keeps the cold open ~1s;
    // deferring it to the embedding's own fill cost ~+300ms + serialized the categoricals behind it). It's derived
    // from the CATALOG (defaultGrouping = groupings()[prefs]), not a hardcoded field — every OTHER label stays lazy
    // (the panels that render them pull them). This is the "universal minimum": the spatial frame + its colouring.
    const dg = this.defaultGrouping();
    const [embReads] = await Promise.all([
      Promise.all(embFields.map(async (nm) => {
        try { const e = await this.view.embedding(nm); return e.dim === 2 ? { nm, data: e.data, n: e.n } : null; } catch { return null; }
      })),
      (this.view.ds.hasField(dg) ? this.metaOf(dg).catch(() => { /* not categorical — the panels will pull what they need */ }) : Promise.resolve(undefined)),
    ]);
    for (const r of embReads) if (r) this.embeddings.set(r.nm, { data: r.data, n: r.n });   // insert in field order → deterministic default-embedding fallback below
    this.embedding = this.embeddings.get("umap") || [...this.embeddings.values()][0] || await this.view.embedding("umap");
    // default field roles: cell_type is an annotation source out of the box; the agent/user reclassify the rest
    if (ds.hasField("cell_type")) this.fieldRoles.set("cell_type", "annotation");
  }

  // ---- field roles (agent-inferred, user-overridable; see anno/roles.ts) ----
  setFieldRole(name: string, role: Role): void { this.fieldRoles.set(name, role); }
  fieldRole(name: string): Role | undefined { return this.fieldRoles.get(name); }
  // The categorical fields that count as annotation SOURCES to reconcile: every annotation layer plus any
  // field classified "annotation" — minus the working draft itself (that's the target, not a source).
  annotationSources(): string[] {
    const set = new Set<string>(this.annoNames);
    for (const f of this.catalogCategoricals()) if (this.fieldRoles.get(f) === "annotation") set.add(f);
    set.delete("annotation");
    return [...set];
  }

  /** Names of the available embeddings (e.g. "umap", "umap.unintegrated") — the per-panel embedding choices. */
  embeddingNames(): string[] { return [...this.embeddings.keys()]; }
  /** The embedding a panel should render (its chosen one, else the default). */
  embeddingOf(name?: string): { data: Float32Array; n: number } { return (name && this.embeddings.get(name)) || this.embedding; }

  async metaOf(field: string): Promise<Metadata> {
    const cached = this.meta.get(field);
    if (cached) return cached;
    // Dedupe concurrent reads of the SAME field onto one view.metadata() call: init() now warms all
    // labels in parallel, and a panel may ask for a field that's already in flight. Without this the
    // check-then-set race would fetch the same field twice.
    let p = this.metaInflight.get(field);
    if (!p) {
      p = this.view.metadata(field).then((m) => { this.meta.set(field, m); return m; }).finally(() => { this.metaInflight.delete(field); });
      this.metaInflight.set(field, p);
    }
    return p;
  }

  get n() { return this.view.nCells; }

  // sample -> condition map (a sample's condition is constant across its cells)
  async sampleConditions(): Promise<Map<string, string>> {
    const s = await this.metaOf("sample") as any, c = await this.metaOf("condition") as any;
    const out = new Map<string, string>();
    for (let i = 0; i < this.n && out.size < s.categories.length; i++) {
      const sm = s.categories[s.codes[i]]; if (!out.has(sm)) out.set(sm, c.categories[c.codes[i]]);
    }
    return out;
  }

  // per (sample x cluster) proportions, compositional
  async composition(stackBy = "leiden", subset: Int32Array | null = null): Promise<{ samples: string[]; conds: string[]; groups: string[]; props: number[][] }> {
    const s = await this.metaOf("sample") as any, g = await this.metaOf(stackBy) as any;
    const samples = s.categories as string[], groups = g.categories as string[];
    const sc = await this.sampleConditions();
    const counts = samples.map(() => new Array(groups.length).fill(0));
    const tot = new Array(samples.length).fill(0);
    const N = subset ? subset.length : this.n;   // L3: proportions computed within the subset when subsetting
    for (let k = 0; k < N; k++) { const i = subset ? subset[k] : k; counts[s.codes[i]][g.codes[i]]++; tot[s.codes[i]]++; }
    const props = counts.map((row, si) => row.map((v) => (tot[si] ? v / tot[si] : 0)));
    return { samples, conds: samples.map((sm) => sc.get(sm) || ""), groups, props };
  }

  async markers(grouping = "leiden") {
    if (!this.markerCache.has(grouping)) this.markerCache.set(grouping, await this.view.markers(grouping, 40));
    return this.markerCache.get(grouping)!;
  }

  // Is the active colouring a categorical annotation (vs a gene/qc gradient)? Drives the labels/legend
  // defaults — read by both the header toggles and paintEmbedding so they agree.
  colorIsCategorical(): boolean {
    const cb = this.coord.state.colorBy;
    if (!cb.startsWith("meta:")) return false;
    const m = this.meta.get(cb.slice(5));
    return !!m && m.kind === "categorical";
  }

  // ---- cross-panel translation: the coordination bus ultimately speaks in CELLS ----
  // A category denotes a set of cells; any other grouping reads those cells in its own vocabulary
  // (1-to-1 when concordant, many-to-many otherwise). O(n), cached, and gated by translateCheap() so
  // hover stays interactive on big stores — there the cross-vocabulary link waits for a click. See
  // memory: viewer-entity-translation. cachedCat reads only warmed metadata (cell_type/leiden/... in init).
  private centroidCache = new Map<string, [number, number] | null>();
  private xlateCache = new Map<string, { value: string; frac: number }[]>();
  private cachedCat(field: string): any { const m = this.meta.get(field); return m && m.kind === "categorical" ? m : null; }

  /** The categorical field the embedding is keyed on now — its colour, or cell_type/leiden when colouring by a gene/qc. */
  keyGrouping(): string {
    const cb = this.coord.state.colorBy;
    if (cb.startsWith("meta:") && this.cachedCat(cb.slice(5))) return cb.slice(5);
    return this.view.ds.hasField("cell_type") ? "cell_type" : "leiden";
  }
  /** The category of one cell in a grouping (null if unknown). */
  categoryAt(grouping: string, index: number): string | null { const m = this.cachedCat(grouping); if (!m) return null; const c = m.codes[index]; return c >= 0 ? m.categories[c] : null; }
  /** Cheap enough to translate on hover (else defer the cross-vocabulary link to a click)? */
  translateCheap(): boolean { return this.n <= 150_000; }
  /** Embedding-space centroid of a category's cells — the locator-ring anchor. Cached; O(n) first time. */
  categoryCentroid(grouping: string, value: string): [number, number] | null {
    const key = grouping + "\u0000" + value; const hit = this.centroidCache.get(key); if (hit !== undefined) return hit;
    const m = this.cachedCat(grouping); let xy: [number, number] | null = null;
    if (m) { const ci = m.categories.indexOf(value);
      if (ci >= 0) { const emb = this.embedding.data; let sx = 0, sy = 0, cnt = 0;
        for (let i = 0; i < this.n; i++) if (m.codes[i] === ci) { sx += emb[i * 2]; sy += emb[i * 2 + 1]; cnt++; }
        if (cnt) xy = [sx / cnt, sy / cnt]; } }
    this.centroidCache.set(key, xy); return xy;
  }
  /** Mean expression of each gene within a cell set, SPLIT by a factor (e.g. donor) — the concordance matrix:
   *  markers that agree across donors = a real merged cell type; divergent ones = residual batch. genes × levels. */
  async groupStatsSplit(genes: string[], cellSet: Int32Array, splitGrouping: string): Promise<{ levels: string[]; genes: string[]; means: number[][] }> {
    const sm = this.cachedCat(splitGrouping);
    if (!sm || !cellSet.length) return { levels: [], genes, means: [] };
    const present: number[] = []; for (let j = 0; j < cellSet.length; j++) { const c = sm.codes[cellSet[j]]; if (c >= 0 && !present.includes(c)) present.push(c); }
    present.sort((a, b) => a - b);
    const levels = present.map((c) => sm.categories[c]);
    const means: number[][] = [];
    for (const g of genes) {
      const { values } = await this.view.geneExpression(g);
      const sum = present.map(() => 0), cnt = present.map(() => 0);
      for (let j = 0; j < cellSet.length; j++) { const i = cellSet[j], di = present.indexOf(sm.codes[i]); if (di >= 0) { sum[di] += values[i]; cnt[di]++; } }
      means.push(sum.map((s, di) => (cnt[di] ? s / cnt[di] : 0)));
    }
    return { levels, genes, means };
  }

  /** Cells matching ALL of a set of category constraints (e.g. cell_type="CD8+ T cells" ∧ sample="GSM5746259").
   *  The intersection that scopes a per-donor-within-cluster compute — the residual-batch DE's two sides. */
  cellsOfCategories(constraints: { grouping: string; value: string }[]): Int32Array {
    if (!constraints.length) return new Int32Array(0);
    const cols = constraints.map((c) => { const m = this.cachedCat(c.grouping); return { m, code: m ? m.categories.indexOf(c.value) : -1 }; });
    if (cols.some((c) => !c.m || c.code < 0)) return new Int32Array(0);
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) { let ok = true; for (const c of cols) if (c.m.codes[i] !== c.code) { ok = false; break; } if (ok) out.push(i); }
    return Int32Array.from(out);
  }

  /** The cells of a category — a cluster-click/category-click resolves to this cell SET (the canonical selection). */
  cellsOfCategory(grouping: string, value: string): Int32Array {
    const m = this.cachedCat(grouping); if (!m) return new Int32Array(0);
    const ci = m.categories.indexOf(value); if (ci < 0) return new Int32Array(0);
    const out: number[] = []; for (let i = 0; i < this.n; i++) if (m.codes[i] === ci) out.push(i);
    return Int32Array.from(out);
  }
  /** Read an arbitrary selected cell SET in a grouping's vocabulary (which categories it covers, ranked). */
  cellsToCategories(ids: Int32Array | null, grouping: string): { value: string; frac: number }[] {
    const m = this.cachedCat(grouping); if (!m || !ids || !ids.length) return [];
    const counts = new Int32Array(m.categories.length); let tot = 0;
    for (let j = 0; j < ids.length; j++) { const c = m.codes[ids[j]]; if (c >= 0) { counts[c]++; tot++; } }
    const out: { value: string; frac: number }[] = [];
    for (let k = 0; k < counts.length; k++) if (counts[k]) out.push({ value: m.categories[k], frac: counts[k] / tot });
    out.sort((a, b) => b.frac - a.frac); return out;
  }

  // ---- resolve a typed EntityRef into a receiver's own vocabulary ----
  // Each panel calls the resolver it needs; the ref is interpreted directly when types match, translated
  // via cells when they don't. An empty result = "nothing to react to" (a receiver may then ignore it).
  /** The cell SET a ref denotes (for cell-space panels like the embedding). */
  refToCells(ref: EntityRef | null): Int32Array {
    if (!ref) return new Int32Array(0);
    return ref.kind === "cells" ? ref.ids : this.cellsOfCategory(ref.grouping, ref.value);
  }
  /** A ref read as categories of `grouping` (for category/proportion panels): direct if same grouping, else via cells. */
  refToCategories(ref: EntityRef | null, grouping: string): { value: string; frac: number }[] {
    if (!ref) return [];
    if (ref.kind === "category") return ref.grouping === grouping ? [{ value: ref.value, frac: 1 }] : this.translate(ref.grouping, ref.value, grouping);
    return this.cellsToCategories(ref.ids, grouping);
  }
  /** The current committed selection as a cell set — what the agent/DE/QC operate on. */
  selectedCells(): Int32Array { return this.refToCells(this.coord.state.selection); }
  /** The active L3 SUBSET as a cell set (the global `focus` restriction) — null when not subsetting. Data panels filter/
   *  recompute to it so a subset is coherent across views (the embedding hides the rest; tables/stats compute within it). */
  subsetCells(): Int32Array | null { const f = this.coord.state.focus; return f && f.ids.length ? (f.ids instanceof Int32Array ? f.ids : Int32Array.from(f.ids)) : null; }

  /** Map a category to the overlapping categories of another grouping via shared cells (ranked by fraction). Cached. */
  translate(srcGrouping: string, srcValue: string, dstGrouping: string): { value: string; frac: number }[] {
    if (srcGrouping === dstGrouping) return [{ value: srcValue, frac: 1 }];
    const key = srcGrouping + "\u0000" + srcValue + "\u0000" + dstGrouping; const hit = this.xlateCache.get(key); if (hit) return hit;
    const ms = this.cachedCat(srcGrouping), md = this.cachedCat(dstGrouping); const out: { value: string; frac: number }[] = [];
    if (ms && md) { const sc = ms.categories.indexOf(srcValue);
      if (sc >= 0) { const counts = new Int32Array(md.categories.length); let tot = 0;
        for (let i = 0; i < this.n; i++) if (ms.codes[i] === sc) { const dc = md.codes[i]; if (dc >= 0) { counts[dc]++; tot++; } }
        for (let k = 0; k < counts.length; k++) if (counts[k]) out.push({ value: md.categories[k], frac: counts[k] / tot });
        out.sort((a, b) => b.frac - a.frac); } }
    this.xlateCache.set(key, out); return out;
  }

  // The categorical fields that EXIST in the dataset — enumerated from the CATALOG (field encodings/roles) +
  // annotation layers + derived groupings. Synchronous and independent of what's been READ, so enumeration
  // surfaces (the agent's CellWorld, existence checks, pickers) see every categorical even before its codes are
  // materialized. Use this for "what categoricals exist"; use categoricalFields() only where the WARMED codes
  // are needed. (Decouples enumerate-from-catalog from materialize-lazily — the boot recipe no longer has to
  // warm a field just so it's enumerable.)
  catalogCategoricals(): string[] {
    return this.orderCats(this.metadataFields().filter((f) => f.kind === "categorical").map((f) => f.name));
  }
  // The categorical fields MATERIALIZED so far (codes/categories read into `this.meta`) — a subset of
  // catalogCategoricals(). Prefer catalogCategoricals() for enumeration; reach for this only where the warmed
  // data itself is consumed (categoricalValues / cachedCat), e.g. a crosstab that needs per-value counts.
  categoricalFields(): string[] {
    const out: string[] = [];
    for (const [k, m] of this.meta) if (m.kind === "categorical") out.push(k);
    return this.orderCats(out);
  }
  // Stable order shared by both accessors: the common names first (COMMON_LABELS order), then the store's own
  // field order, then overlays/derived (not in the store) last, keeping their relative order (V8 sort is stable).
  private orderCats(names: string[]): string[] {
    const fnames = this.view.ds.fieldNames();
    const rank = (k: string): number => {
      const ci = COMMON_LABELS.indexOf(k); if (ci >= 0) return ci;
      const fi = fnames.indexOf(k); return fi >= 0 ? COMMON_LABELS.length + fi : Number.MAX_SAFE_INTEGER;
    };
    return names.slice().sort((a, b) => rank(a) - rank(b));
  }
  /** The category values of a (cached) categorical field — sync; [] if unknown/unwarmed. */
  categoricalValues(field: string): string[] { const m = this.cachedCat(field); return m ? (m.categories as string[]) : []; }

  // Which precomputed groupings the store carries (markers/stats navigators), e.g. leiden, cell_type —
  // plus any app-side annotation layers, which behave identically (group stats/markers derived on the fly).
  groupings(): string[] {
    const stored = this.view.ds.axisNames()
      .filter((a) => a.startsWith("groups_"))
      .map((a) => a.slice("groups_".length))
      .filter((g) => this.view.ds.hasField(g));
    return [...this.annoNames, ...this.derivedNames].filter((a) => !stored.includes(a)).concat(stored);
  }

  // Every PER-CELL metadata field (obs column) the Metadata facet panel can browse — categorical (design,
  // clusters, annotation) and numeric (technical covariates) — plus app-side annotation layers and derived
  // groupings. Excludes the count matrix, embeddings, and the genes/groups-axis derived fields (stats_/markers_).
  // group is a soft section hint: "annotation" = a grouping/annotation layer; "covariate" = numeric; else "design".
  metadataFields(): { name: string; kind: "categorical" | "numeric"; group: "design" | "covariate" | "annotation" }[] {
    const out: { name: string; kind: "categorical" | "numeric"; group: "design" | "covariate" | "annotation" }[] = [];
    const groupingSet = new Set(this.groupings());
    const seen = new Set<string>();
    for (const name of this.view.ds.fieldNames()) {
      const f: any = this.view.ds.field(name); if (!f || f.role === "embedding") continue;
      if (/^(counts|stats_|markers_|de_|hvg_)/.test(name)) continue;   // derived / matrix fields, not obs columns
      const span: string[] = f.span || [];
      const perCell = span.length ? (span.length === 1 && span[0] === "cells")
                                  : (Array.isArray(f.shape) && f.shape.length === 1 && f.shape[0] === this.n);
      if (!perCell) continue;
      const kind: "categorical" | "numeric" = (f.encoding === "utf8" || f.encoding === "categorical" || f.role === "label") ? "categorical" : "numeric";
      const group: "design" | "covariate" | "annotation" = kind === "numeric" ? "covariate"
        : (groupingSet.has(name) || this.fieldRoles.get(name) === "annotation") ? "annotation" : "design";
      out.push({ name, kind, group }); seen.add(name);
    }
    for (const name of [...this.annoNames, ...this.derivedNames]) if (!seen.has(name)) { out.push({ name, kind: "categorical", group: "annotation" }); seen.add(name); }
    return out;
  }

  // ---- annotation layers (writable categoricals over the read-only store) ----
  // Register/replace a layer: install it as a view overlay (so colour/groupStats see it) AND in ctx.meta
  // (so cachedCat/categoricalValues/categoricalFields see it), then drop any stale stats for that name.
  setAnnotationLayer(name: string, codes: Int32Array, categories: string[]): void {
    const m: Metadata = { kind: "categorical", codes, categories, colors: categories.map((c) => this.labelColorIndex(c)) };
    this.view.setOverlay(name, m);
    this.meta.set(name, m);
    this.annoNames.add(name);
    this.gsCache.delete(name);
    for (const k of [...this.gsfcCache.keys()]) if (k.startsWith(name + "=") || k.startsWith(name + "·")) this.gsfcCache.delete(k);
    this.markerCache.delete(name);
    this.xlateCache.clear();   // cross-grouping translations involving this layer are now stale (a rename changes
    // which cluster→label each cell maps to); clearing the lazy cache forces correct re-translation. Without this,
    // refToCategories(cluster, "annotation") returned the OLD label after an edit → wrong card / coordination.
  }
  removeAnnotationLayer(name: string): void {
    this.view.removeOverlay(name); this.meta.delete(name); this.annoNames.delete(name);
    this.gsCache.delete(name); this.markerCache.delete(name);
  }
  // DERIVED groupings: rolled-up coarser levels of the working annotation (the hierarchy). A first-class
  // grouping for colour/group, but NOT a reconcile SOURCE (it's a view of the draft, not an opinion to compare).
  private derivedNames = new Set<string>();
  setDerivedGrouping(name: string, codes: Int32Array, categories: string[]): void {
    const m: Metadata = { kind: "categorical", codes, categories, colors: categories.map((c) => this.labelColorIndex(c)) };
    this.view.setOverlay(name, m); this.meta.set(name, m); this.derivedNames.add(name);
    this.gsCache.delete(name); this.markerCache.delete(name); this.xlateCache.clear();
  }
  clearDerivedGroupings(): void { for (const n of this.derivedNames) { this.view.removeOverlay(n); this.meta.delete(n); } this.derivedNames.clear(); }
  removeDerivedGrouping(name: string): void { if (this.derivedNames.has(name)) { this.view.removeOverlay(name); this.meta.delete(name); this.derivedNames.delete(name); } }
  derivedGroupings(): string[] { return [...this.derivedNames]; }
  annotationLayers(): string[] { return [...this.annoNames]; }
  isAnnotationLayer(name: string): boolean { return this.annoNames.has(name); }
  // Stable palette index for a cell-type label NAME — assigned on first sight, kept forever and SHARED across
  // layers, so "NK" is the same colour in every source + the working draft, and survives add/remove/rename.
  private labelColors = new Map<string, number>();
  labelColorIndex(name: string): number { let i = this.labelColors.get(name); if (i == null) { i = this.labelColors.size; this.labelColors.set(name, i); } return i; }

  // Preferred grouping for a fresh panel: a user/agent ANNOTATION if present, then cell_type, else the first
  // precomputed grouping (e.g. leiden). So panels in a workspace describe the SAME partition by default, and a
  // named biology layer (annotation/cell_type) takes precedence over bare clusters.
  defaultGrouping(): string {
    const gs = this.groupings();
    for (const pref of ["annotation", "cell_type"]) if (gs.includes(pref)) return pref;
    return gs[0] || "leiden";
  }

  // Best-guess ORGANISM from gene-symbol CASING — there's no species field in the store yet, and we stay symbol-keyed.
  // HGNC symbols are all-caps (TP53, CD14); MGI/Title-case (Trp53, Cd14) ⇒ a non-human (mouse-style) organism. A few
  // human "orf" symbols carry lowercase, so we go by the MAJORITY of a sample. Cached; defaults to human when ambiguous.
  private _organism?: string;
  async organism(): Promise<string> {
    if (this._organism) return this._organism;
    let lower = 0, upper = 0;
    try {
      const genes = await this.view.genes();
      for (const g of genes.slice(0, 300)) { if (!/[A-Za-z]/.test(g)) continue; (/[a-z]/.test(g) ? lower++ : upper++); }
    } catch { /* fall through to the default */ }
    this._organism = lower > upper ? "mouse" : "human";   // Title/lower-case majority ⇒ mouse (the common non-human case)
    return this._organism;
  }

  // A data-driven dataset brief for the agent's system prompt — derived from the actual store, so
  // the agent never narrates a different dataset's story. Cached. Names the available groupings,
  // the cell types, and the sample/condition design (incl. the n-per-condition cacoa caveat).
  private agentBrief?: string;
  async describeForAgent(): Promise<string> {
    if (this.agentBrief) return this.agentBrief;
    const org = await this.organism();
    const parts: string[] = [`${this.n.toLocaleString()} cells, ${this.view.nGenes.toLocaleString()} genes (${org === "human" ? "HGNC" : org} symbols)`];
    for (const g of this.groupings()) {
      const m = await this.metaOf(g) as any;
      const list = m.categories.slice(0, 24).join(", ");
      parts.push(`${g}: ${m.categories.length} groups${g === "cell_type" ? ` (${list})` : ""}`);
    }
    if (this.view.ds.hasField("sample")) {
      const s = await this.metaOf("sample") as any;
      let design = `samples: ${s.categories.join(", ")}`;
      if (this.view.ds.hasField("condition")) {
        const sc = await this.sampleConditions();
        const byCond = new Map<string, number>();
        for (const c of sc.values()) byCond.set(c, (byCond.get(c) || 0) + 1);
        design += `; conditions: ${[...byCond].map(([c, n]) => `${c} (${n} sample${n > 1 ? "s" : ""})`).join(", ")}`;
        if ([...byCond.values()].some((n) => n < 2)) design += " — n<2 per condition: a population-level condition claim is NOT supported (the donor is the replicate); say so";
      }
      parts.push(design);
    }
    // candidate categoricals the agent may classify as annotation sources (role still unset) — name (k: a,b,c…)
    const known = new Set(this.groupings());
    const cands = this.catalogCategoricals().filter((f) => !known.has(f) && this.fieldRole(f) === undefined);
    if (cands.length) parts.push("FIELDS to classify (set_field_roles if any are cell-type annotations vs covariate/qc): " + cands.map((f) => { const m = this.cachedCat(f); return `${f} (${m ? m.categories.length + ": " + m.categories.slice(0, 5).join(", ") : "?"})`; }).join("; "));
    return (this.agentBrief = parts.join(". "));
  }

  private gsCache = new Map<string, Awaited<ReturnType<LstarView["groupStats"]>>>();
  async groupStatsCached(grouping = "leiden") {
    if (!this.gsCache.has(grouping)) this.gsCache.set(grouping, await this.view.groupStats(grouping));
    return this.gsCache.get(grouping)!;
  }

  // Group stats (mean/frac per group×gene) computed over a CELL SUBSET — for faceting a dotplot to a population
  // (e.g. one condition). Same {groups, nGenes, mean, frac} shape as groupStatsCached; groups stay in the
  // grouping's full order so two scoped panels share identical columns. Cached per (grouping, scope key).
  private gsfcCache = new Map<string, Awaited<ReturnType<Ctx["groupStatsCached"]>>>();
  async groupStatsForCells(grouping: string, cellIds: ArrayLike<number>, key?: string): Promise<{ groups: string[]; nGenes: number; n: Int32Array; mean: Float32Array; frac: Float32Array }> {
    const ck = key ? `${grouping}:${key}` : "";
    if (ck && this.gsfcCache.has(ck)) return this.gsfcCache.get(ck)!;
    const m = await this.metaOf(grouping) as any;
    const { mean, frac, n } = await this.view.groupStatsForCells(m.codes, m.categories.length, cellIds);
    const out = { groups: m.categories as string[], nGenes: this.view.nGenes, n, mean, frac };
    if (ck) this.gsfcCache.set(ck, out);
    return out;
  }

  // GENE-SLICE subset stats (the dotplot's L3 recompute): per-(group,gene) mean/frac over `cellIds`, computed by
  // reading ONLY `geneCols` from gene-major counts — same shape as groupStatsForCells, a few MB not the whole matrix.
  async groupStatsForGenes(grouping: string, geneCols: number[], cellIds: ArrayLike<number>, key?: string): Promise<{ groups: string[]; nGenes: number; n: Int32Array; mean: Float32Array; frac: Float32Array }> {
    const ck = key ? `${grouping}:${key}:g${geneCols.join(",")}` : "";
    if (ck && this.gsfcCache.has(ck)) return this.gsfcCache.get(ck)!;
    const m = await this.metaOf(grouping) as any;
    const { mean, frac, n } = await this.view.groupStatsForGenesInSubset(m.codes, m.categories.length, geneCols, cellIds);
    const out = { groups: m.categories as string[], nGenes: this.view.nGenes, n, mean, frac };
    if (ck) this.gsfcCache.set(ck, out);
    return out;
  }

  // per-sample distribution of a gene within an optional cluster (the replicate view)
  async exprBySample(gene: string, clusterName?: string): Promise<{ sample: string; cond: string; vals: number[]; mean: number }[]> {
    const { values } = await this.view.geneExpression(gene);
    const s = await this.metaOf("sample") as any, c = await this.metaOf("condition") as any;
    const lei = clusterName ? (await this.metaOf("leiden") as any) : null;
    const lcode = lei ? lei.categories.indexOf(clusterName) : -1;
    const bins = s.categories.map((sm: string, si: number) => ({ sample: sm, cond: c.categories[firstCondCode(c, s, si)], vals: [] as number[], mean: 0 }));
    for (let i = 0; i < this.n; i++) {
      if (lei && lei.codes[i] !== lcode) continue;
      bins[s.codes[i]].vals.push(values[i]);
    }
    for (const b of bins) b.mean = b.vals.length ? b.vals.reduce((a, x) => a + x, 0) / b.vals.length : 0;
    return bins;
  }

  // ----- handle catalog -----
  handleOf(bind?: string): HandleMeta | undefined {
    if (!bind) return undefined;
    if (bind === "embedding:main") return { prov: `UMAP · ${this.n.toLocaleString()} cells` };
    if (bind === "composition:bySample") return { prov: "per-sample cluster proportions", caveat: "Proportions sum to 1 — a rise in one cluster forces others down. Use a compositional test, not per-cluster comparisons." };
    if (bind?.startsWith("expr:")) return { prov: "per-donor aggregation", caveat: "This is the replicate view: each point is a donor mean. One donor can carry an apparent shift." };
    if (bind?.startsWith("code:")) return { prov: "custom code", caveat: "Produced by ad-hoc agent code, not a validated primitive — sanity-check it before trusting or reporting it." };
    if (bind?.startsWith("pseudobulk:")) return { prov: "pseudobulk · donor-level test", caveat: "Donor-level: each group is summarised to one mean PER REPLICATE, then a Welch t-test runs across replicates — the replicate is the unit, so the p-value is real (not cell-level). Power is limited by the NUMBER of replicates; with few, one donor can still drive a hit — check the per-sample spread of the top genes before reporting." };
    if (bind?.startsWith("de:between")) return { prov: "two-group DE · ranking-grade", caveat: "Two groups compared directly (not vs rest): logFC>0 favours the A column, logFC<0 the B column. Cell-level ranking — the donor is the replicate; for a population claim run compute stat:'pseudobulk' (replicate:<donor field>), and both group boundaries are post-hoc." };
    if (bind?.startsWith("de:selection")) return { prov: "subsample DE · ranking-grade", caveat: "Approximate (sampled cells), ranking-grade only. The donor is the replicate — verify per-sample before any population-level claim; the selection boundary is post-hoc." };
    if (bind?.startsWith("de:")) return { prov: "marker test · cluster vs rest", caveat: "Cell-level ranking. For a population-level claim use pseudobulk across donors; the cluster boundary is post-hoc." };
    return undefined;
  }
}

function firstCondCode(c: any, s: any, si: number): number {
  for (let i = 0; i < s.codes.length; i++) if (s.codes[i] === si) return c.codes[i];
  return 0;
}
