// Numeric cores for the viewer's cell-major SUBSET compute — the reductions that iterate the selected cells' rows
// (read via csrRows): DE (deCore), group stats (groupStatsForCellsCore), pseudobulk, and the overdispersion REDUCE
// (per-gene mean/var of log1p + expressing count). These stay HERE — pure, node-testable, run in the worker + the
// main-thread fallback. The layout-INDEPENDENT overdispersion MATH (pagoda2 adjustVariance: LOWESS + F-test) is now
// lstar's single-sourced WASM kernel: `overdispersed()` reduces here, then calls @lstar/core overdispersionFromStats
// (Q3: byte-identical to the retired JS LOWESS). Cores return the PANEL gene index `g`; the caller maps g -> {gene, symbol}.
import { overdispersionFromStats as lsOverdispersion } from "../../../../lstar/js/core/compute.ts";

export interface ODPanel {
  data: ArrayLike<number>;      // CSR values (cell-major), raw counts unless `lognorm`
  indices: ArrayLike<number>;   // CSR column (gene) indices
  indptr: ArrayLike<number>;    // CSR row pointers (per cell)
  nGenes: number;
  lognorm: boolean;             // values already log1p (legacy panel) vs raw (log1p on read)
}

export interface ODResult { g: number; mean: number; varr: number; resid: number; nobs: number; }

// Deterministic stride subsample (NO Math.random — so the worker and the main thread pick the SAME cells → identical
// results). Shared with view.subsampleDE.
export function sample(arr: ArrayLike<number>, k: number): number[] {
  const n = arr.length;
  if (n <= k) return Array.from(arr as any);
  const out: number[] = [];
  const stride = Math.max(1, Math.floor(n / k));
  for (let i = 0; i < n && out.length < k; i += stride) out.push(arr[i]);
  return out;
}

// The kernel. cellIds = the cell set; subsampled to maxCells. Returns genes ranked by overdispersion score (resid = -log p).
// REDUCE (ours, cell-major, PURE): per-gene zero-aware mean/var of log1p + expressing count over a
// (deterministically) subsampled cell set. The inputs the shared overdispersion kernel needs.
export function overdispersedReduce(panel: ODPanel, cellIds: ArrayLike<number>, maxCells = 2000):
    { mean: Float64Array; varr: Float64Array; nobs: Int32Array } {
  const { data, indices, indptr, nGenes, lognorm } = panel;
  const cells = sample(cellIds, maxCells);
  const n = Math.max(cells.length, 1);
  const sum = new Float64Array(nGenes), sumsq = new Float64Array(nGenes), nobs = new Int32Array(nGenes);
  for (const i of cells) for (let k = indptr[i]; k < indptr[i + 1]; k++) {
    const g = indices[k], v = lognorm ? data[k] : Math.log1p(data[k]);
    sum[g] += v; sumsq[g] += v * v; nobs[g]++;
  }
  const mean = new Float64Array(nGenes), varr = new Float64Array(nGenes);
  for (let g = 0; g < nGenes; g++) { const m = sum[g] / n; mean[g] = m; varr[g] = Math.max(sumsq[g] / n - m * m, 0); }
  return { mean, varr, nobs };
}

// RANK (PURE): the genes the trend is fit on (mean>0, var>0, >=3 expressing cells), scored by the shared kernel,
// sorted, topN. Same output set + order as the old JS core (only the trend/F-test math moved to lstar).
export function overdispersedRank(r: { mean: Float64Array; varr: Float64Array; nobs: Int32Array }, scores: ArrayLike<number>, topN = 50): ODResult[] {
  const out: ODResult[] = [];
  for (let g = 0; g < r.mean.length; g++)
    if (r.mean[g] > 0 && r.varr[g] > 0 && r.nobs[g] >= 3) out.push({ g, mean: r.mean[g], varr: r.varr[g], resid: Number(scores[g]), nobs: r.nobs[g] });
  out.sort((a, b) => b.resid - a.resid);
  return out.slice(0, topN);
}

// Full overdispersion (HVG): our cell-major reduce → lstar's shared LOWESS/F-test kernel → rank. `M` is the caller's
// WASM handle (main-thread kernels() or the worker's wasm()) so the kernel isn't reloaded. Needs WASM (the JS LOWESS
// is retired — Q3 proved the kernel is byte-identical).
export async function overdispersed(panel: ODPanel, cellIds: ArrayLike<number>, topN = 50, maxCells = 2000, M?: any): Promise<ODResult[]> {
  const r = overdispersedReduce(panel, cellIds, maxCells);
  const scores = await lsOverdispersion(r.mean, r.varr, r.nobs, M);
  return overdispersedRank(r, scores, topN);
}

// Subsample DE reduction — A and B are PRE-SUBSAMPLED cell sets (the deterministic sample() runs on the main thread).
// Per-gene mean(log1p) for each group over the panel rows, ranked by |logFC|. Returns the PANEL gene index g (the caller
// maps g -> {global gene, symbol}). Whole-transcriptome; cost is O(sum of A+B row lengths). Mirrors view.subsampleDE's
// fast path exactly so worker == inline byte-for-byte.
export function deCore(panel: ODPanel, A: ArrayLike<number>, B: ArrayLike<number>): { g: number; meanA: number; meanB: number; lfc: number }[] {
  const { data, indices, indptr, nGenes, lognorm } = panel;
  const na = Math.max(A.length, 1), nb = Math.max(B.length, 1);
  const sumA = new Float64Array(nGenes), sumB = new Float64Array(nGenes);
  if (lognorm) {
    for (let j = 0; j < A.length; j++) { const i = A[j]; for (let k = indptr[i]; k < indptr[i + 1]; k++) sumA[indices[k]] += data[k]; }
    for (let j = 0; j < B.length; j++) { const i = B[j]; for (let k = indptr[i]; k < indptr[i + 1]; k++) sumB[indices[k]] += data[k]; }
  } else {
    for (let j = 0; j < A.length; j++) { const i = A[j]; for (let k = indptr[i]; k < indptr[i + 1]; k++) sumA[indices[k]] += Math.log1p(data[k]); }
    for (let j = 0; j < B.length; j++) { const i = B[j]; for (let k = indptr[i]; k < indptr[i + 1]; k++) sumB[indices[k]] += Math.log1p(data[k]); }
  }
  const ranked = new Array(nGenes);
  for (let g = 0; g < nGenes; g++) { const ma = sumA[g] / na, mb = sumB[g] / nb; ranked[g] = { g, meanA: ma, meanB: mb, lfc: ma - mb }; }
  ranked.sort((a, b) => Math.abs(b.lfc) - Math.abs(a.lfc));
  return ranked;
}

// Per-(group, GLOBAL gene) mean(log1p) + fraction-expressing over a CELL SUBSET — the faceted-dotplot kernel. `codes`
// maps each cell to its group index (G groups); `geneCol` maps the panel's gene axis to global gene ids (null = identity,
// i.e. an all-genes panel); `ngGlobal` = the global gene count (the output's gene axis). Mirrors view.groupStatsForCells.
export function groupStatsForCellsCore(
  panel: ODPanel, geneCol: ArrayLike<number> | null, ngGlobal: number, codes: ArrayLike<number>, G: number, cellIds: ArrayLike<number>,
): { mean: Float32Array; frac: Float32Array; n: Int32Array } {
  const { data, indices, indptr, lognorm } = panel;
  const mean = new Float32Array(G * ngGlobal), frac = new Float32Array(G * ngGlobal), n = new Int32Array(G);
  const sum = new Float64Array(G * ngGlobal), nz = new Float64Array(G * ngGlobal);
  for (let j = 0; j < cellIds.length; j++) {
    const i = cellIds[j], grp = codes[i]; if (grp < 0 || grp >= G) continue; n[grp]++;
    const base = grp * ngGlobal;
    for (let k = indptr[i]; k < indptr[i + 1]; k++) { const gc = geneCol ? geneCol[indices[k]] : indices[k]; sum[base + gc] += lognorm ? data[k] : Math.log1p(data[k]); nz[base + gc]++; }
  }
  for (let grp = 0; grp < G; grp++) { const cnt = Math.max(n[grp], 1), base = grp * ngGlobal; for (let g = 0; g < ngGlobal; g++) { mean[base + g] = sum[base + g] / cnt; frac[base + g] = nz[base + g] / cnt; } }
  return { mean, frac, n };
}

// Per-gene mean + variance of log1p over a CELL SUBSET, from the cell-major panel — the subset counterpart to the WASM
// colMeanVar (which is all-cells). Returns the panel gene index g; the caller maps g -> symbol.
export function meanVarCore(panel: ODPanel, cells: ArrayLike<number>): { g: number; mean: number; var: number; nnz: number }[] {
  const { data, indices, indptr, nGenes, lognorm } = panel;
  const n = Math.max(cells.length, 1);
  const sum = new Float64Array(nGenes), sumsq = new Float64Array(nGenes), nobs = new Int32Array(nGenes);
  for (let j = 0; j < cells.length; j++) { const i = cells[j]; for (let k = indptr[i]; k < indptr[i + 1]; k++) { const g = indices[k], v = lognorm ? data[k] : Math.log1p(data[k]); sum[g] += v; sumsq[g] += v * v; nobs[g]++; } }
  const out = new Array(nGenes);
  for (let g = 0; g < nGenes; g++) { const m = sum[g] / n; out[g] = { g, mean: m, var: Math.max(sumsq[g] / n - m * m, 0), nnz: nobs[g] }; }
  return out;
}

// ----- PSEUDOBULK (donor-level) DE: the statistically honest cross-condition contrast -----
export interface PseudobulkRow { g: number; lfc: number; t: number; p: number; meanA: number; meanB: number; nA: number; nB: number; }
// Aggregate to one value PER REPLICATE (donor/sample), then test ACROSS replicates — the replicate is the unit of
// replication, so this carries a REAL p-value (unlike cell-level deCore, whose pooled cells overstate confidence).
// Inputs are per-(replicate s, gene j) MEANS over each group's cells (from groupStatsForCells over A-cells / B-cells)
// + nA/nB = cells-per-replicate in each group. A replicate joins a group's test only if it has ≥ minCells there.
// Welch's t per gene; two-sided p via T²~F(1,df): p = exp(logFupperTail(t², 1, df_welch)). Pure → node-testable.
export function pseudobulkDECore(
  meanA: ArrayLike<number>, nA: ArrayLike<number>,
  meanB: ArrayLike<number>, nB: ArrayLike<number>,
  ng: number, G: number, minCells = 10,
): { rows: PseudobulkRow[]; repsA: number[]; repsB: number[] } {
  const repsA: number[] = [], repsB: number[] = [];
  for (let s = 0; s < G; s++) { if (nA[s] >= minCells) repsA.push(s); if (nB[s] >= minCells) repsB.push(s); }
  const ka = repsA.length, kb = repsB.length, rows: PseudobulkRow[] = [];
  if (ka < 2 || kb < 2) return { rows, repsA, repsB };   // caller errors with a clear message — a t-test needs ≥2 replicates per group
  for (let j = 0; j < ng; j++) {
    let sa = 0, sb = 0;
    for (const s of repsA) sa += meanA[s * ng + j];
    for (const s of repsB) sb += meanB[s * ng + j];
    const mA = sa / ka, mB = sb / kb, lfc = mA - mB;
    let va = 0, vb = 0;
    for (const s of repsA) { const d = meanA[s * ng + j] - mA; va += d * d; }
    for (const s of repsB) { const d = meanB[s * ng + j] - mB; vb += d * d; }
    va /= (ka - 1); vb /= (kb - 1);
    const sa2 = va / ka, sb2 = vb / kb, se2 = sa2 + sb2;
    let t = 0, df = ka + kb - 2;
    if (se2 > 1e-12) {
      t = lfc / Math.sqrt(se2);
      const den = (sa2 * sa2) / (ka - 1) + (sb2 * sb2) / (kb - 1);   // Welch–Satterthwaite
      if (den > 1e-12) df = (se2 * se2) / den;
    } else if (Math.abs(lfc) > 1e-9) t = lfc > 0 ? 50 : -50;   // zero within-group variance but groups differ → near-perfect separation
    const p = Math.exp(logFupperTail(t * t, 1, Math.max(df, 1)));
    rows.push({ g: j, lfc, t, p, meanA: mA, meanB: mB, nA: ka, nB: kb });
  }
  rows.sort((x, y) => x.p - y.p || Math.abs(y.lfc) - Math.abs(x.lfc));
  return { rows, repsA, repsB };
}

// PAIRED pseudobulk: the composer's "pseudobulk across <factor>" (Test 1). For each level s of the factor that has
// ENOUGH cells in BOTH A and B, aggregate A-cells → aₛ and B-cells → bₛ; the test is on the per-level difference
// dₛ = aₛ − bₛ (a one-sample t against 0), so the level is its own control — paired, more powerful, and the right test
// when A and B are two cell groups measured within each replicate (e.g. CD4 vs CD8 per sample). Unlike the unpaired
// pseudobulkDECore (A-reps vs B-reps as independent groups), here a replicate must carry BOTH sides. Pure → node-testable.
export function pseudobulkPairedDECore(
  meanA: ArrayLike<number>, nA: ArrayLike<number>,
  meanB: ArrayLike<number>, nB: ArrayLike<number>,
  ng: number, G: number, minCells = 10,
): { rows: PseudobulkRow[]; reps: number[] } {
  const reps: number[] = [];
  for (let s = 0; s < G; s++) if (nA[s] >= minCells && nB[s] >= minCells) reps.push(s);   // a level joins only if it carries BOTH sides
  const k = reps.length, rows: PseudobulkRow[] = [];
  if (k < 2) return { rows, reps };   // caller errors — a paired t-test needs ≥2 levels present on both sides
  for (let j = 0; j < ng; j++) {
    let sd = 0; for (const s of reps) sd += meanA[s * ng + j] - meanB[s * ng + j];
    const md = sd / k;                                   // mean per-level difference = the paired logFC
    let v = 0; for (const s of reps) { const e = (meanA[s * ng + j] - meanB[s * ng + j]) - md; v += e * e; }
    v /= (k - 1);
    const se = Math.sqrt(v / k); let t = 0; const df = k - 1;
    if (se > 1e-12) t = md / se;
    else if (Math.abs(md) > 1e-9) t = md > 0 ? 50 : -50;   // zero within-pair variance but a consistent shift → near-perfect
    const p = Math.exp(logFupperTail(t * t, 1, Math.max(df, 1)));
    let ma = 0, mb = 0; for (const s of reps) { ma += meanA[s * ng + j]; mb += meanB[s * ng + j]; }
    rows.push({ g: j, lfc: md, t, p, meanA: ma / k, meanB: mb / k, nA: k, nB: k });
  }
  rows.sort((x, y) => x.p - y.p || Math.abs(y.lfc) - Math.abs(x.lfc));
  return { rows, reps };
}

// ----- LOWESS: tricube-weighted local linear fit of y~x at anchors, linearly interpolated -----
// (The JS LOWESS mean-variance trend that fed the overdispersion F-test is retired — that layout-independent math is
//  now lstar's single-sourced WASM kernel, called via overdispersionFromStats in overdispersed() above.)

// ----- overdispersion F-test (matches pagoda2 adjustVariance: pf(var-ratio, nobs, nobs, upper, log)) -----
function lgammaFn(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x; let tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp); let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += c[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300, EPS = 3e-12, MAXIT = 300, qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap; if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function logIncBeta(a: number, b: number, x: number): number {
  if (x <= 0) return -Infinity; if (x >= 1) return 0;
  const logbt = lgammaFn(a + b) - lgammaFn(a) - lgammaFn(b) + a * Math.log(x) + b * Math.log1p(-x);
  return x < (a + 1) / (a + b + 2)
    ? logbt + Math.log(betacf(a, b, x) / a)
    : Math.log1p(-Math.exp(logbt + Math.log(betacf(b, a, 1 - x) / b)));
}
// log of the upper-tail F p-value: log P(F_{d1,d2} > f)
export function logFupperTail(f: number, d1: number, d2: number): number {
  if (f <= 0) return 0;
  return logIncBeta(d2 / 2, d1 / 2, d2 / (d2 + d1 * f));
}
