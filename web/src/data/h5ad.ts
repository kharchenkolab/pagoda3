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

/** Map an opened h5wasm AnnData file to an L* DatasetSpec (pure — no h5wasm import; testable in node). */
export async function anndataSpec(f: H5): Promise<DatasetSpec> {
  const M = await createLstarKernels();
  const Xnode = f.get("X");
  const shape = Array.from(attr(Xnode, "shape") || [], num);
  // obs/var indices give the canonical cell/gene labels + counts
  const cells = (f.get("obs/_index")?.value as string[]) || [];
  const genes = (f.get("var/_index")?.value as string[]) || [];
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
      axes[ax] = { labels: Array.from({ length: sh[1] }, (_, i) => name + (i + 1)), role: "coordinate" };
      fields[name] = { role: "embedding", span: ["cells", ax], encoding: "dense", shape: [ncells, sh[1]], data: f32(node.value) };
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

/** Open a .h5ad File as an in-memory L* store (browser). */
export async function openH5ad(file: File): Promise<LstarStore> {
  const h5: any = await import("h5wasm");   // namespace: FS / ready / File are live bindings (set after ready)
  await h5.ready;
  const name = "/" + (file.name || "data.h5ad");
  h5.FS.writeFile(name, new Uint8Array(await file.arrayBuffer()));
  let f: H5;
  try {
    f = new h5.File(name, "r");
    guardSize(f, file.size);
    const spec = await anndataSpec(f);
    if (!spec.fields.counts && !Object.values(spec.fields).some((x) => x.role === "embedding"))
      throw new Error("No X/counts matrix or embedding found in this .h5ad.");
    const store = new MemStore();
    await writeStore(store, spec);                 // uncompressed in-memory L* store
    return store;
  } finally {
    try { f?.close?.(); h5.FS.unlink(name); } catch { /* */ }
  }
}
