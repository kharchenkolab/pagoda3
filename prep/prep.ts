// pagoda3 prep — the JS/WASM `write_viewer`: read an L* store, compute the viewer navigators with the
// SHARED libstar WASM kernels (the same C++ core the R/Python packages bind to and the browser runs
// live), and append them with lstar-js's addToStore. So a prepped store == a bare store computed live,
// and == an R/Python-prepped store. No R or Python needed.
//
//   node --experimental-strip-types prep/prep.ts <store.lstar.zarr> [grouping=leiden] [also...]
//
// Computes (all optional to a plain reader, per the viewer@0.1 profile in lstar docs/format.md):
//   counts_cellmajor      cell-major CSR, PHYSICALLY reordered cluster-contiguous (raw)
//   counts_cellmajor_order cell -> physical row permutation (the reader's `<field>_order` sibling)
//   stats_<g>_{sum,sumsq,nexpr}  per-(group,gene) sufficient stats, group-major K×ng
//   markers_<g>_{lfc,padj}       1-vs-rest marker table, gene-major ng×K
//   od_score              per-gene overdispersion (pagoda2 lowess + F-test)
// Recomputes & overwrites — addToStore updates the manifest idempotently.
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
  const CACHE = { cache: "viewer@0.1" };   // all prep outputs are regenerable caches (see lstar docs/format.md)

  // cell-major (CSR) copy of counts (natural cell order for now; physically reordered below).
  const csr = M.cscToCsr(data, indices, indptr, ncells, ngenes);
  const cmIndptr = Int32Array.from(csr.indptr);
  const cmIndices = Int32Array.from(csr.indices);
  const cmData = Int32Array.from(csr.data);

  // whole-dataset od_score: one group over all cells -> per-gene mean/var(log1p)/nobs -> shared kernel.
  const gAll = M.colSumByGroup(data, indptr, indices, ncells, ngenes, new Int32Array(ncells), 1, true);
  const mean = new Float64Array(ngenes), varr = new Float64Array(ngenes), nobs = new Int32Array(ngenes);
  for (let g = 0; g < ngenes; g++) {
    const m = (gAll.sum as Float64Array)[g] / ncells;
    mean[g] = m; varr[g] = Math.max((gAll.sumsq as Float64Array)[g] / ncells - m * m, 0);
    nobs[g] = (gAll.n_expr as Float64Array)[g];
  }
  fields["od_score"] = { role: "measure", span: ["genes"], encoding: "dense", shape: [ngenes],
                         data: Float32Array.from(M.overdispersion(mean, varr, nobs)), provenance: CACHE };

  // per-annotation cluster stats (group-major) + 1-vs-rest markers (gene-major); cell_order from primary.
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
    const nper = new Int32Array(K); for (const c of code) nper[c]++;
    const mk = M.markersOneVsRest(S, NE, nper, K, ngenes, ncells);   // {lfc,padj} gene-major ng×K
    axes["groups_" + gp] = { labels: groups, origin: "derived", role: "feature" };
    const sg = ["groups_" + gp, "genes"];                           // stats: group-major
    fields["stats_" + gp + "_sum"]   = { role: "measure", span: sg, encoding: "dense", shape: [K, ngenes], data: Float32Array.from(S), provenance: CACHE };
    fields["stats_" + gp + "_sumsq"] = { role: "measure", span: sg, encoding: "dense", shape: [K, ngenes], data: Float32Array.from(SS), provenance: CACHE };
    fields["stats_" + gp + "_nexpr"] = { role: "measure", span: sg, encoding: "dense", shape: [K, ngenes], data: Float32Array.from(NE), provenance: CACHE };
    const mg = ["genes", "groups_" + gp];                           // markers: gene-major
    fields["markers_" + gp + "_lfc"]  = { role: "measure", span: mg, encoding: "dense", shape: [ngenes, K], data: Float32Array.from(mk.lfc), provenance: CACHE };
    fields["markers_" + gp + "_padj"] = { role: "measure", span: mg, encoding: "dense", shape: [ngenes, K], data: Float32Array.from(mk.padj), provenance: CACHE };
  }

  // cluster-contiguous physical row order: perm[p] = cell at physical row p; pos_of[cell] = its row.
  // Reorder counts_cellmajor rows by perm and record pos_of as the reader's `counts_cellmajor_order`
  // sibling -- so a cluster/lasso selection coalesces into ~1 byte-range read (locality fast path).
  const perm = Array.from({ length: ncells }, (_, i) => i)
    .sort((a, b) => (primaryCode ? primaryCode[a] - primaryCode[b] : 0) || (a - b));
  const posOf = new Float64Array(ncells); for (let p = 0; p < ncells; p++) posOf[perm[p]] = p;
  const rIndptr = new Int32Array(ncells + 1);
  for (let p = 0; p < ncells; p++) rIndptr[p + 1] = rIndptr[p] + (cmIndptr[perm[p] + 1] - cmIndptr[perm[p]]);
  const nnz = rIndptr[ncells];
  const rData = new Int32Array(nnz), rInd = new Int32Array(nnz);
  for (let p = 0; p < ncells; p++) {
    const src = perm[p]; let dst = rIndptr[p];
    for (let k = cmIndptr[src]; k < cmIndptr[src + 1]; k++) { rData[dst] = cmData[k]; rInd[dst] = cmIndices[k]; dst++; }
  }
  fields["counts_cellmajor"] = { role: "measure", span: ["cells", "genes"], encoding: "csr", state: "raw",
                                 shape: [ncells, ngenes], data: rData, indices: rInd, indptr: rIndptr, provenance: CACHE };
  fields["counts_cellmajor_order"] = { role: "measure", span: ["cells"], encoding: "dense",
                                       state: "permutation", shape: [ncells], data: posOf, provenance: CACHE };

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
