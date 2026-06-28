// Recompute the global od_score with the CURRENT method (per-gene mean/var of log1p over all cells → residual over a
// tricube-lowess trend) and overwrite the stale stored field. pbmc6's od_score predates this method (corr 0.38);
// stats_/markers_ are already current. Reads the gene-major `counts` CSC (unchanged by the cell-major reorder), so it
// runs identically on the canonical and hybrid stores.   node prep/recompute_od.mjs <store> [<store> ...]
import fs from "node:fs";
import path from "node:path";

const chunkKey = (za) => za.shape.map(() => "0").join(".");
function readChunk(root, meta, field) {
  const za = meta[field + "/.zarray"]; if (!za) throw new Error("no .zarray for " + field);
  const buf = fs.readFileSync(path.join(root, field, chunkKey(za)));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  switch (za.dtype) { case "<i4": return new Int32Array(ab); case "<f8": return new Float64Array(ab); case "<i8": return new BigInt64Array(ab); default: throw new Error("dtype " + za.dtype); }
}

// tricube lowess — a verbatim port of prep.ts lowess(span=0.3, nAnchor=200)
function lowess(xs, ys, span = 0.3, nAnchor = 200) {
  const n = xs.length;
  if (n < 3) { const my = ys.reduce((s, v) => s + v, 0) / Math.max(n, 1); return () => my; }
  const ord = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const sx = ord.map((i) => xs[i]), sy = ord.map((i) => ys[i]);
  const win = Math.max(2, Math.floor(span * n));
  const lb = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
  const ax = [], ay = [];
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
  return (x) => {
    if (x <= ax[0]) return ay[0]; if (x >= ax[ax.length - 1]) return ay[ax.length - 1];
    let lo = 0, hi = ax.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ax[m] < x) lo = m + 1; else hi = m; }
    return ay[lo - 1] + (ay[lo] - ay[lo - 1]) * (x - ax[lo - 1]) / (ax[lo] - ax[lo - 1]);
  };
}

for (const root of process.argv.slice(2)) {
  const meta = JSON.parse(fs.readFileSync(path.join(root, ".zmetadata"), "utf8")).metadata;
  const shape = meta["fields/counts/.zattrs"].lstar.shape;   // [ncells, ngenes]
  const ncells = shape[0], ngenes = shape[1];
  const data = readChunk(root, meta, "fields/counts/data");     // i4 counts (gene-major CSC values)
  const indptr = readChunk(root, meta, "fields/counts/indptr"); // i4 [ngenes+1] (per-gene column pointers)
  // per-gene mean/var of log1p over ALL cells (zeros contribute 0)
  const xs = [], ys = [], gi = [];
  for (let g = 0; g < ngenes; g++) {
    let s = 0, ss = 0;
    for (let k = Number(indptr[g]); k < Number(indptr[g + 1]); k++) { const v = Math.log1p(data[k]); s += v; ss += v * v; }
    const m = s / ncells, varr = Math.max(ss / ncells - m * m, 0);
    if (m > 0 && varr > 0) { xs.push(Math.log(m)); ys.push(Math.log(varr)); gi.push(g); }
  }
  const od = new Float64Array(ngenes);   // stored field is f8
  if (gi.length > 10) { const tr = lowess(xs, ys); for (let k = 0; k < gi.length; k++) od[gi[k]] = ys[k] - tr(xs[k]); }
  const za = meta["fields/od_score/values/.zarray"];
  fs.writeFileSync(path.join(root, "fields/od_score/values", chunkKey(za)), Buffer.from(od.buffer));
  // top genes for a sanity check
  const top = Array.from(od, (v, g) => [g, v]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g);
  console.log(`[od] ${root}: rewrote od_score (${ngenes} genes, ${gi.length} fit). top-6 gene idx: ${top.join(",")}`);
}
