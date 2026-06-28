// One-off: produce a LOCALITY-ORDERED copy of an .lstar.zarr store for the viewer — physically reorder the cell-major
// counts rows by a HYBRID order (cluster-major, Hilbert-within), and add a `counts_cellmajor_order` field (cell ->
// physical row). The reader's csrRows applies that permutation, so a cluster/lasso selection coalesces into 1-few
// byte-range reads instead of thousands (the win grows with network latency). Raw zarr edits — no package/ts-runner dep.
//   node prep/reorder.mjs [srcStore] [dstStore] [groupingField]
import fs from "node:fs";
import path from "node:path";

const SRC = process.argv[2] || "web/public/pbmc6.lstar.zarr";
const DST = process.argv[3] || "web/public/pbmc6_hybrid.lstar.zarr";
const GROUP = process.argv[4] || "cell_type";   // primary key — users/agents select by the annotated populations
const N_GRID = 1024;

const zmetaPath = (root) => path.join(root, ".zmetadata");
const TD = new TextDecoder();

const chunkKey = (za) => za.shape.map(() => "0").join(".");   // single-chunk array → "0" (1D) or "0.0" (2D), per zarr v2
function readChunk(root, meta, field) {   // field e.g. "fields/counts_cellmajor/data" → its single chunk as a typed array
  const za = meta[field + "/.zarray"];
  if (!za) throw new Error("no .zarray for " + field);
  const buf = fs.readFileSync(path.join(root, field, chunkKey(za)));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  switch (za.dtype) {
    case "<i4": return new Int32Array(ab);
    case "<f8": return new Float64Array(ab);
    case "<i8": return new BigInt64Array(ab);
    case "|u1": return new Uint8Array(ab);
    default: throw new Error("unhandled dtype " + za.dtype);
  }
}
const writeChunk = (root, field, arr) => fs.writeFileSync(path.join(root, field, "0"), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));

// canonical Hilbert xy→d on an N×N grid (N a power of 2)
function xy2d(N, x, y) {
  let d = 0;
  for (let s = N >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { x = N - 1 - x; y = N - 1 - y; } const t = x; x = y; y = t; }
  }
  return d;
}

console.log(`[reorder] ${SRC} → ${DST}  (group=${GROUP})`);
fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });
const meta = JSON.parse(fs.readFileSync(zmetaPath(DST), "utf8")).metadata;

// --- read what we need ---
const indptr = readChunk(DST, meta, "fields/counts_cellmajor/indptr");   // i4 [n+1]
const data = readChunk(DST, meta, "fields/counts_cellmajor/data");        // i4 [nnz]
const indices = readChunk(DST, meta, "fields/counts_cellmajor/indices");  // i4 [nnz]
const n = indptr.length - 1, nnz = data.length;
const umap = readChunk(DST, meta, "fields/umap/values");                   // f8 [n*2]
// decode the grouping (utf8 field) → per-cell code
const gbytes = readChunk(DST, meta, `fields/${GROUP}/values`);
const goff = readChunk(DST, meta, `fields/${GROUP}/values_offsets`);       // i8 [n+1]
const catCode = new Map(); const code = new Int32Array(n);
for (let i = 0; i < n; i++) { const s = TD.decode(gbytes.subarray(Number(goff[i]), Number(goff[i + 1]))); if (!catCode.has(s)) catCode.set(s, catCode.size); code[i] = catCode.get(s); }
console.log(`[reorder] n=${n} nnz=${nnz} groups=${catCode.size}`);

// --- hybrid order: cluster-major, Hilbert-within ---
let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
for (let i = 0; i < n; i++) { const x = umap[i * 2], y = umap[i * 2 + 1]; if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; }
const hil = new Float64Array(n);
for (let i = 0; i < n; i++) {
  const gx = Math.min(N_GRID - 1, Math.floor((umap[i * 2] - mnx) / (mxx - mnx) * (N_GRID - 1)));
  const gy = Math.min(N_GRID - 1, Math.floor((umap[i * 2 + 1] - mny) / (mxy - mny) * (N_GRID - 1)));
  hil[i] = xy2d(N_GRID, gx, gy);
}
const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (code[a] - code[b]) || (hil[a] - hil[b]));   // physical row p holds cell order[p]
const posOf = new Float64Array(n);   // cell -> physical row (f8 to match the dense-field path; values are exact integers)
for (let p = 0; p < n; p++) posOf[order[p]] = p;

// --- reorder the CSR rows by `order` ---
const newData = new Int32Array(nnz), newIdx = new Int32Array(nnz), newIndptr = new Int32Array(n + 1);
let w = 0;
for (let p = 0; p < n; p++) { const c = order[p]; newIndptr[p] = w; for (let k = indptr[c]; k < indptr[c + 1]; k++) { newData[w] = data[k]; newIdx[w] = indices[k]; w++; } }
newIndptr[n] = w;
if (w !== nnz) throw new Error(`nnz mismatch ${w} != ${nnz}`);
writeChunk(DST, "fields/counts_cellmajor/data", newData);
writeChunk(DST, "fields/counts_cellmajor/indices", newIdx);
writeChunk(DST, "fields/counts_cellmajor/indptr", newIndptr);

// --- add the permutation field counts_cellmajor_order (dense f8, cell -> physical row) ---
const OF = "counts_cellmajor_order";
const odir = path.join(DST, "fields", OF);
fs.mkdirSync(path.join(odir, "values"), { recursive: true });
const lstarAttrs = { lstar: { coverage: "full", directed: null, encoding: "dense", kind: "field", provenance: { method: "reorder", params: { group: GROUP, curve: "hilbert", grid: N_GRID } }, role: "measure", span: ["cells"], state: null, subtype: null, uncertainty: null, weighted: null } };
const zarray = { chunks: [n], compressor: null, dtype: "<f8", fill_value: 0, filters: null, order: "C", shape: [n], zarr_format: 2 };
fs.writeFileSync(path.join(odir, ".zgroup"), JSON.stringify({ zarr_format: 2 }));
fs.writeFileSync(path.join(odir, ".zattrs"), JSON.stringify(lstarAttrs));
fs.writeFileSync(path.join(odir, "values", ".zattrs"), JSON.stringify({}));
fs.writeFileSync(path.join(odir, "values", ".zarray"), JSON.stringify(zarray));
writeChunk(DST, `fields/${OF}/values`, posOf);

// --- update the consolidated manifest: register the new field (both the fields list and its consolidated entries) ---
const full = JSON.parse(fs.readFileSync(zmetaPath(DST), "utf8"));
const m = full.metadata;
if (!m[".zattrs"].lstar.fields.includes(OF)) m[".zattrs"].lstar.fields.push(OF);
m[`fields/${OF}/.zgroup`] = { zarr_format: 2 };
m[`fields/${OF}/.zattrs`] = lstarAttrs;
m[`fields/${OF}/values/.zarray`] = zarray;
m[`fields/${OF}/values/.zattrs`] = {};
fs.writeFileSync(zmetaPath(DST), JSON.stringify(full));

// --- quick self-check: run count for a couple of clusters under the new physical order ---
const runsOf = (cells) => { const s = cells.map((c) => posOf[c]).sort((a, b) => a - b); let r = s.length ? 1 : 0; for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1] + 1) r++; return r; };
const byGroup = {}; for (let i = 0; i < n; i++) { const g = [...catCode.keys()][code[i]]; (byGroup[g] ||= []).push(i); }
const sample = Object.entries(byGroup).sort((a, b) => b[1].length - a[1].length).slice(0, 3);
console.log("[reorder] done. runs/cluster under hybrid order:", sample.map(([g, c]) => `${g}(${c.length})→${runsOf(c)}`).join("  "));
