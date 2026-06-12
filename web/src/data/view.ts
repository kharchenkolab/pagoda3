// View over an L* store: the typed-array seam the app turns into pixels. Heavy reductions use
// the real libstar WASM kernels when available (numbers match R/Python), with a pure-TS fallback.
import type { LstarDataset } from "./store.ts";
import { kernels } from "./kernels.ts";

export type Metadata =
  | { kind: "categorical"; codes: Int32Array; categories: string[] }
  | { kind: "numeric"; values: Float32Array; min: number; max: number };

export interface DEResult { gene: number; symbol: string; meanA: number; meanB: number; lfc: number; }

export class LstarView {
  ds: LstarDataset;
  private geneLabels?: string[];
  private geneIndex?: Map<string, number>;
  private cscCache?: { data: Float64Array; indices: Int32Array; indptr: Int32Array; nGenes: number };
  // cell-major counts panel (viewer profile): undefined = not checked, null = absent in this store.
  // `lognorm` = values already log1p (legacy) vs raw (log1p on read); `geneCol` maps the panel's
  // gene axis to global gene indices when it's a subset (legacy od_genes), else null (all genes).
  private dePanelCache?: { data: Float64Array; indices: Int32Array; indptr: Int32Array; symbols: string[]; geneCol: Int32Array | null; nGenes: number; lognorm: boolean } | null;

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

  async metadata(name: string): Promise<Metadata> {
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
      return { kind: "categorical", codes, categories: cats };
    }
    const { data } = await this.ds.fieldDense(name);
    const values = data instanceof Float32Array ? data : Float32Array.from(data as any);
    let mn = Infinity, mx = -Infinity;
    for (const v of values) { if (v < mn) mn = v; if (v > mx) mx = v; }
    return { kind: "numeric", values, min: mn, max: mx };
  }

  // Per-cell scalar for one gene (lognorm), via a single CSC column read.
  async geneExpression(symbol: string, lognorm = true): Promise<{ values: Float32Array; max: number; col: number }> {
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
    return { values: out, max, col };
  }

  // Precomputed cluster sufficient stats (viewer profile) -> per (group, gene) mean/frac.
  async groupStats(grouping = "leiden"): Promise<{
    groups: string[]; nGenes: number; n: Int32Array;
    mean: Float32Array; frac: Float32Array; // flat (G x nGenes), log1p-space mean
  }> {
    const groups = await this.ds.axisLabels(`groups_${grouping}`);
    const G = groups.length, ng = this.nGenes;
    const sum = (await this.ds.fieldDense(`stats_${grouping}_sum`)).data as Float32Array;
    const nexpr = (await this.ds.fieldDense(`stats_${grouping}_nexpr`)).data as Float32Array;
    const md = await this.metadata(grouping);
    const n = new Int32Array(G);
    if (md.kind === "categorical") {
      const gi = new Map(groups.map((g, i) => [g, i]));
      for (const code of md.codes) { const idx = gi.get(md.categories[code]); if (idx !== undefined) n[idx]++; }
    }
    const mean = new Float32Array(G * ng), frac = new Float32Array(G * ng);
    for (let g = 0; g < G; g++) {
      const nn = Math.max(n[g], 1);
      for (let j = 0; j < ng; j++) { mean[g * ng + j] = sum[g * ng + j] / nn; frac[g * ng + j] = nexpr[g * ng + j] / nn; }
    }
    return { groups, nGenes: ng, n, mean, frac };
  }

  // Precomputed marker tables (viewer profile) -> ranked genes per group.
  async markers(grouping = "leiden", topN = 25): Promise<Map<string, { gene: number; symbol: string; lfc: number; padj: number }[]>> {
    const groups = await this.ds.axisLabels(`groups_${grouping}`);
    const genes = await this.genes();
    const lfcF = await this.ds.fieldDense(`markers_${grouping}_lfc`); // (nGenes, G)
    const padjF = await this.ds.fieldDense(`markers_${grouping}_padj`);
    const lfc = lfcF.data as Float32Array, padj = padjF.data as Float32Array;
    const G = groups.length, ng = genes.length;
    const out = new Map<string, { gene: number; symbol: string; lfc: number; padj: number }[]>();
    for (let g = 0; g < G; g++) {
      const rows: { gene: number; symbol: string; lfc: number; padj: number }[] = [];
      for (let j = 0; j < ng; j++) rows.push({ gene: j, symbol: genes[j], lfc: lfc[j * G + g], padj: padj[j * G + g] });
      rows.sort((a, b) => b.lfc - a.lfc);
      out.set(groups[g], rows.slice(0, topN));
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
      // Zero-copy JS loop over the cached cell-major panel, touching only the sampled rows (O(rows)).
      // The panel is raw counts (state=raw) -> log1p here; a legacy log1p panel is summed directly.
      const { data, indices, indptr, symbols, geneCol, nGenes, lognorm } = dp;
      const sumA = new Float64Array(nGenes), sumB = new Float64Array(nGenes);
      if (lognorm) {
        for (const i of A) for (let k = indptr[i]; k < indptr[i + 1]; k++) sumA[indices[k]] += data[k];
        for (const i of B) for (let k = indptr[i]; k < indptr[i + 1]; k++) sumB[indices[k]] += data[k];
      } else {
        for (const i of A) for (let k = indptr[i]; k < indptr[i + 1]; k++) sumA[indices[k]] += Math.log1p(data[k]);
        for (const i of B) for (let k = indptr[i]; k < indptr[i + 1]; k++) sumB[indices[k]] += Math.log1p(data[k]);
      }
      const ranked: DEResult[] = new Array(nGenes);
      for (let g = 0; g < nGenes; g++) {
        const ma = sumA[g] / na, mb = sumB[g] / nb;
        ranked[g] = { gene: geneCol ? geneCol[g] : g, symbol: symbols[g], meanA: ma, meanB: mb, lfc: ma - mb };
      }
      ranked.sort((a, b) => Math.abs(b.lfc) - Math.abs(a.lfc));
      return { ranked, nA: A.length, nB: B.length, approx, panel: true, nGenesRanked: nGenes };
    }

    // Fallback: load counts CSC once (cached), per-group sums via the libstar WASM kernel.
    if (!this.cscCache) {
      const sp = await this.ds.fieldSparse("counts");
      this.cscCache = {
        data: sp.data instanceof Float64Array ? sp.data : Float64Array.from(sp.data as any),
        indices: sp.indices instanceof Int32Array ? sp.indices : Int32Array.from(sp.indices as any),
        indptr: sp.indptr instanceof Int32Array ? sp.indptr : Int32Array.from(sp.indptr as any),
        nGenes: sp.shape[1],
      };
    }
    const { data, indices, indptr, nGenes } = this.cscCache;
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

  // Load + cache the cell-major counts panel (CSR over (cells, genes)) once; null if the store
  // carries no such field. `counts_cellmajor` is the current name; `de_panel` (a legacy od-genes
  // subset, log1p) is still read if present. The gene axis and lognorm-vs-raw come off the field.
  private async dePanel() {
    if (this.dePanelCache !== undefined) return this.dePanelCache;
    const name = this.ds.hasField("counts_cellmajor") ? "counts_cellmajor"
      : (this.ds.hasField("de_panel") ? "de_panel" : null);
    if (!name) { this.dePanelCache = null; return null; }
    const fm = this.ds.field(name)!;
    const geneAxis = fm.span[1] ?? "genes";
    const allGenes = geneAxis === "genes";
    const symbols = allGenes ? await this.genes() : await this.ds.axisLabels(geneAxis);
    let geneCol: Int32Array | null = null;
    if (!allGenes) { await this.genes(); geneCol = Int32Array.from(symbols.map((s) => this.geneIndex!.get(s) ?? -1)); }
    const sp = await this.ds.fieldSparse(name);
    this.dePanelCache = {
      data: sp.data instanceof Float64Array ? sp.data : Float64Array.from(sp.data as any),
      indices: sp.indices instanceof Int32Array ? sp.indices : Int32Array.from(sp.indices as any),
      indptr: sp.indptr instanceof Int32Array ? sp.indptr : Int32Array.from(sp.indptr as any),
      symbols, geneCol, nGenes: symbols.length, lognorm: fm.state === "lognorm",
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
    const { data, indices, indptr, symbols, geneCol, nGenes, lognorm } = dp;
    const cells = sample(cellIds, maxCells);
    const n = Math.max(cells.length, 1);
    const sum = new Float64Array(nGenes), sumsq = new Float64Array(nGenes), nobs = new Int32Array(nGenes);
    for (const i of cells) for (let k = indptr[i]; k < indptr[i + 1]; k++) {
      const g = indices[k], v = lognorm ? data[k] : Math.log1p(data[k]);
      sum[g] += v; sumsq[g] += v * v; nobs[g]++;
    }
    const mean = new Float64Array(nGenes), varr = new Float64Array(nGenes);
    const xs: number[] = [], ys: number[] = [], gi: number[] = [];   // fit the trend on expressed genes
    for (let g = 0; g < nGenes; g++) {
      const m = sum[g] / n, vv = Math.max(sumsq[g] / n - (sum[g] / n) ** 2, 0);
      mean[g] = m; varr[g] = vv;
      if (m > 0 && vv > 0) { xs.push(Math.log(m)); ys.push(Math.log(vv)); gi.push(g); }
    }
    const trend = lowess(xs, ys);                                    // log(v) ~ smooth(log(m))
    const out = gi.map((g, j) => ({
      gene: geneCol ? geneCol[g] : g, symbol: symbols[g],
      mean: mean[g], varr: varr[g], resid: ys[j] - trend(xs[j]), nobs: nobs[g],
    }));
    out.sort((a, b) => b.resid - a.resid);
    return out.slice(0, topN);
  }
}

// Compact LOWESS: tricube-weighted local linear fit of y~x, evaluated at `nAnchor` anchors across
// the x-range and linearly interpolated. `span` = fraction of points per window. Returns a predictor.
function lowess(xs: number[], ys: number[], span = 0.3, nAnchor = 200): (x: number) => number {
  const n = xs.length;
  if (n < 3) { const my = ys.reduce((s, v) => s + v, 0) / Math.max(n, 1); return () => my; }
  const ord = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const sx = ord.map((i) => xs[i]), sy = ord.map((i) => ys[i]);
  const win = Math.max(2, Math.floor(span * n));
  const ax: number[] = [], ay: number[] = [];
  for (let a = 0; a < nAnchor; a++) {
    const x0 = sx[0] + (sx[n - 1] - sx[0]) * a / (nAnchor - 1);
    let l = Math.max(0, lowerBound(sx, x0) - (win >> 1)); const r = Math.min(n, l + win); l = Math.max(0, r - win);
    let maxd = 1e-9; for (let i = l; i < r; i++) maxd = Math.max(maxd, Math.abs(sx[i] - x0));
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (let i = l; i < r; i++) {
      const d = Math.abs(sx[i] - x0) / maxd, w = (1 - d * d * d) ** 3, xi = sx[i], yi = sy[i];
      sw += w; swx += w * xi; swy += w * yi; swxx += w * xi * xi; swxy += w * xi * yi;
    }
    const denom = sw * swxx - swx * swx;
    ay.push(Math.abs(denom) < 1e-12 ? swy / sw : ((swy - (sw * swxy - swx * swy) / denom * swx) / sw) + (sw * swxy - swx * swy) / denom * x0);
    ax.push(x0);
  }
  return (x: number) => {
    if (x <= ax[0]) return ay[0];
    if (x >= ax[ax.length - 1]) return ay[ax.length - 1];
    const j = lowerBound(ax, x);
    return ay[j - 1] + (ay[j] - ay[j - 1]) * (x - ax[j - 1]) / (ax[j] - ax[j - 1]);
  };
}
function lowerBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

function sample(arr: number[], k: number): number[] {
  if (arr.length <= k) return arr;
  const out: number[] = [], used = new Set<number>(), n = arr.length;
  // deterministic-ish reservoir via stride to avoid Math.random nondeterminism noise
  const stride = Math.max(1, Math.floor(n / k));
  for (let i = 0; i < n && out.length < k; i += stride) { out.push(arr[i]); used.add(i); }
  return out;
}

// ----- color helpers -----
const RAMP_LO = [27, 34, 48], RAMP_HI = [224, 164, 88]; // inset -> amber (matches the mock)
export function scalarToRGBA(values: ArrayLike<number>, max: number, focusMask?: Uint8Array): Uint8Array {
  const n = values.length, out = new Uint8Array(n * 4), m = max || 1;
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(1, values[i] / m));
    out[i * 4] = RAMP_LO[0] + (RAMP_HI[0] - RAMP_LO[0]) * t;
    out[i * 4 + 1] = RAMP_LO[1] + (RAMP_HI[1] - RAMP_LO[1]) * t;
    out[i * 4 + 2] = RAMP_LO[2] + (RAMP_HI[2] - RAMP_LO[2]) * t;
    out[i * 4 + 3] = focusMask && !focusMask[i] ? 40 : 230;
  }
  return out;
}

export const CAT_PALETTE = [
  [110, 168, 254], [224, 164, 88], [180, 142, 173], [136, 192, 160], [217, 140, 140],
  [92, 200, 255], [200, 120, 200], [120, 200, 140], [240, 200, 90], [150, 150, 230],
  [230, 130, 100], [120, 210, 210],
];
export function codesToRGBA(codes: Int32Array, focusMask?: Uint8Array): Uint8Array {
  const n = codes.length, out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = CAT_PALETTE[codes[i] % CAT_PALETTE.length];
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = focusMask && !focusMask[i] ? 40 : 230;
  }
  return out;
}
