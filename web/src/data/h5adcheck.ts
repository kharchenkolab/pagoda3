// Small dependency-free sanity checks for the .h5ad intake — kept out of h5ad.ts so they unit-test without
// the HDF5/store stack. Catch genuinely CORRUPT files (truncated / mis-sized sparse) with a clear error, and
// flag DEGENERATE-but-valid ones (no gene/cell names, structureless layout) so the viewer explains itself
// instead of silently showing an index-named blob.

/** True when labels are a plain integer sequence "0","1",…,N-1 — i.e. the file carries NO real names
 *  (barcodes / gene symbols), just positional indices. Sampled, so it's O(1) on huge axes. */
export function looksUnnamed(labels: ArrayLike<string>): boolean {
  const n = labels.length;
  if (n < 3) return false;
  const K = Math.min(n, 40);
  for (let s = 0; s < K; s++) { const i = Math.floor((s * (n - 1)) / (K - 1)); if (labels[i] !== String(i)) return false; }
  return true;
}

/** Validate a CSC {data,indices,indptr} over nrows × ncols (columns = the indptr axis). Throws a clear,
 *  user-facing message on the kinds of inconsistency a truncated / corrupt download produces. Cheap: full
 *  scan of the small indptr, sampled scan of data/indices. */
export function assertSparseOk(
  csc: { data: ArrayLike<number>; indices: ArrayLike<number>; indptr: ArrayLike<number> },
  nrows: number, ncols: number, what = "count matrix"): void {
  const { data, indices, indptr } = csc;
  const bad = (why: string) => { throw new Error(`This .h5ad's ${what} looks corrupt or truncated (${why}). Re-download or re-export it.`); };
  if (indptr.length !== ncols + 1) bad(`indptr length ${indptr.length} ≠ ${ncols + 1}`);
  if (data.length !== indices.length) bad(`data length ${data.length} ≠ indices length ${indices.length}`);
  if (Number(indptr[0]) !== 0) bad(`indptr[0] = ${Number(indptr[0])} ≠ 0`);
  if (Number(indptr[ncols]) !== data.length) bad(`indptr end ${Number(indptr[ncols])} ≠ nnz ${data.length}`);
  let prev = 0;
  for (let g = 1; g <= ncols; g++) { const p = Number(indptr[g]); if (p < prev) bad(`indptr not non-decreasing at ${g}`); prev = p; }
  const nnz = data.length;
  if (nnz) {
    const K = Math.min(nnz, 4096);
    for (let s = 0; s < K; s++) {
      const k = Math.floor((s * (nnz - 1)) / (K - 1));
      const r = Number(indices[k]);
      if (!(r >= 0 && r < nrows)) bad(`row index ${r} out of range [0,${nrows})`);
      if (!Number.isFinite(Number(data[k]))) bad(`non-finite value`);
    }
  }
}
