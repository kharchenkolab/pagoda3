// PURE numeric core for overdispersion (HVG) — extracted from data/view.ts so it can run in THREE places from ONE
// definition: the main-thread fallback (view.ts), the compute worker (compute/worker.ts), and node unit tests. No DOM,
// no WASM, no app imports → byte-identical wherever it runs. The kernel is pagoda2's gene-relative overdispersion:
// per-gene mean/var of log1p over a (deterministically) subsampled cell set, a LOWESS mean-variance trend, and the
// F-test on the variance ratio (effective d.o.f. = expressing cells). Returns the PANEL gene index `g`; the caller maps
// g -> {gene, symbol} (so no symbol table crosses into the worker).

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
export function overdispersedCore(panel: ODPanel, cellIds: ArrayLike<number>, topN = 50, maxCells = 2000): ODResult[] {
  const { data, indices, indptr, nGenes, lognorm } = panel;
  const cells = sample(cellIds, maxCells);
  const n = Math.max(cells.length, 1);
  const sum = new Float64Array(nGenes), sumsq = new Float64Array(nGenes), nobs = new Int32Array(nGenes);
  for (const i of cells) for (let k = indptr[i]; k < indptr[i + 1]; k++) {
    const g = indices[k], v = lognorm ? data[k] : Math.log1p(data[k]);
    sum[g] += v; sumsq[g] += v * v; nobs[g]++;
  }
  const mean = new Float64Array(nGenes), varr = new Float64Array(nGenes);
  const xs: number[] = [], ys: number[] = [], gi: number[] = [];
  for (let g = 0; g < nGenes; g++) {
    const m = sum[g] / n, vv = Math.max(sumsq[g] / n - (sum[g] / n) ** 2, 0);
    mean[g] = m; varr[g] = vv;
    if (m > 0 && vv > 0 && nobs[g] >= 3) { xs.push(Math.log(m)); ys.push(Math.log(vv)); gi.push(g); }
  }
  const trend = lowess(xs, ys);
  const out: ODResult[] = gi.map((g, j) => {
    const res = ys[j] - trend(xs[j]);
    const lp = logFupperTail(Math.exp(res), nobs[g], nobs[g]);
    return { g, mean: mean[g], varr: varr[g], resid: -lp, nobs: nobs[g] };
  });
  out.sort((a, b) => b.resid - a.resid);
  return out.slice(0, topN);
}

// ----- LOWESS: tricube-weighted local linear fit of y~x at anchors, linearly interpolated -----
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
