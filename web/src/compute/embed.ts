// In-browser embedding recompute for a counts-only dataset — e.g. a raw .h5ad that ships a count matrix
// but no obsm/UMAP. The pipeline mirrors a standard scanpy default: per-cell library-size normalize →
// log1p → highly-variable genes → z-score → PCA (randomized SVD) → UMAP. It's pure JS (the WASM kernels
// have no matmul/SVD), and every matmul is O(cells · genesHVG · k), so it stays linear in cell count.
// Deterministic (seeded RNG) so the same file reproduces the same layout.
import { UMAP } from "umap-js";

type CSC = { data: ArrayLike<number>; indices: ArrayLike<number>; indptr: ArrayLike<number> };
type Stage = (m: string) => void;
const N = (x: any) => Number(x);

// small deterministic PRNG (so reloads reproduce the layout); seeds the Gaussian sketch + umap-js
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(rnd: () => number): number { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export interface EmbedResult { umap: Float32Array; pca: Float32Array; pcaDim: number; eigs: number[]; hvg: number[]; nHVG: number; clusters: Int32Array; nClusters: number; }

const tick = () => new Promise<void>((r) => setTimeout(r, 0));   // yield so the progress modal can repaint between stages

// k-nearest-neighbor lists (Euclidean) over PC scores (n×d) — brute force, fine for the size we gate to.
function knn(scores: Float32Array, n: number, d: number, k: number): Int32Array[] {
  const out: Int32Array[] = new Array(n);
  const idx = new Int32Array(k), dist = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    idx.fill(-1); dist.fill(Infinity);
    const ib = i * d;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      let dd = 0; const jb = j * d;
      for (let t = 0; t < d; t++) { const e = scores[ib + t] - scores[jb + t]; dd += e * e; }
      if (dd < dist[k - 1]) { let p = k - 1; while (p > 0 && dist[p - 1] > dd) { dist[p] = dist[p - 1]; idx[p] = idx[p - 1]; p--; } dist[p] = dd; idx[p] = j; }
    }
    out[i] = idx.slice();
  }
  return out;
}

// Louvain community detection (modularity maximization: local moving + aggregation) on a symmetric kNN
// graph — the standard scRNA clustering recipe (Seurat/scanpy do Louvain/Leiden on a neighbor graph).
function louvain(adj0: Map<number, number>[], n0: number, resolution: number, rnd: () => number): Int32Array {
  let adj = adj0, n = n0, node2orig: number[][] = Array.from({ length: n0 }, (_, i) => [i]);
  const final = new Int32Array(n0);
  for (let level = 0; level < 50; level++) {
    const k = new Float64Array(n); let m2 = 0;
    for (let i = 0; i < n; i++) { let s = 0; for (const [, w] of adj[i]) s += w; k[i] = s; m2 += s; }
    if (m2 === 0) break;
    const comm = new Int32Array(n); for (let i = 0; i < n; i++) comm[i] = i;
    const sigTot = Float64Array.from(k);
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let improved = false;
    for (let pass = 0, moved = true; moved && pass < 50; pass++) {
      moved = false;
      for (const i of order) {
        const ci = comm[i], wTo = new Map<number, number>();
        for (const [j, w] of adj[i]) { if (j === i) continue; const cj = comm[j]; wTo.set(cj, (wTo.get(cj) || 0) + w); }
        sigTot[ci] -= k[i];
        let bestC = ci, bestGain = (wTo.get(ci) || 0) - resolution * sigTot[ci] * k[i] / m2;
        for (const [c, wic] of wTo) { const g = wic - resolution * sigTot[c] * k[i] / m2; if (g > bestGain) { bestGain = g; bestC = c; } }
        sigTot[bestC] += k[i];
        if (bestC !== ci) { comm[i] = bestC; moved = true; improved = true; }
      }
    }
    const remap = new Map<number, number>(); let C = 0;
    for (let i = 0; i < n; i++) if (!remap.has(comm[i])) remap.set(comm[i], C++);
    const nextOrig: number[][] = Array.from({ length: C }, () => []);
    for (let i = 0; i < n; i++) { const c = remap.get(comm[i])!; for (const o of node2orig[i]) nextOrig[c].push(o); }
    if (!improved || C === n) { for (let c = 0; c < C; c++) for (const o of nextOrig[c]) final[o] = c; break; }
    const nadj: Map<number, number>[] = Array.from({ length: C }, () => new Map());
    for (let i = 0; i < n; i++) { const ci = remap.get(comm[i])!; for (const [j, w] of adj[i]) { const cj = remap.get(comm[j])!; nadj[ci].set(cj, (nadj[ci].get(cj) || 0) + w); } }
    adj = nadj; n = C; node2orig = nextOrig;
    for (let c = 0; c < C; c++) for (const o of nextOrig[c]) final[o] = c;
  }
  return final;
}

// kNN graph → symmetric adjacency → Louvain → cluster labels renumbered by descending size (c0 = biggest).
function clusterCells(scores: Float32Array, n: number, d: number, kNeighbors: number, rnd: () => number): { labels: Int32Array; nClusters: number } {
  const nbr = knn(scores, n, d, Math.min(kNeighbors, n - 1));
  const adj: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  for (let i = 0; i < n; i++) for (const j of nbr[i]) { if (j < 0) continue; adj[i].set(j, 1); adj[j].set(i, 1); }
  const raw = louvain(adj, n, 1.0, rnd);
  const size = new Map<number, number>(); for (let i = 0; i < n; i++) size.set(raw[i], (size.get(raw[i]) || 0) + 1);
  const bySize = [...size.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const rank = new Map<number, number>(); bySize.forEach((c, r) => rank.set(c, r));
  const labels = new Int32Array(n); for (let i = 0; i < n; i++) labels[i] = rank.get(raw[i])!;
  return { labels, nClusters: bySize.length };
}

/** Top-`K` PCA of a column-centered n×p matrix X (row-major) via randomized SVD. Returns PC scores
 *  (U·S, n×K) and the eigenvalues (S², for an elbow plot). Cost ≈ O(n·p·L), L=K+oversample. */
function randomizedPCA(X: Float32Array, n: number, p: number, K: number, rnd: () => number): { scores: Float32Array; eigs: Float64Array } {
  const L = Math.min(K + 10, p, n);
  // Y = X·Ω  (n×L), Ω = p×L Gaussian sketch
  let Y = new Float64Array(n * L);
  {
    const Om = new Float64Array(p * L);
    for (let i = 0; i < p * L; i++) Om[i] = gauss(rnd);
    for (let c = 0; c < n; c++) { const xb = c * p, yb = c * L; for (let j = 0; j < p; j++) { const x = X[xb + j]; if (!x) continue; const ob = j * L; for (let l = 0; l < L; l++) Y[yb + l] += x * Om[ob + l]; } }
  }
  // power iterations Y ← X (Xᵀ Y) sharpen the leading subspace
  for (let it = 0; it < 2; it++) {
    const Z = new Float64Array(p * L);                         // Z = Xᵀ Y  (p×L)
    for (let c = 0; c < n; c++) { const xb = c * p, yb = c * L; for (let j = 0; j < p; j++) { const x = X[xb + j]; if (!x) continue; const zb = j * L; for (let l = 0; l < L; l++) Z[zb + l] += x * Y[yb + l]; } }
    Y = new Float64Array(n * L);                               // Y = X Z   (n×L)
    for (let c = 0; c < n; c++) { const xb = c * p, yb = c * L; for (let j = 0; j < p; j++) { const x = X[xb + j]; if (!x) continue; const zb = j * L; for (let l = 0; l < L; l++) Y[yb + l] += x * Z[zb + l]; } }
  }
  // Q = orthonormal basis of Y (modified Gram-Schmidt over the L columns)
  const Q = Y;
  for (let l = 0; l < L; l++) {
    for (let m = 0; m < l; m++) { let d = 0; for (let c = 0; c < n; c++) d += Q[c * L + l] * Q[c * L + m]; for (let c = 0; c < n; c++) Q[c * L + l] -= d * Q[c * L + m]; }
    let nrm = 0; for (let c = 0; c < n; c++) nrm += Q[c * L + l] * Q[c * L + l]; nrm = Math.sqrt(nrm) || 1;
    for (let c = 0; c < n; c++) Q[c * L + l] /= nrm;
  }
  // B = Qᵀ X (L×p); M = B Bᵀ (L×L) = Qᵀ X Xᵀ Q — its eigenpairs give the singular subspace
  const B = new Float64Array(L * p);
  for (let c = 0; c < n; c++) { const xb = c * p, qb = c * L; for (let l = 0; l < L; l++) { const q = Q[qb + l]; if (!q) continue; const bb = l * p; for (let j = 0; j < p; j++) B[bb + j] += q * X[xb + j]; } }
  const M = new Float64Array(L * L);
  for (let a = 0; a < L; a++) for (let b = a; b < L; b++) { let s = 0; const ab = a * p, bb = b * p; for (let j = 0; j < p; j++) s += B[ab + j] * B[bb + j]; M[a * L + b] = M[b * L + a] = s; }
  const { vecs, vals } = jacobiEig(M, L);                      // eigenvalues desc, eigenvectors as columns
  // scores = (Q · vecs) · diag(sqrt(vals)), take top K
  const scores = new Float32Array(n * K);
  for (let c = 0; c < n; c++) { const qb = c * L; for (let k = 0; k < K; k++) { let s = 0; for (let l = 0; l < L; l++) s += Q[qb + l] * vecs[l * L + k]; scores[c * K + k] = s * Math.sqrt(Math.max(vals[k], 0)); } }
  return { scores, eigs: vals.slice(0, K) };
}

/** Cyclic Jacobi eigensolver for a small symmetric L×L matrix → eigenvalues (desc) + eigenvectors (cols). */
function jacobiEig(A0: Float64Array, L: number): { vecs: Float64Array; vals: Float64Array } {
  const A = A0.slice();
  const V = new Float64Array(L * L); for (let i = 0; i < L; i++) V[i * L + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0; for (let p = 0; p < L; p++) for (let q = p + 1; q < L; q++) off += A[p * L + q] * A[p * L + q];
    if (off < 1e-18) break;
    for (let p = 0; p < L; p++) for (let q = p + 1; q < L; q++) {
      const apq = A[p * L + q]; if (Math.abs(apq) < 1e-300) continue;
      const app = A[p * L + p], aqq = A[q * L + q];
      const phi = 0.5 * Math.atan2(2 * apq, aqq - app), c = Math.cos(phi), s = Math.sin(phi);
      for (let k = 0; k < L; k++) { const akp = A[k * L + p], akq = A[k * L + q]; A[k * L + p] = c * akp - s * akq; A[k * L + q] = s * akp + c * akq; }
      for (let k = 0; k < L; k++) { const apk = A[p * L + k], aqk = A[q * L + k]; A[p * L + k] = c * apk - s * aqk; A[q * L + k] = s * apk + c * aqk; }
      for (let k = 0; k < L; k++) { const vkp = V[k * L + p], vkq = V[k * L + q]; V[k * L + p] = c * vkp - s * vkq; V[k * L + q] = s * vkp + c * vkq; }
    }
  }
  const idx = Array.from({ length: L }, (_, i) => i).sort((a, b) => A[b * L + b] - A[a * L + a]);
  const vecs = new Float64Array(L * L), vals = new Float64Array(L);
  idx.forEach((src, dst) => { vals[dst] = Math.max(A[src * L + src], 0); for (let k = 0; k < L; k++) vecs[k * L + dst] = V[k * L + src]; });
  return { vecs, vals };
}

/** Normalize → HVG → PCA → UMAP a counts-only dataset (CSC, gene-major) into a 2-D embedding. */
export async function computeEmbedding(counts: CSC, ncells: number, ngenes: number,
    opts: { nHVG?: number; nPC?: number; onStage?: Stage } = {}): Promise<EmbedResult> {
  const onStage = opts.onStage || (() => {});
  const nHVG = Math.min(opts.nHVG ?? 1500, ngenes);
  const nPC = Math.max(2, Math.min(opts.nPC ?? 30, nHVG, ncells - 1));
  const rnd = mulberry32(42);
  const data = counts.data, ind = counts.indices, ptr = counts.indptr;

  // 1) per-cell library size → CP10k scale factor
  onStage("Normalizing counts…"); await tick();
  const lib = new Float64Array(ncells);
  for (let g = 0; g < ngenes; g++) for (let k = N(ptr[g]); k < N(ptr[g + 1]); k++) lib[N(ind[k])] += data[k] as number;
  const inv = new Float64Array(ncells);
  for (let c = 0; c < ncells; c++) inv[c] = lib[c] > 0 ? 1e4 / lib[c] : 0;

  // 2) per-gene mean & variance of log1p(CP10k) (zeros included) — for HVG + z-scoring
  onStage("Finding variable genes…"); await tick();
  const gMean = new Float64Array(ngenes), gVar = new Float64Array(ngenes);
  for (let g = 0; g < ngenes; g++) {
    let s = 0, ss = 0;
    for (let k = N(ptr[g]); k < N(ptr[g + 1]); k++) { const v = Math.log1p((data[k] as number) * inv[N(ind[k])]); s += v; ss += v * v; }
    const m = s / ncells; gMean[g] = m; gVar[g] = Math.max(ss / ncells - m * m, 0);
  }
  const hvg = Array.from({ length: ngenes }, (_, g) => g).sort((a, b) => gVar[b] - gVar[a]).slice(0, nHVG).sort((a, b) => a - b);
  const p = hvg.length;
  const colOf = new Int32Array(ngenes).fill(-1); hvg.forEach((g, j) => (colOf[g] = j));

  // 3) cells×HVG z-scored matrix (row-major); zeros → (0-μ)/σ, nonzeros overwrite; clip ±10
  onStage("Building expression matrix…"); await tick();
  const mu = new Float64Array(p), sd = new Float64Array(p);
  for (let j = 0; j < p; j++) { mu[j] = gMean[hvg[j]]; sd[j] = Math.sqrt(gVar[hvg[j]]) || 1; }
  const X = new Float32Array(ncells * p);
  for (let c = 0; c < ncells; c++) { const b = c * p; for (let j = 0; j < p; j++) X[b + j] = -mu[j] / sd[j]; }
  for (let g = 0; g < ngenes; g++) { const j = colOf[g]; if (j < 0) continue; for (let k = N(ptr[g]); k < N(ptr[g + 1]); k++) { const c = N(ind[k]); let z = (Math.log1p((data[k] as number) * inv[c]) - mu[j]) / sd[j]; X[c * p + j] = z > 10 ? 10 : z < -10 ? -10 : z; } }

  // 4) PCA (randomized SVD)
  onStage("Computing PCA…"); await tick();
  const { scores, eigs } = randomizedPCA(X, ncells, p, nPC, rnd);

  // 5) Louvain clustering on a kNN graph over the PCs
  onStage("Clustering cells (Louvain)…"); await tick();
  const { labels: clusters, nClusters } = clusterCells(scores, ncells, nPC, 15, rnd);

  // 6) UMAP on the PC scores
  onStage("Computing UMAP…"); await tick();
  const pts: number[][] = new Array(ncells);
  for (let c = 0; c < ncells; c++) { const row = new Array(nPC); for (let k = 0; k < nPC; k++) row[k] = scores[c * nPC + k]; pts[c] = row; }
  const nNeighbors = Math.max(5, Math.min(15, ncells - 1));
  const um = new UMAP({ nComponents: 2, nNeighbors, minDist: 0.3, random: rnd });
  const e2 = um.fit(pts);
  const umap = new Float32Array(ncells * 2);
  for (let c = 0; c < ncells; c++) { umap[c * 2] = e2[c][0]; umap[c * 2 + 1] = e2[c][1]; }

  return { umap, pca: scores, pcaDim: nPC, eigs: Array.from(eigs), hvg, nHVG: p, clusters, nClusters };
}
