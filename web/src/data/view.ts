// View over an L* store: the typed-array seam the app turns into pixels. Heavy reductions use
// the real libstar WASM kernels when available (numbers match R/Python), with a pure-TS fallback.
import type { LstarDataset } from "./store.ts";
import { kernels } from "./kernels.ts";
import { DIM_RGB, DIM_A, themeIsDark } from "../render/theme.ts";   // theme-aware non-focus dot colour (live binding)
import { sample, overdispersedCore, deCore } from "../compute/odcore.ts";   // pure kernel cores (shared by the fallback, the worker, and node tests)
import type { ComputePool } from "../compute/pool.ts";
import { isolationAvailable } from "../compute/pool.ts";

export type Metadata =
  | { kind: "categorical"; codes: Int32Array; categories: string[]; colors?: number[] }   // colors = per-category palette INDEX (annotation layers use a stable name→colour map)
  | { kind: "numeric"; values: Float32Array; min: number; max: number };

export interface DEResult { gene: number; symbol: string; meanA: number; meanB: number; lfc: number; }

// Categorical levels arrive in stored / first-seen order, so a numeric grouping like leiden ("0".."27")
// renders lexically (0,1,10,11,…,2). When EVERY label is a clean number we sort numerically — applied at
// EVERY place a group order is established (metadata codes, precomputed group stats, markers) so all paths
// agree and faceted panels stay aligned. Named categoricals (cell_type, sample, …) are left untouched.
// Returns the permutation new→old (newOrder[i] = old index now at position i), or null when no reorder is needed.
function numericGroupOrder(labels: string[]): number[] | null {
  if (labels.length < 2 || !labels.every((c) => c.trim() !== "" && Number.isFinite(Number(c)))) return null;
  const order = labels.map((_, i) => i).sort((a, b) => Number(labels[a]) - Number(labels[b]));
  return order.every((o, i) => o === i) ? null : order;
}
// Reorder G column-blocks of a [G × stride] flat array per the new→old permutation.
function reblock(a: Float64Array, order: number[], stride: number): Float64Array {
  const out = new Float64Array(a.length);
  for (let ni = 0; ni < order.length; ni++) { const src = order[ni] * stride, dst = ni * stride; for (let j = 0; j < stride; j++) out[dst + j] = a[src + j]; }
  return out;
}
function reorderNumericCategorical(m: { kind: "categorical"; codes: Int32Array; categories: string[] }): Metadata {
  const order = numericGroupOrder(m.categories);
  if (!order) return m;
  const remap = new Int32Array(m.categories.length); order.forEach((oldIdx, newIdx) => { remap[oldIdx] = newIdx; });
  const codes = new Int32Array(m.codes.length);
  for (let i = 0; i < m.codes.length; i++) { const c = m.codes[i]; codes[i] = c >= 0 ? remap[c] : c; }
  return { kind: "categorical", codes, categories: order.map((i) => m.categories[i]) };
}

// Copy a typed array into a SharedArrayBuffer-backed view so the compute worker can map it ZERO-COPY (post the .buffer →
// it's shared, not cloned). Only when cross-origin isolated; otherwise returns the array unchanged (main-thread path).
// One-time cost at panel load; the matrix then lives ONCE, shared by the main thread + every worker.
function toShared<T extends Float64Array | Int32Array>(arr: T): T {
  if (!isolationAvailable() || arr.buffer instanceof SharedArrayBuffer) return arr;
  const Ctor = arr.constructor as { new (b: SharedArrayBuffer): T };
  const view = new Ctor(new SharedArrayBuffer(arr.byteLength));
  (view as Float64Array | Int32Array).set(arr as any);
  return view;
}

export class LstarView {
  ds: LstarDataset;
  private geneLabels?: string[];
  private geneIndex?: Map<string, number>;
  private cscCache?: { data: Float64Array; indices: Int32Array; indptr: Int32Array; nGenes: number };
  // cell-major counts panel (viewer profile): undefined = not checked, null = absent in this store.
  // `lognorm` = values already log1p (legacy) vs raw (log1p on read); `geneCol` maps the panel's
  // gene axis to global gene indices when it's a subset (legacy od_genes), else null (all genes).
  private dePanelCache?: { data: Float64Array; indices: Int32Array; indptr: Int32Array; symbols: string[]; geneCol: Int32Array | null; nGenes: number; lognorm: boolean; shared: boolean } | null;
  // Off-main-thread compute pool (S1+). Set by main.ts after construction; kernels dispatch to it when isolation is
  // available + the panel is SAB-backed, else they run the SAME pure core inline (so the app is correct either way).
  private computePool?: ComputePool;
  setComputePool(p: ComputePool) { this.computePool = p; }

  constructor(ds: LstarDataset) { this.ds = ds; }

  get nCells() { return this.ds.axisLength("cells"); }
  get nGenes() { return this.ds.axisLength("genes"); }

  async genes(): Promise<string[]> {
    if (!this.geneLabels) {
      this.geneLabels = await this.ds.axisLabels("genes");
      this.geneIndex = new Map(this.geneLabels.map((g, i) => [g, i]));
    }
    return this.geneLabels;
  }
  async geneCol(symbol: string): Promise<number | undefined> {
    await this.genes();
    return this.geneIndex!.get(symbol);
  }

  async embedding(name = "umap"): Promise<{ data: Float32Array; n: number; dim: number }> {
    const { data, shape } = await this.ds.fieldDense(name);
    const n = shape[0], dim = shape[1] ?? 1;
    const out = data instanceof Float32Array ? data : Float32Array.from(data as any);
    return { data: out, n, dim };
  }

  // App-side categorical overlays (annotation layers): metadata() returns these before the zarr, so an
  // annotation layer behaves like any stored categorical for colour/groupStats/markers. setOverlay also
  // clears any cached group stats for that name so re-labeling the working draft recomputes.
  overlays = new Map<string, Metadata>();
  setOverlay(name: string, m: Metadata) { this.overlays.set(name, m); this.gssCache.delete(name); }
  removeOverlay(name: string) { this.overlays.delete(name); this.gssCache.delete(name); }

  async metadata(name: string): Promise<Metadata> {
    if (this.overlays.has(name)) return this.overlays.get(name)!;
    const m = this.ds.field(name);
    if (!m) throw new Error("no field " + name);
    if (m.encoding === "utf8" || m.role === "label") {
      const vals = await this.ds.fieldStrings(name);
      const cats: string[] = [];
      const ix = new Map<string, number>();
      const codes = new Int32Array(vals.length);
      for (let i = 0; i < vals.length; i++) {
        let c = ix.get(vals[i]);
        if (c === undefined) { c = cats.length; cats.push(vals[i]); ix.set(vals[i], c); }
        codes[i] = c;
      }
      return reorderNumericCategorical({ kind: "categorical", codes, categories: cats });
    }
    const { data } = await this.ds.fieldDense(name);
    const values = data instanceof Float32Array ? data : Float32Array.from(data as any);
    let mn = Infinity, mx = -Infinity;
    for (const v of values) { if (v < mn) mn = v; if (v > mx) mx = v; }
    return { kind: "numeric", values, min: mn, max: mx };
  }

  // Per-cell scalar for one gene (lognorm), via a single CSC column read.
  private geneExprCache = new Map<string, { values: Float32Array; max: number; col: number }>();
  async geneExpression(symbol: string, lognorm = true): Promise<{ values: Float32Array; max: number; col: number }> {
    // cache per gene: expression is immutable core data, but it was re-fetched + re-decompressed on EVERY repaint
    // — so colouring by a gene made every selection change (focus-mask only) re-derive the whole column (~700ms).
    const key = symbol + (lognorm ? "" : "|raw");
    const hit = this.geneExprCache.get(key); if (hit) return hit;
    const col = await this.geneCol(symbol);
    if (col === undefined) throw new Error("no gene " + symbol);
    const { rows, vals } = await this.ds.cscColumn("counts", col);
    const out = new Float32Array(this.nCells);
    let max = 0;
    for (let k = 0; k < rows.length; k++) {
      const v = lognorm ? Math.log1p(vals[k]) : vals[k];
      out[rows[k]] = v;
      if (v > max) max = v;
    }
    const res = { values: out, max, col };
    if (this.geneExprCache.size >= 32) this.geneExprCache.delete(this.geneExprCache.keys().next().value!);   // simple bound (~140KB/gene)
    this.geneExprCache.set(key, res);
    return res;
  }

  // Full counts in CSC (gene-major), loaded + cached once. Backs the group-stats / DE fallbacks.
  private async countsCSC() {
    if (!this.cscCache) {
      const sp = await this.ds.fieldSparse("counts");
      this.cscCache = {
        data: sp.data instanceof Float64Array ? sp.data : Float64Array.from(sp.data as any),
        indices: sp.indices instanceof Int32Array ? sp.indices : Int32Array.from(sp.indices as any),
        indptr: sp.indptr instanceof Int32Array ? sp.indptr : Int32Array.from(sp.indptr as any),
        nGenes: sp.shape[1],
      };
    }
    return this.cscCache;
  }

  // Per-(group, gene) sufficient stats over log1p — read from the viewer profile when present, else
  // computed in-browser from counts via the libstar WASM kernel (so a *bare* L* store, with no
  // precomputed navigators, is fully viewable; precompute is an optimization, not a requirement).
  private gssCache = new Map<string, { groups: string[]; n: Int32Array; S: Float64Array; SS: Float64Array; NE: Float64Array }>();
  private async groupSufficientStats(grouping: string) {
    const cached = this.gssCache.get(grouping);
    if (cached) return cached;
    const ng = this.nGenes;
    const md = await this.metadata(grouping);
    if (md.kind !== "categorical") throw new Error(`grouping ${grouping} is not categorical`);
    let groups: string[], S: Float64Array, SS: Float64Array, NE: Float64Array;
    if (this.ds.hasField(`stats_${grouping}_sum`) && this.ds.axisNames().includes(`groups_${grouping}`)) {
      groups = await this.ds.axisLabels(`groups_${grouping}`);
      const f64 = (a: any) => (a instanceof Float64Array ? a : Float64Array.from(a));
      S = f64((await this.ds.fieldDense(`stats_${grouping}_sum`)).data);
      SS = f64((await this.ds.fieldDense(`stats_${grouping}_sumsq`)).data);
      NE = f64((await this.ds.fieldDense(`stats_${grouping}_nexpr`)).data);
    } else {
      groups = md.categories.slice();
      const G = groups.length, code = md.codes;          // 0-based into categories (== groups order)
      const cc = await this.countsCSC();
      const M = await kernels();
      if (M) {
        const g = M.colSumByGroup(cc.data, cc.indptr, cc.indices, this.nCells, cc.nGenes, Int32Array.from(code), G, true);
        S = g.sum as Float64Array; SS = g.sumsq as Float64Array; NE = g.n_expr as Float64Array;
      } else {
        S = new Float64Array(G * ng); SS = new Float64Array(G * ng); NE = new Float64Array(G * ng);
        const { data, indices, indptr } = cc;
        for (let gene = 0; gene < ng; gene++) for (let k = indptr[gene]; k < indptr[gene + 1]; k++) {
          const grp = code[indices[k]]; if (grp < 0) continue;
          const v = Math.log1p(data[k]), o = grp * ng + gene; S[o] += v; SS[o] += v * v; NE[o]++;
        }
      }
    }
    // unify column order with metadata (numeric for leiden-like groupings) so faceted/scoped panels align
    const gord = numericGroupOrder(groups);
    if (gord) { groups = gord.map((i) => groups[i]); S = reblock(S, gord, ng); SS = reblock(SS, gord, ng); NE = reblock(NE, gord, ng); }
    const gi = new Map(groups.map((g, i) => [g, i]));
    const n = new Int32Array(groups.length);
    for (const c of md.codes) { const idx = gi.get(md.categories[c]); if (idx !== undefined) n[idx]++; }
    const r = { groups, n, S, SS, NE };
    this.gssCache.set(grouping, r);
    return r;
  }

  // Cluster sufficient stats -> per (group, gene) mean/frac (precomputed or on the fly).
  async groupStats(grouping = "leiden"): Promise<{
    groups: string[]; nGenes: number; n: Int32Array; mean: Float32Array; frac: Float32Array;
  }> {
    const { groups, n, S, NE } = await this.groupSufficientStats(grouping);
    const G = groups.length, ng = this.nGenes;
    const mean = new Float32Array(G * ng), frac = new Float32Array(G * ng);
    for (let g = 0; g < G; g++) {
      const nn = Math.max(n[g], 1);
      for (let j = 0; j < ng; j++) { mean[g * ng + j] = S[g * ng + j] / nn; frac[g * ng + j] = NE[g * ng + j] / nn; }
    }
    return { groups, nGenes: ng, n, mean, frac };
  }

  // Per (group, gene) mean(log1p) + fraction-expressing computed over a CELL SUBSET (e.g. one condition's
  // cells), via the cell-major CSR panel. Lets a dotplot be FACETED — the same genes×groups grid, with dots
  // reflecting just that subset — so two scoped panels (day0 / day7) are directly comparable. `codes` maps each
  // cell to its group index; G = number of groups. Genes are global indices (matches markers' gene ids).
  async groupStatsForCells(codes: ArrayLike<number>, G: number, cellIds: ArrayLike<number>): Promise<{ mean: Float32Array; frac: Float32Array; n: Int32Array }> {
    const ng = this.nGenes;
    const mean = new Float32Array(G * ng), frac = new Float32Array(G * ng), n = new Int32Array(G);
    const dp = await this.dePanel(); if (!dp) return { mean, frac, n };   // no cell-major panel → no faceting (caller falls back)
    const { data, indices, indptr, geneCol, lognorm } = dp;
    const sum = new Float64Array(G * ng), nz = new Float64Array(G * ng);
    for (let j = 0; j < cellIds.length; j++) {
      const i = cellIds[j], grp = codes[i]; if (grp < 0 || grp >= G) continue; n[grp]++;
      const base = grp * ng;
      for (let k = indptr[i]; k < indptr[i + 1]; k++) { const gc = geneCol ? geneCol[indices[k]] : indices[k]; sum[base + gc] += lognorm ? data[k] : Math.log1p(data[k]); nz[base + gc]++; }
    }
    for (let grp = 0; grp < G; grp++) { const cnt = Math.max(n[grp], 1), base = grp * ng; for (let g = 0; g < ng; g++) { mean[base + g] = sum[base + g] / cnt; frac[base + g] = nz[base + g] / cnt; } }
    return { mean, frac, n };
  }

  // Ranked marker genes per group. Reads the precomputed table when present, else derives markers
  // (group mean(log1p) vs rest) from on-the-fly group stats — so a bare store still gets markers.
  async markers(grouping = "leiden", topN = 25): Promise<Map<string, { gene: number; symbol: string; lfc: number; padj: number }[]>> {
    const genes = await this.genes();
    const out = new Map<string, { gene: number; symbol: string; lfc: number; padj: number }[]>();
    if (this.ds.hasField(`markers_${grouping}_lfc`) && this.ds.axisNames().includes(`groups_${grouping}`)) {
      const groups = await this.ds.axisLabels(`groups_${grouping}`);
      const lfc = (await this.ds.fieldDense(`markers_${grouping}_lfc`)).data as ArrayLike<number>;
      const padj = (await this.ds.fieldDense(`markers_${grouping}_padj`)).data as ArrayLike<number>;
      const G = groups.length, ng = genes.length;
      for (let g = 0; g < G; g++) {
        const rows = []; for (let j = 0; j < ng; j++) rows.push({ gene: j, symbol: genes[j], lfc: lfc[j * G + g], padj: padj[j * G + g] });
        rows.sort((a, b) => b.lfc - a.lfc); out.set(groups[g], rows.slice(0, topN));
      }
      return out;
    }
    const { groups, n, S, NE } = await this.groupSufficientStats(grouping);
    const G = groups.length, ng = this.nGenes, N = this.nCells;
    const grand = new Float64Array(ng);
    for (let g = 0; g < G; g++) for (let j = 0; j < ng; j++) grand[j] += S[g * ng + j];
    for (let g = 0; g < G; g++) {
      const ng1 = Math.max(n[g], 1), nr = Math.max(N - n[g], 1);
      const rows = [];
      for (let j = 0; j < ng; j++) {
        const mu = S[g * ng + j] / ng1, mr = (grand[j] - S[g * ng + j]) / nr, lfc = mu - mr;
        const padj = Math.min(Math.max(Math.exp(-Math.abs(lfc * Math.sqrt(NE[g * ng + j] + 1))), 1e-12), 1);
        rows.push({ gene: j, symbol: genes[j], lfc, padj });
      }
      rows.sort((a, b) => b.lfc - a.lfc); out.set(groups[g], rows.slice(0, topN));
    }
    return out;
  }

  // Subsample DE on arbitrary selections — the gene scope is the WHOLE transcriptome.
  //  Fast path — the cell-major counts panel (counts_cellmajor, CSR over all genes): subsample the
  //  cells, read only their rows, reduce over EVERY gene. Cost is O(sampled cells); the gene scope
  //  is never restricted, because a global overdispersed subset would miss the genes that actually
  //  distinguish a local selection (e.g. T-cell subsets). Fallback — full-counts CSC + WASM kernel.
  async subsampleDE(cellsA: number[], cellsB: number[], maxPerGroup = 400):
      Promise<{ ranked: DEResult[]; nA: number; nB: number; approx: boolean; panel: boolean; nGenesRanked: number }> {
    const A = sample(cellsA, maxPerGroup), B = sample(cellsB, maxPerGroup);
    const approx = A.length < cellsA.length || B.length < cellsB.length;
    const na = Math.max(A.length, 1), nb = Math.max(B.length, 1);

    const dp = await this.dePanel();
    if (dp) {
      // Whole-transcriptome reduction over the cell-major panel — OFF the main thread when isolated + the panel is
      // SAB-backed, else the SAME deCore inline (byte-identical). The core returns the panel gene index g; we map
      // g -> {global gene, symbol} here. A worker failure degrades to the inline core.
      const panel = { data: dp.data, indices: dp.indices, indptr: dp.indptr, nGenes: dp.nGenes, lognorm: dp.lognorm };
      const inline = () => deCore(panel, A, B);
      let raw: { g: number; meanA: number; meanB: number; lfc: number }[];
      if (this.computePool?.isolated && dp.shared) {
        try { raw = await this.computePool.run("de", { panel: { data: dp.data.buffer, indices: dp.indices.buffer, indptr: dp.indptr.buffer, nGenes: dp.nGenes, lognorm: dp.lognorm }, A, B }); }
        catch { raw = inline(); }
      } else { raw = inline(); }
      const ranked: DEResult[] = raw.map((r) => ({ gene: dp.geneCol ? dp.geneCol[r.g] : r.g, symbol: dp.symbols[r.g], meanA: r.meanA, meanB: r.meanB, lfc: r.lfc }));
      return { ranked, nA: A.length, nB: B.length, approx, panel: true, nGenesRanked: dp.nGenes };
    }

    // Fallback: load counts CSC once (cached), per-group sums via the libstar WASM kernel.
    const { data, indices, indptr, nGenes } = await this.countsCSC();
    let sumA: Float64Array, sumB: Float64Array;
    const M = await kernels();
    if (M) {
      // membership over cells: 0=A, 1=B, -1=skip -> per-group sums via the libstar WASM kernel
      const membership = new Int32Array(this.nCells).fill(-1);
      A.forEach((i) => (membership[i] = 0)); B.forEach((i) => (membership[i] = 1));
      const g = M.colSumByGroup(data, indptr, indices, this.nCells, nGenes, membership, 2, true);
      sumA = (g.sum as Float64Array).subarray(0, nGenes); sumB = (g.sum as Float64Array).subarray(nGenes, 2 * nGenes);
    } else {
      const inA = new Uint8Array(this.nCells), inB = new Uint8Array(this.nCells);
      A.forEach((i) => (inA[i] = 1)); B.forEach((i) => (inB[i] = 1));
      sumA = new Float64Array(nGenes); sumB = new Float64Array(nGenes);
      for (let g = 0; g < nGenes; g++) for (let k = indptr[g]; k < indptr[g + 1]; k++) { const r = indices[k], v = Math.log1p(data[k]); if (inA[r]) sumA[g] += v; else if (inB[r]) sumB[g] += v; }
    }
    const genes = await this.genes();
    const ranked: DEResult[] = [];
    for (let g = 0; g < nGenes; g++) {
      const ma = sumA[g] / na, mb = sumB[g] / nb;
      ranked.push({ gene: g, symbol: genes[g], meanA: ma, meanB: mb, lfc: ma - mb });
    }
    ranked.sort((a, b) => Math.abs(b.lfc) - Math.abs(a.lfc));
    return { ranked, nA: A.length, nB: B.length, approx, panel: false, nGenesRanked: nGenes };
  }

  // Load + cache the cell-major counts panel (CSR over (cells, genes)) once. `counts_cellmajor` is
  // the current name; `de_panel` (a legacy od-genes subset, log1p) is still read if present. For a
  // BARE store (neither field), the panel is built in-browser by transposing counts CSC->CSR with
  // the libstar WASM kernel — so on-the-fly DE / overdispersion work without any precompute.
  private async dePanel() {
    if (this.dePanelCache !== undefined) return this.dePanelCache;
    const name = this.ds.hasField("counts_cellmajor") ? "counts_cellmajor"
      : (this.ds.hasField("de_panel") ? "de_panel" : null);
    if (!name) {
      const M = await kernels();
      if (!M || !this.ds.hasField("counts")) { this.dePanelCache = null; return null; }
      const cc = await this.countsCSC();                  // counts CSC (cells,genes) -> CSR cell-major
      const r = M.cscToCsr(cc.data, cc.indices, cc.indptr, this.nCells, cc.nGenes);
      const symbols = await this.genes();
      const data = toShared(r.data instanceof Float64Array ? r.data : Float64Array.from(r.data as any));
      this.dePanelCache = {
        data,
        indices: toShared(r.indices instanceof Int32Array ? r.indices : Int32Array.from(r.indices as any)),
        indptr: toShared(r.indptr instanceof Int32Array ? r.indptr : Int32Array.from(r.indptr as any)),
        symbols, geneCol: null, nGenes: symbols.length, lognorm: false, shared: isolationAvailable() && data.buffer instanceof SharedArrayBuffer,
      };
      return this.dePanelCache;
    }
    const fm = this.ds.field(name)!;
    const geneAxis = fm.span[1] ?? "genes";
    const allGenes = geneAxis === "genes";
    const symbols = allGenes ? await this.genes() : await this.ds.axisLabels(geneAxis);
    let geneCol: Int32Array | null = null;
    if (!allGenes) { await this.genes(); geneCol = Int32Array.from(symbols.map((s) => this.geneIndex!.get(s) ?? -1)); }
    const sp = await this.ds.fieldSparse(name);
    const data = toShared(sp.data instanceof Float64Array ? sp.data : Float64Array.from(sp.data as any));
    this.dePanelCache = {
      data,
      indices: toShared(sp.indices instanceof Int32Array ? sp.indices : Int32Array.from(sp.indices as any)),
      indptr: toShared(sp.indptr instanceof Int32Array ? sp.indptr : Int32Array.from(sp.indptr as any)),
      symbols, geneCol, nGenes: symbols.length, lognorm: fm.state === "lognorm", shared: isolationAvailable() && data.buffer instanceof SharedArrayBuffer,
    };
    return this.dePanelCache;
  }

  // Scope-aware overdispersed genes (HVG). Subsamples the cells in `cellIds`, computes per-gene
  // mean/var of log1p over that subsample from the cell-major counts, and ranks genes by their
  // residual ABOVE the smoothed mean-variance trend — pagoda2's gene-relative overdispersion
  // (log(v) ~ smooth(log(m)); res = observed - fitted). This is the *correct* HVG for a focused
  // subset (T cells only, a lasso, ...): the trend and the residuals are recomputed for that scope,
  // never read off a global precomputed list (which is dominated by major-lineage genes).
  async overdispersedGenes(cellIds: number[], topN = 50, maxCells = 2000):
      Promise<{ gene: number; symbol: string; mean: number; varr: number; resid: number; nobs: number }[]> {
    const dp = await this.dePanel();
    if (!dp) return [];
    // OFF the main thread when isolated + the panel is SAB-backed (posting it SHARES, no copy); else run the SAME core
    // inline. Both paths call overdispersedCore → byte-identical; only the thread differs. The core returns the PANEL
    // gene index g; we map g -> {global gene, symbol} HERE (so no symbol table crosses to the worker).
    const inline = () => overdispersedCore({ data: dp.data, indices: dp.indices, indptr: dp.indptr, nGenes: dp.nGenes, lognorm: dp.lognorm }, cellIds, topN, maxCells);
    let raw: { g: number; mean: number; varr: number; resid: number; nobs: number }[];
    if (this.computePool?.isolated && dp.shared) {
      // worker is an OPTIMIZATION; any worker failure degrades to the identical main-thread core (never throws on the kernel).
      try {
        raw = await this.computePool.run("overdispersion", {
          panel: { data: dp.data.buffer, indices: dp.indices.buffer, indptr: dp.indptr.buffer, nGenes: dp.nGenes, lognorm: dp.lognorm },
          cellIds: Array.from(cellIds), topN, maxCells,
        });
      } catch { raw = inline(); }
    } else {
      raw = inline();
    }
    return raw.map((r) => ({ gene: dp.geneCol ? dp.geneCol[r.g] : r.g, symbol: dp.symbols[r.g], mean: r.mean, varr: r.varr, resid: r.resid, nobs: r.nobs }));
  }
}

// (LOWESS, the overdispersion F-test, and the deterministic `sample` now live in compute/odcore.ts — shared by the
// main-thread fallback, the compute worker, and node tests.)

// ----- color helpers -----
const RAMP_LO = [27, 34, 48], RAMP_HI = [224, 164, 88]; // inset -> amber (matches the mock)
// out-of-selection cells go to a desaturated slate (kept VISIBLE as context) so the in-selection cells
// pop by colour + halo — clearer than dropping alpha toward invisible (the old behaviour).
export function scalarToRGBA(values: ArrayLike<number>, max: number, focusMask?: Uint8Array): Uint8Array {
  const n = values.length, out = new Uint8Array(n * 4), m = max || 1;
  for (let i = 0; i < n; i++) {
    if (focusMask && !focusMask[i]) { out[i * 4] = DIM_RGB[0]; out[i * 4 + 1] = DIM_RGB[1]; out[i * 4 + 2] = DIM_RGB[2]; out[i * 4 + 3] = DIM_A; continue; }
    const t = Math.max(0, Math.min(1, values[i] / m));
    out[i * 4] = RAMP_LO[0] + (RAMP_HI[0] - RAMP_LO[0]) * t;
    out[i * 4 + 1] = RAMP_LO[1] + (RAMP_HI[1] - RAMP_LO[1]) * t;
    out[i * 4 + 2] = RAMP_LO[2] + (RAMP_HI[2] - RAMP_LO[2]) * t;
    out[i * 4 + 3] = 230;
  }
  return out;
}

// Qualitative palette tuned for the dark canvas: 24 hand-separated hues. Beyond that, catColor()
// walks the hue wheel by the golden angle so any category count stays collision-free — the old
// 12-colour table wrapped with %, so e.g. cluster 0 and cluster 12 rendered the SAME colour.
export const CAT_PALETTE: [number, number, number][] = [
  [110, 168, 254], [224, 164, 88], [136, 192, 160], [217, 140, 140], [180, 142, 173], [120, 210, 210],
  [240, 200, 90], [150, 150, 230], [230, 130, 100], [120, 200, 140], [200, 120, 200], [92, 200, 255],
  [232, 126, 160], [160, 205, 95], [245, 175, 120], [110, 150, 235], [205, 205, 130], [100, 205, 185],
  [205, 150, 235], [235, 140, 150], [150, 195, 235], [190, 165, 140], [140, 205, 120], [240, 190, 100],
];
// LIGHT-theme variant: the dark palette's mid/light tones (yellows, pale greens, sky blues) wash out on white.
// Same hue ORDER (a label keeps its hue across themes) but darker + more saturated so each reads on white.
export const CAT_PALETTE_LIGHT: [number, number, number][] = [
  [37, 110, 200], [188, 110, 18], [44, 138, 90], [196, 64, 64], [138, 88, 152], [26, 150, 146],
  [176, 134, 18], [86, 86, 198], [200, 92, 40], [50, 150, 86], [168, 58, 168], [22, 138, 198],
  [200, 60, 120], [110, 150, 30], [200, 112, 40], [60, 88, 188], [150, 138, 36], [28, 150, 130],
  [150, 80, 192], [200, 70, 92], [70, 128, 190], [150, 110, 70], [80, 150, 48], [190, 130, 18],
];
export function catColor(code: number): [number, number, number] {
  const dark = themeIsDark();
  const pal = dark ? CAT_PALETTE : CAT_PALETTE_LIGHT;
  if (code < pal.length) return pal[code];
  const k = code - pal.length;                    // overflow: golden-angle hue walk, never collides
  const hue = (k * 137.508 + 25) % 360;
  // dark canvas → lighter colours; white canvas → darker, more saturated colours that read on white
  return dark ? hslToRgb(hue / 360, (60 + (k % 2) * 16) / 100, (60 + ((k % 3) - 1) * 9) / 100)
              : hslToRgb(hue / 360, (62 + (k % 2) * 16) / 100, (42 + ((k % 3) - 1) * 7) / 100);
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}
export function codesToRGBA(codes: Int32Array, focusMask?: Uint8Array, colorMap?: ArrayLike<number>): Uint8Array {
  const n = codes.length, out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (focusMask && !focusMask[i]) { out[i * 4] = DIM_RGB[0]; out[i * 4 + 1] = DIM_RGB[1]; out[i * 4 + 2] = DIM_RGB[2]; out[i * 4 + 3] = DIM_A; continue; }
    // colorMap[code] ?? code: if a per-category palette index is missing (e.g. a stale/short map after a
    // just-added category), fall back to the raw code so catColor still yields a real hue — never NaN→black.
    const code = codes[i]; const c = catColor(colorMap && code >= 0 ? (colorMap[code] ?? code) : code);
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 230;
  }
  return out;
}
