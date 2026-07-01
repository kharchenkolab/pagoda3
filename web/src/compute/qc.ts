// Basic single-cell QC on a raw counts spec (used by the in-browser .h5ad intake before it computes a layout).
// Kept dependency-free (type-only import) so it unit-tests without the HDF5/store stack.
import type { DatasetSpec } from "../../../../lstar/js/core/writer.ts";

export interface QCReport { minGenes: number; minCells: number; droppedCells: number; droppedGenes: number; keptCells: number; keptGenes: number; skipped?: boolean; }

// Subset one non-counts field to a kept-row mask (utf8 values or a dense per-row array; preserves the per-row stride).
export function subsetField(fx: any, keep: Uint8Array, nKept: number): void {
  if (fx.encoding === "utf8" && Array.isArray(fx.values)) { fx.values = fx.values.filter((_: any, i: number) => keep[i]); return; }
  if (fx.encoding === "dense" && fx.data) {
    const stride = (Array.isArray(fx.shape) && fx.shape.length > 1) ? fx.shape[1] : 1;
    const out = new (fx.data.constructor as any)(nKept * stride); let j = 0;
    for (let i = 0; i < keep.length; i++) if (keep[i]) { for (let s = 0; s < stride; s++) out[j * stride + s] = fx.data[i * stride + s]; j++; }
    fx.data = out; fx.shape = stride > 1 ? [nKept, stride] : [nKept];
  }
}

// DROP cells with < minGenes detected genes and genes detected in < minCells cells, re-indexing the gene-major CSC
// counts + every cell/gene-spanning field + the axis labels. Records per-cell n_genes / n_counts QC covariates if the
// file didn't already carry them. Returns a report; {skipped:true} WITHOUT mutating if a threshold would leave < 2
// cells/genes (better to open the raw matrix than an empty one). Mutates `spec` in place.
export function applyQCFilter(spec: DatasetSpec, minGenes: number, minCells: number): QCReport | null {
  const cf: any = spec.fields.counts;
  if (!cf || cf.encoding !== "csc" || !cf.indptr) return null;
  const [ncells, ngenes] = cf.shape as [number, number];
  const data = cf.data, ind = cf.indices, ptr = cf.indptr;
  const geneCells = new Int32Array(ngenes), cellGenes = new Int32Array(ncells), cellCounts = new Float64Array(ncells);
  for (let g = 0; g < ngenes; g++) { let cnt = 0; const a = Number(ptr[g]), b = Number(ptr[g + 1]);
    for (let k = a; k < b; k++) { const v = Number(data[k]); if (v > 0) { cnt++; const c = Number(ind[k]); cellGenes[c]++; cellCounts[c] += v; } }
    geneCells[g] = cnt; }
  const geneKeep = new Uint8Array(ngenes); let ngKept = 0; for (let g = 0; g < ngenes; g++) if (geneCells[g] >= minCells) { geneKeep[g] = 1; ngKept++; }
  const cellKeep = new Uint8Array(ncells); let ncKept = 0; for (let c = 0; c < ncells; c++) if (cellGenes[c] >= minGenes) { cellKeep[c] = 1; ncKept++; }
  const droppedCells = ncells - ncKept, droppedGenes = ngenes - ngKept;
  if (ncKept < 2 || ngKept < 2) return { minGenes, minCells, droppedCells, droppedGenes, keptCells: ncKept, keptGenes: ngKept, skipped: true };
  if (!droppedCells && !droppedGenes) return { minGenes, minCells, droppedCells: 0, droppedGenes: 0, keptCells: ncKept, keptGenes: ngKept };
  const newCell = new Int32Array(ncells); { let j = 0; for (let c = 0; c < ncells; c++) newCell[c] = cellKeep[c] ? j++ : -1; }
  // rebuild the gene-major CSC over kept genes (columns) × kept cells (rows) — two passes for typed-array output
  let nnz = 0;
  for (let g = 0; g < ngenes; g++) { if (!geneKeep[g]) continue; const a = Number(ptr[g]), b = Number(ptr[g + 1]); for (let k = a; k < b; k++) { const v = Number(data[k]); if (v > 0 && cellKeep[Number(ind[k])]) nnz++; } }
  const nd = new Float32Array(nnz), ni = new Int32Array(nnz), np = new Int32Array(ngKept + 1);
  { let w = 0, col = 0; for (let g = 0; g < ngenes; g++) { if (!geneKeep[g]) continue; const a = Number(ptr[g]), b = Number(ptr[g + 1]); for (let k = a; k < b; k++) { const v = Number(data[k]); const c = Number(ind[k]); if (v > 0 && cellKeep[c]) { nd[w] = v; ni[w] = newCell[c]; w++; } } np[++col] = w; } }
  cf.data = nd; cf.indices = ni; cf.indptr = np; cf.shape = [ncKept, ngKept];
  for (const [name, fx] of Object.entries(spec.fields)) { if (name === "counts") continue; const span: string[] = (fx as any).span || [];
    if (span.length === 1 && span[0] === "cells") subsetField(fx, cellKeep, ncKept);
    else if (span.length === 1 && span[0] === "genes") subsetField(fx, geneKeep, ngKept); }
  if ((spec.axes.cells as any)?.labels) (spec.axes.cells as any).labels = (spec.axes.cells as any).labels.filter((_: any, i: number) => cellKeep[i]);
  if ((spec.axes.genes as any)?.labels) (spec.axes.genes as any).labels = (spec.axes.genes as any).labels.filter((_: any, i: number) => geneKeep[i]);
  const addNum = (nm: string, src: ArrayLike<number>) => { if (spec.fields[nm]) return; const out = new Float32Array(ncKept); let j = 0; for (let c = 0; c < ncells; c++) if (cellKeep[c]) out[j++] = src[c];
    spec.fields[nm] = { role: "measure", span: ["cells"], encoding: "dense", shape: [ncKept], data: out } as any; };
  addNum("n_genes", cellGenes); addNum("n_counts", cellCounts);
  return { minGenes, minCells, droppedCells, droppedGenes, keptCells: ncKept, keptGenes: ngKept };
}
