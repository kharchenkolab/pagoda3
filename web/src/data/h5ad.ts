// Read an AnnData .h5ad (HDF5) in the browser — no server, no conversion step — and turn it into an
// in-memory L* store the normal reader/viewer opens unchanged. h5wasm reads the HDF5; we map the
// AnnData layout (X / layers.counts, obs columns, var index, obsm embeddings) to an L* DatasetSpec and
// `writeStore` it into a MemStore. Common scanpy layout (encoding-version 0.1/0.2); variants are
// best-effort. Loads the whole file into WASM memory → small/medium datasets (same ceiling as a zip).
import { writeStore, type DatasetSpec, type FieldSpec, type AxisSpec } from "../../../../lstar/js/core/writer.ts";
import type { LstarStore } from "./store.ts";
import { MemStore } from "./localstore.ts";
// @ts-ignore — generated WASM-glue module, no .d.ts (same import pattern as lstar/js extend.ts)
import createLstarKernels from "../../../../lstar/js/dist/lstar_kernels.mjs";

type H5 = any;   // an opened h5wasm File / Group (duck-typed; we never import h5wasm types here)

const attr = (it: H5, k: string) => it?.attrs?.[k]?.value;
const enc = (it: H5) => attr(it, "encoding-type");
const num = (v: any) => (typeof v === "bigint" ? Number(v) : v);
// Copy out of WASM heap (h5wasm `.value` / kernel output are heap views, invalid after close/reuse) AND
// right-size: AnnData uses int64 indices/indptr (BigInt64Array) for large matrices, which the int32 WASM
// kernel can't take — and f64 X wastes half the RAM. So sparse index/ptr -> Int32Array (values are
// cell/gene indices, always < 2^31 for browser-feasible data) and counts -> Float32Array.
const i32 = (a: any): Int32Array => Int32Array.from(a as any, Number);   // int32 | int64(BigInt) -> int32
const f32 = (a: any): Float32Array => Float32Array.from(a as any, Number); // f32 | f64 -> f32

// AnnData stores X as obs×var, almost always CSR (row=cell). L* `counts` is CSC (col=gene). A CSR
// (cells×genes) shares memory with a CSC (genes×cells), so `cscToCsr(.., ngenes, ncells)` regroups it
// into the CSC (cells×genes) we want. A csc_matrix is already that; a dense X is packed column-major.
async function readCounts(M: any, node: H5, ncells: number, ngenes: number):
    Promise<{ data: ArrayLike<number>; indices: ArrayLike<number>; indptr: ArrayLike<number> } | null> {
  const e = enc(node);
  if (e === "csr_matrix") {
    const r = M.cscToCsr(f32(node.get("data").value), i32(node.get("indices").value), i32(node.get("indptr").value), ngenes, ncells);
    return { data: f32(r.data), indices: i32(r.indices), indptr: i32(r.indptr) };
  }
  if (e === "csc_matrix") {
    return { data: f32(node.get("data").value), indices: i32(node.get("indices").value), indptr: i32(node.get("indptr").value) };
  }
  if (node.value && node.shape) {                 // dense obs×var (C-order) -> build CSC by column
    const dense = node.value as ArrayLike<number>;
    const data: number[] = [], indices: number[] = [], indptr: number[] = [0];
    for (let g = 0; g < ngenes; g++) {
      for (let c = 0; c < ncells; c++) { const v = dense[c * ngenes + g]; if (v) { data.push(v); indices.push(c); } }
      indptr.push(data.length);
    }
    return { data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr) };
  }
  return null;
}

// An AnnData dataframe stores its row labels in a *named* column, with the group's `_index` attr giving
// that column's name (commonly "_index" or "index"). Reading a hardcoded "_index" child misses real
// files — resolve the name from the attr, then fall back to a literal "_index" child.
function dfIndex(grp: H5): string[] {
  if (!grp || typeof grp.get !== "function") return [];
  const name = attr(grp, "_index") || "_index";
  const node = grp.get(name) || grp.get("_index");
  const v = node?.value;
  return v ? Array.from(v as any, String) : [];
}

/** Map an opened h5wasm AnnData file to an L* DatasetSpec (pure — no h5wasm import; testable in node). */
export async function anndataSpec(f: H5): Promise<DatasetSpec> {
  const M = await createLstarKernels();
  // Legacy AnnData (pre-0.7) stored obs/var as compound HDF5 *tables* (a Dataset), not a group of
  // columns. We read the modern group layout; detect the old one and tell the user how to upgrade it
  // rather than failing deep inside the reader with an opaque "v3 array or group".
  // Legacy AnnData (pre-0.7) stores obs/var/obsm as compound HDF5 *tables* (a Dataset), not groups of
  // columns. A real h5wasm Group has `.keys()`; a compound Dataset doesn't — dispatch to the legacy reader.
  const obsNode = f.get("obs");
  if (obsNode && typeof (obsNode as any).keys !== "function") return legacyAnndataSpec(f, M);
  const Xnode = f.get("X");
  // A sparse X (group) carries its dims in a `shape` attr; a dense X (dataset) has no such attr — its
  // shape is intrinsic. Use the attr when present, else the dataset's own shape.
  let shape = Array.from(attr(Xnode, "shape") || [], num);
  if (shape.length !== 2 && Array.isArray((Xnode as any)?.shape)) shape = Array.from((Xnode as any).shape, num);
  // obs/var indices give the canonical cell/gene labels + counts
  const cells = dfIndex(f.get("obs"));
  const genes = dfIndex(f.get("var"));
  const ncells = cells.length || num(shape[0]) || 0;
  const ngenes = genes.length || num(shape[1]) || 0;

  const axes: Record<string, AxisSpec> = {
    cells: { labels: cells.length ? cells : Array.from({ length: ncells }, (_, i) => "cell" + i), role: "observation" },
    genes: { labels: genes.length ? genes : Array.from({ length: ngenes }, (_, i) => "gene" + i), role: "feature" },
  };
  const fields: Record<string, FieldSpec> = {};

  // counts: prefer layers/counts (raw), else X
  let countsNode = Xnode;
  try { const lc = f.get("layers/counts"); if (lc) countsNode = lc; } catch { /* no layer */ }
  const csc = await readCounts(M, countsNode, ncells, ngenes);
  if (csc) {
    const sample = csc.data as ArrayLike<number>;
    let raw = true; for (let i = 0; i < Math.min(sample.length, 5000); i++) if (sample[i] !== Math.round(sample[i] as number)) { raw = false; break; }
    fields.counts = { role: "measure", span: ["cells", "genes"], encoding: "csc", state: raw ? "raw" : "lognorm",
                      shape: [ncells, ngenes], data: csc.data, indices: csc.indices, indptr: csc.indptr };
  }

  // obsm embeddings (X_umap, X_pca, …) -> dense [cells, k] fields, role "embedding"
  try {
    const obsm = f.get("obsm");
    for (const key of obsm.keys()) {
      const node = obsm.get(key);
      const sh = (node.shape || []).map(num);
      if (sh.length !== 2 || sh[0] !== ncells || sh[1] < 2) continue;
      const name = key.replace(/^X_/, "").toLowerCase() || key;
      const ax = "emb_" + name;
      // The viewer scatters in 2D — keep the first two components (PC1/PC2, UMAP1/2). This also avoids a
      // wide obsm like X_pca[n,50] becoming a 50-column "embedding" (and wasting that much memory).
      const k = Math.min(sh[1], 2);
      const full = f32(node.value);
      let data = full;
      if (k !== sh[1]) { data = new Float32Array(ncells * k); for (let i = 0; i < ncells; i++) for (let j = 0; j < k; j++) data[i * k + j] = full[i * sh[1] + j]; }
      axes[ax] = { labels: Array.from({ length: k }, (_, i) => name + (i + 1)), role: "coordinate" };
      fields[name] = { role: "embedding", span: ["cells", ax], encoding: "dense", shape: [ncells, k], data };
    }
  } catch { /* no obsm */ }

  // obs columns: categorical -> label; numeric -> dense measure over cells
  try {
    const obs = f.get("obs");
    const cols = (attr(obs, "column-order") as string[]) || obs.keys().filter((k: string) => k !== "_index");
    for (const col of cols) {
      if (col === "_index") continue;
      const node = obs.get(col); if (!node) continue;
      const e = enc(node);
      if (e === "categorical") {
        // store as a utf8 (per-cell string) label — the form the viewer's metadata() reads for labels
        // (it expands strings → codes/categories itself); an `encoding:"categorical"` field would make it
        // try a utf8 read of a non-existent `values` array.
        const codes = node.get("codes").value as ArrayLike<number>;
        const cats = node.get("categories").value as string[];
        const values: string[] = new Array(codes.length);
        for (let i = 0; i < codes.length; i++) { const c = codes[i] as number; values[i] = (c >= 0 && c < cats.length) ? cats[c] : ""; }
        fields[col] = { role: "label", span: ["cells"], encoding: "utf8", values };
      } else if ((e === "array" || node.value) && node.shape && node.shape.length === 1 && typeof (node.value as any)?.[0] === "number") {
        fields[col] = { role: "measure", span: ["cells"], encoding: "dense", shape: [ncells], data: f32(node.value) };
      }
    }
  } catch { /* no obs */ }

  return { kind: "sample", axes, fields, profiles: [] };
}

// ── legacy AnnData (pre-0.7) ──────────────────────────────────────────────────────────────────────
// obs/var/obsm are compound HDF5 *tables*: ONE dataset whose rows are structs. h5wasm reads a compound
// dataset's `.value` as an array of rows (each row = the member values in `.dtype` order; array-typed
// members like X_umap come back as nested arrays) — plain JS values, already off the WASM heap. Categorical
// obs columns are stored as integer CODES, with the category names in `uns/<col>_categories` (legacy idiom).
function compoundMembers(node: any): { name: string; shape: number[] | null }[] {
  const dt = node?.dtype;                                  // e.g. [["index","A16"],["louvain","<b"]] or [["X_pca","<f",[50]]]
  if (!Array.isArray(dt)) return [];
  return dt.map((m: any) => ({ name: String(m[0]), shape: Array.isArray(m[2]) ? m[2].map(Number) : null }));
}

async function legacyAnndataSpec(f: H5, M: any): Promise<DatasetSpec> {
  // read a compound obs/var table → its row index (the cell/gene labels) + the non-index column descriptors
  const readTable = (node: any) => {
    const members = compoundMembers(node);
    const rows = (node?.value as any[]) || [];
    const want = attr(node, "_index");
    let idx = members.findIndex((m) => m.name === want);
    if (idx < 0) idx = members.findIndex((m) => /^_?index$/i.test(m.name));
    if (idx < 0) idx = 0;
    return { index: rows.map((r) => String(r[idx])), rows, cols: members.map((m, i) => ({ ...m, i })).filter((m) => m.i !== idx) };
  };
  const obs = readTable(f.get("obs"));
  const varr = readTable(f.get("var"));
  const ncells = obs.index.length, ngenes = varr.index.length;

  const axes: Record<string, AxisSpec> = {
    cells: { labels: obs.index, role: "observation" },
    genes: { labels: varr.index, role: "feature" },
  };
  const fields: Record<string, FieldSpec> = {};

  // counts: X (dense or sparse) — same matrix reader as the modern path
  let countsNode = f.get("X");
  try { const lc = f.get("layers/counts"); if (lc) countsNode = lc; } catch { /* */ }
  if (countsNode) {
    const csc = await readCounts(M, countsNode, ncells, ngenes);
    if (csc) {
      const s = csc.data as ArrayLike<number>; let raw = true;
      for (let i = 0; i < Math.min(s.length, 5000); i++) if (s[i] !== Math.round(s[i] as number)) { raw = false; break; }
      fields.counts = { role: "measure", span: ["cells", "genes"], encoding: "csc", state: raw ? "raw" : "lognorm",
                        shape: [ncells, ngenes], data: csc.data, indices: csc.indices, indptr: csc.indptr };
    }
  }

  // obs columns: categorical (int codes + uns/<name>_categories) → utf8 label; numeric → dense measure
  const unsCats = (name: string): string[] | null => {
    try { const v = f.get("uns/" + name + "_categories")?.value; return v ? Array.from(v as any, String) : null; } catch { return null; }
  };
  for (const c of obs.cols) {
    if (c.shape) continue;                                 // array-typed members live in obsm, not obs
    const vals = obs.rows.map((r) => r[c.i]);
    const first = vals[0], cats = unsCats(c.name);
    if (cats && typeof first === "number") {
      fields[c.name] = { role: "label", span: ["cells"], encoding: "utf8",
                         values: vals.map((code: number) => (code >= 0 && code < cats.length) ? cats[code] : "") };
    } else if (typeof first === "number") {
      fields[c.name] = { role: "measure", span: ["cells"], encoding: "dense", shape: [ncells], data: Float32Array.from(vals, Number) };
    } else if (typeof first === "string") {
      fields[c.name] = { role: "label", span: ["cells"], encoding: "utf8", values: vals.map(String) };
    }
  }

  // obsm: a compound table whose members are arrays (X_umap[2], X_pca[50], …) → 2D embeddings (clamped to 2)
  try {
    const obsmNode: any = f.get("obsm");
    if (obsmNode && typeof obsmNode.keys !== "function") {
      const members = compoundMembers(obsmNode);
      const rows = obsmNode.value as any[];
      members.forEach((m, mi) => {
        const dim = m.shape ? m.shape[0] : 0;
        if (dim < 2) return;
        const k = Math.min(dim, 2);
        const name = m.name.replace(/^X_/, "").toLowerCase() || m.name;
        const ax = "emb_" + name;
        const data = new Float32Array(ncells * k);
        for (let i = 0; i < ncells; i++) { const vec = rows[i]?.[mi] || []; for (let j = 0; j < k; j++) data[i * k + j] = Number(vec[j]); }
        axes[ax] = { labels: Array.from({ length: k }, (_, i) => name + (i + 1)), role: "coordinate" };
        fields[name] = { role: "embedding", span: ["cells", ax], encoding: "dense", shape: [ncells, k], data };
      });
    }
  } catch { /* no obsm */ }

  return { kind: "sample", axes, fields, profiles: [] };
}

// Estimate the in-memory peak from cheap shape metadata (no data read) and refuse files too big to
// open in the browser — which loads the WHOLE matrix — pointing instead at the server-side path. Peak
// ≈ the matrix as f32 data + i32 indices (≈8 B/nnz) held a few times over (JS arrays, kernel, the
// MemStore copy) plus the file bytes already in the WASM heap.
const PEAK_PER_NNZ = 8 * 3;        // ~3 concurrent copies of (data+indices)
const HARD_LIMIT = 2.0e9;          // ~2 GB est. peak → refuse (a browser tab gets shaky past this)
const SOFT_LIMIT = 0.8e9;          // ~0.8 GB → warn but proceed
export function guardSize(f: H5, fileBytes: number): void {
  const X = f.get("X");
  let nnz = 0;
  try { const dn = X?.get?.("data"); if (dn?.shape) nnz = Number(dn.shape[0]); } catch { /* dense or absent */ }
  if (!nnz) { const s = Array.from(attr(X, "shape") || X?.shape || [], num); if (s.length === 2) nnz = s[0] * s[1]; }
  const est = nnz * PEAK_PER_NNZ + (fileBytes || 0);
  const gb = (est / 1e9).toFixed(1);
  if (est > HARD_LIMIT) {
    throw new Error(
      `This .h5ad needs ~${gb} GB in memory — too large to open in the browser, which loads the whole file. ` +
      `Convert it once and open the optimized store instead:  pagoda3.view(adata)  (Python/R), or  ` +
      `lstar convert in.h5ad out.lstar.zarr --viewer  then open out.lstar.zarr.`);
  }
  if (est > SOFT_LIMIT) console.warn(`[pagoda3] opening a large .h5ad (~${gb} GB in memory) — may be slow; for big data prefer pagoda3.view() / lstar convert.`);
}

/** Open a .h5ad File as an in-memory L* store (browser). `onStage` reports progress for the modal. */
export async function openH5ad(file: File, onStage?: (m: string) => void): Promise<LstarStore> {
  onStage?.("Loading HDF5 reader…");
  const h5: any = await import("h5wasm");   // namespace: FS / ready / File are live bindings (set after ready)
  await h5.ready;
  const name = "/" + (file.name || "data.h5ad");
  onStage?.("Reading file…");
  h5.FS.writeFile(name, new Uint8Array(await file.arrayBuffer()));
  let f: H5;
  try {
    f = new h5.File(name, "r");
    guardSize(f, file.size);
    onStage?.("Parsing AnnData…");
    const spec = await anndataSpec(f);
    const hasEmbedding = Object.values(spec.fields).some((x) => x.role === "embedding");
    if (!spec.fields.counts && !hasEmbedding)
      throw new Error("No X/counts matrix or embedding found in this .h5ad.");
    // A counts-only file (no obsm/UMAP/PCA) can't be plotted as-is — compute an embedding in-browser so it
    // opens. Gated by cell count: above the limit, in-browser PCA+UMAP would hang the tab — say so plainly.
    if (!hasEmbedding && spec.fields.counts) {
      const cf: any = spec.fields.counts, [ncells, ngenes] = cf.shape, LIMIT = 30000;
      if (ncells > LIMIT)
        throw new Error(`This .h5ad has ${ncells.toLocaleString()} cells but no embedding (no UMAP/PCA in the file). ` +
          `Computing one in the browser is only practical up to ~${LIMIT.toLocaleString()} cells. For a dataset this size, ` +
          `precompute the layout once (scanpy: sc.pp.pca + sc.tl.umap; or pagoda3) and reopen the file.`);
      const { computeEmbedding } = await import("../compute/embed.ts");   // lazy — code-splits umap-js out of the main bundle
      onStage?.("No embedding in file — computing layout…");
      const emb = await computeEmbedding({ data: cf.data, indices: cf.indices, indptr: cf.indptr }, ncells, ngenes, { onStage });
      spec.axes.emb_umap = { labels: ["umap1", "umap2"], role: "coordinate" };
      spec.fields.umap = { role: "embedding", span: ["cells", "emb_umap"], encoding: "dense", shape: [ncells, 2], data: emb.umap };
    }
    onStage?.("Building in-memory store…");
    const store = new MemStore();
    await writeStore(store, spec);                 // uncompressed in-memory L* store
    return store;
  } finally {
    try { f?.close?.(); h5.FS.unlink(name); } catch { /* */ }
  }
}
