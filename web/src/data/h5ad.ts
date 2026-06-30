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
// h5wasm `.value` (and the WASM kernel's output) are VIEWS into WASM heap — copy them out before the
// file is closed / the shared kernel heap is reused, or the bytes go garbage after the store is built.
const cp = (a: any): any => (a && typeof a.slice === "function" && a.BYTES_PER_ELEMENT) ? a.slice() : a;

// AnnData stores X as obs×var, almost always CSR (row=cell). L* `counts` is CSC (col=gene). A CSR
// (cells×genes) shares memory with a CSC (genes×cells), so `cscToCsr(.., ngenes, ncells)` regroups it
// into the CSC (cells×genes) we want. A csc_matrix is already that; a dense X is packed column-major.
async function readCounts(M: any, node: H5, ncells: number, ngenes: number):
    Promise<{ data: ArrayLike<number>; indices: ArrayLike<number>; indptr: ArrayLike<number> } | null> {
  const e = enc(node);
  if (e === "csr_matrix") {
    const r = M.cscToCsr(node.get("data").value, node.get("indices").value, node.get("indptr").value, ngenes, ncells);
    return { data: cp(r.data), indices: cp(r.indices), indptr: cp(r.indptr) };
  }
  if (e === "csc_matrix") {
    return { data: cp(node.get("data").value), indices: cp(node.get("indices").value), indptr: cp(node.get("indptr").value) };
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
      fields[name] = { role: "embedding", span: ["cells", ax], encoding: "dense", shape: [ncells, sh[1]], data: cp(node.value) as ArrayLike<number> };
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
        fields[col] = { role: "measure", span: ["cells"], encoding: "dense", shape: [ncells], data: cp(node.value) as ArrayLike<number> };
      }
    }
  } catch { /* no obs */ }

  return { kind: "sample", axes, fields, profiles: [] };
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
