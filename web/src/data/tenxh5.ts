// 10x Cell Ranger .h5 feature-barcode matrix — a single HDF5 file, read with the same h5wasm as .h5ad. Two
// layouts: Cell Ranger 3+ ( /matrix/{data,indices,indptr,shape,barcodes} + /matrix/features/{name,id} ) and
// legacy CR2 ( /<genome>/{data,indices,indptr,shape,genes,gene_names,barcodes} ). The matrix is genes×cells
// stored CSC over cells (indptr over barcodes) — structurally identical to an AnnData csr_matrix, so it regroups
// to the store's gene-major CSC with the SAME kernel. Gene labels use the SYMBOL column (not the Ensembl id).
import createLstarKernels from "../../../../lstar/js/dist/lstar_kernels.mjs";
import { type DatasetSpec, type AxisSpec, type FieldSpec } from "../../../../lstar/js/core/writer.ts";
import type { LstarStore } from "./store.ts";
import type { OpenProgress } from "../ui/loading.ts";
import { assertSparseOk } from "./h5adcheck.ts";
import { finalizeSpec } from "./intake.ts";

const num = (v: any) => (typeof v === "bigint" ? Number(v) : v);
const i32 = (a: any): Int32Array => Int32Array.from(a as any, Number);
const f32 = (a: any): Float32Array => Float32Array.from(a as any, Number);
const asStrings = (v: any): string[] => v == null ? [] : Array.from(v as any, (x: any) =>
  typeof x === "string" ? x : x instanceof Uint8Array ? new TextDecoder().decode(x).replace(/\0+$/, "") : String(x));

const keySet = (g: any): Set<string> => { try { return new Set(g.keys()); } catch { return new Set(); } };

/** Is this open HDF5 file a 10x feature-barcode matrix (vs. an AnnData .h5ad saved as .h5)? Returns the base
 *  group name ("matrix" for CR3, the genome group for CR2) or null. */
export function tenxBase(f: any): string | null {
  try {
    const m = f.get("matrix");
    if (m && typeof m.keys === "function" && keySet(m).has("data")) return "matrix";   // CR3+
    for (const k of f.keys()) {                                                        // CR2: a <genome> group
      const g = f.get(k); if (g && typeof g.keys === "function") { const kk = keySet(g);
        if (kk.has("data") && kk.has("barcodes") && (kk.has("genes") || kk.has("gene_names"))) return k; }
    }
  } catch { /* */ }
  return null;
}

export async function openTenxH5(file: File, progress?: OpenProgress, force = false): Promise<LstarStore> {
  progress?.stage("Loading HDF5 reader…");
  const h5: any = await import("h5wasm"); await h5.ready;
  const name = "/" + (file.name || "matrix.h5");
  progress?.stage("Reading file…");
  h5.FS.writeFile(name, new Uint8Array(await file.arrayBuffer()));
  let f: any;
  try {
    f = new h5.File(name, "r");
    const base = tenxBase(f);
    if (!base) {   // not a 10x matrix — probably an AnnData .h5ad saved with a .h5 extension; hand off
      try { f.close(); } catch { /* */ } try { h5.FS.unlink(name); } catch { /* */ } f = null;
      const { openH5ad } = await import("./h5ad.ts");
      return openH5ad(file, progress, force);
    }
    progress?.stage("Parsing 10x matrix…");
    const g = f.get(base);
    const shape = Array.from(g.get("shape").value, num) as number[];   // [ngenes, ncells]
    const ngenes = num(shape[0]), ncells = num(shape[1]);
    const barcodes = asStrings(g.get("barcodes").value);
    const symNode = base === "matrix" ? (g.get("features/name") || g.get("features/id"))
                                      : (g.get("gene_names") || g.get("genes"));
    const genes = symNode ? asStrings(symNode.value) : [];
    // cell-major (indptr over cells, indices = genes) → gene-major CSC (indptr over genes, indices = cells)
    const M = await createLstarKernels();
    const r = M.cscToCsr(f32(g.get("data").value), i32(g.get("indices").value), i32(g.get("indptr").value), ngenes, ncells);
    const csc = { data: f32(r.data), indices: i32(r.indices), indptr: i32(r.indptr) };
    assertSparseOk(csc, ncells, ngenes);
    const axes: Record<string, AxisSpec> = {
      cells: { labels: barcodes.length === ncells ? barcodes : Array.from({ length: ncells }, (_, i) => "cell" + i), role: "observation" },
      genes: { labels: genes.length === ngenes ? genes : Array.from({ length: ngenes }, (_, i) => "gene" + i), role: "feature" },
    };
    const fields: Record<string, FieldSpec> = {
      counts: { role: "measure", span: ["cells", "genes"], encoding: "csc", state: "raw", shape: [ncells, ngenes], data: csc.data, indices: csc.indices, indptr: csc.indptr } as any,
    };
    const spec: DatasetSpec = { kind: "sample", axes, fields, profiles: [] };
    try { f.close(); } catch { /* */ } try { h5.FS.unlink(name); } catch { /* */ } f = null;   // free the WASM heap before the compute
    return await finalizeSpec(spec, progress, { force });
  } finally {
    try { f?.close?.(); h5.FS.unlink(name); } catch { /* */ }
  }
}
