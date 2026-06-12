// pagoda3 prep — the JS/WASM `write_viewer`: read an L* store, compute the viewer navigators with
// the libstar WASM kernels, and append them with lstar-js's addToStore. This is the single prep
// path the viewer can also run on the fly (same kernels, same math), so a prepped store and a
// bare-store-computed-live agree. No R or Python needed.
//
//   node --experimental-strip-types prep/prep.ts <store.lstar.zarr> [grouping=leiden] [also...]
//
// Computes (all optional to a plain reader): counts_cellmajor (cell-major CSR), per-grouping
// stats_*/markers_*, a whole-dataset od_score (residual over a smoothed mean-variance trend), and
// cell_order. Recomputes & overwrites — addToStore updates the manifest idempotently.
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import { openLstar } from "../../lstar/js/core/reader.ts";
import { NodeFSStore } from "../../lstar/js/core/node-store.ts";
import { addToStore } from "../../lstar/js/core/writer.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(HERE, "..", "..", "lstar", "js", "dist", "lstar_kernels.mjs");

async function loadKernels() {
  const mod: any = await import(WASM);
  return await mod.default();
}

// tricube-weighted local-linear LOWESS (same family as view.ts), evaluated at anchors + interpolated.
function lowess(xs: number[], ys: number[], span = 0.3, nAnchor = 200): (x: number) => number {
  const n = xs.length;
  if (n < 3) { const my = ys.reduce((s, v) => s + v, 0) / Math.max(n, 1); return () => my; }
  const ord = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const sx = ord.map((i) => xs[i]), sy = ord.map((i) => ys[i]);
  const win = Math.max(2, Math.floor(span * n));
  const lb = (arr: number[], x: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
  const ax: number[] = [], ay: number[] = [];
  for (let a = 0; a < nAnchor; a++) {
    const x0 = sx[0] + (sx[n - 1] - sx[0]) * a / (nAnchor - 1);
    let l = Math.max(0, lb(sx, x0) - (win >> 1)); const r = Math.min(n, l + win); l = Math.max(0, r - win);
    let maxd = 1e-9; for (let i = l; i < r; i++) maxd = Math.max(maxd, Math.abs(sx[i] - x0));
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (let i = l; i < r; i++) { const d = Math.abs(sx[i] - x0) / maxd, w = (1 - d * d * d) ** 3; sw += w; swx += w * sx[i]; swy += w * sy[i]; swxx += w * sx[i] * sx[i]; swxy += w * sx[i] * sy[i]; }
    const den = sw * swxx - swx * swx;
    ay.push(Math.abs(den) < 1e-12 ? swy / sw : ((swy - (sw * swxy - swx * swy) / den * swx) / sw) + (sw * swxy - swx * swy) / den * x0);
    ax.push(x0);
  }
  return (x: number) => {
    if (x <= ax[0]) return ay[0]; if (x >= ax[ax.length - 1]) return ay[ax.length - 1];
    let lo = 0, hi = ax.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ax[m] < x) lo = m + 1; else hi = m; }
    return ay[lo - 1] + (ay[lo] - ay[lo - 1]) * (x - ax[lo - 1]) / (ax[lo] - ax[lo - 1]);
  };
}

export async function prepStore(storePath: string, opts: { grouping?: string; also?: string[] } = {}): Promise<string[]> {
  const grouping = opts.grouping ?? "leiden";
  const also = opts.also ?? [];
  const M = await loadKernels();
  const store = new NodeFSStore(storePath);
  const ds = await openLstar(store);
  if (!ds.fields.has("counts")) throw new Error("prep: store has no `counts` measure");

  const sp = await ds.fieldSparse("counts");                       // CSC (cells, genes)
  const [ncells, ngenes] = sp.shape;
  const data = sp.data instanceof Float64Array ? sp.data : Float64Array.from(sp.data);
  const indptr = Int32Array.from(sp.indptr), indices = Int32Array.from(sp.indices);

  const fields: Record<string, any> = {};
  const axes: Record<string, any> = {};

  // counts in cell-major (CSR) orientation, raw — the substrate for on-the-fly scope compute
  const csr = M.cscToCsr(data, indices, indptr, ncells, ngenes);
  fields["counts_cellmajor"] = {
    role: "measure", span: ["cells", "genes"], encoding: "csr", state: "raw", shape: [ncells, ngenes],
    data: Int32Array.from(csr.data), indices: Int32Array.from(csr.indices), indptr: Int32Array.from(csr.indptr),
  };

  // whole-dataset od_score: one group over all cells -> per-gene mean/var(log1p) -> residual over the trend
  const all = new Int32Array(ncells);
  const gAll = M.colSumByGroup(data, indptr, indices, ncells, ngenes, all, 1, true);
  const xs: number[] = [], ys: number[] = [], gi: number[] = [];
  for (let g = 0; g < ngenes; g++) {
    const m = (gAll.sum as Float64Array)[g] / ncells;
    const v = Math.max((gAll.sumsq as Float64Array)[g] / ncells - m * m, 0);
    if (m > 0 && v > 0) { xs.push(Math.log(m)); ys.push(Math.log(v)); gi.push(g); }
  }
  const od = new Float32Array(ngenes);
  if (gi.length > 10) { const tr = lowess(xs, ys); for (let k = 0; k < gi.length; k++) od[gi[k]] = ys[k] - tr(xs[k]); }
  fields["od_score"] = { role: "measure", span: ["genes"], encoding: "dense", shape: [ngenes], data: od };

  // per-annotation cluster stats + marker tables; cell_order from the primary grouping
  let primaryCode: Int32Array | null = null;
  for (const gp of [grouping, ...also].filter((g, i, a) => a.indexOf(g) === i)) {
    if (!ds.fields.has(gp)) continue;
    const labels = await ds.fieldStrings(gp);
    const groups = [...new Set(labels)].sort();
    const gidx = new Map(groups.map((g, i) => [g, i])); const K = groups.length;
    const code = Int32Array.from(labels.map((l) => gidx.get(l)!));
    if (gp === grouping) primaryCode = code;
    const gs = M.colSumByGroup(data, indptr, indices, ncells, ngenes, code, K, true);
    const S = gs.sum as Float64Array, SS = gs.sumsq as Float64Array, NE = gs.n_expr as Float64Array;
    const n = new Int32Array(K); for (const c of code) n[c]++;
    const grand = new Float64Array(ngenes); for (let g = 0; g < K; g++) for (let j = 0; j < ngenes; j++) grand[j] += S[g * ngenes + j];
    const lfc = new Float32Array(ngenes * K), padj = new Float32Array(ngenes * K);
    for (let g = 0; g < K; g++) {
      const ng1 = Math.max(n[g], 1), nr = Math.max(ncells - n[g], 1);
      for (let j = 0; j < ngenes; j++) {
        const mu = S[g * ngenes + j] / ng1, mr = (grand[j] - S[g * ngenes + j]) / nr, d = mu - mr;
        lfc[j * K + g] = d;
        padj[j * K + g] = Math.min(Math.max(Math.exp(-Math.abs(d * Math.sqrt(NE[g * ngenes + j] + 1))), 1e-12), 1);
      }
    }
    axes["groups_" + gp] = { labels: groups, origin: "derived", role: "feature" };
    const sg = ["groups_" + gp, "genes"];
    fields["stats_" + gp + "_sum"] = { role: "measure", span: sg, encoding: "dense", shape: [K, ngenes], data: Float32Array.from(S) };
    fields["stats_" + gp + "_sumsq"] = { role: "measure", span: sg, encoding: "dense", shape: [K, ngenes], data: Float32Array.from(SS) };
    fields["stats_" + gp + "_nexpr"] = { role: "measure", span: sg, encoding: "dense", shape: [K, ngenes], data: Float32Array.from(NE) };
    fields["markers_" + gp + "_lfc"] = { role: "measure", span: ["genes", "groups_" + gp], encoding: "dense", shape: [ngenes, K], data: lfc };
    fields["markers_" + gp + "_padj"] = { role: "measure", span: ["genes", "groups_" + gp], encoding: "dense", shape: [ngenes, K], data: padj };
  }
  const order = Int32Array.from(Array.from({ length: ncells }, (_, i) => i).sort((a, b) => (primaryCode![a] - primaryCode![b]) || (a - b)));
  fields["cell_order"] = { role: "measure", span: ["cells"], encoding: "dense", state: "permutation", shape: [ncells], data: order };

  await addToStore(store, { axes, fields, profiles: ["viewer@0.1"] });
  return Object.keys(fields);
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [storePath, grouping, ...also] = process.argv.slice(2);
  if (!storePath) { console.error("usage: prep.ts <store.lstar.zarr> [grouping] [also...]"); process.exit(1); }
  prepStore(storePath, { grouping, also }).then((f) => console.log("pagoda3 prep: wrote", f.length, "fields ->", storePath))
    .catch((e) => { console.error(e); process.exit(1); });
}
