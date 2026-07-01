import { test } from "node:test";
import assert from "node:assert/strict";
import { looksUnnamed, assertSparseOk } from "./h5adcheck.ts";

test("looksUnnamed detects a plain integer index (no real names)", () => {
  assert.equal(looksUnnamed(["0", "1", "2", "3", "4"]), true);              // synthetic / nameless
  assert.equal(looksUnnamed(Array.from({ length: 32738 }, (_, i) => String(i))), true);
  assert.equal(looksUnnamed(["TNFRSF4", "CPSF3L", "ATAD3C"]), false);        // real symbols
  assert.equal(looksUnnamed(["AAACATACAACCAC-1", "AAACATTGAGCTAC-1", "x"]), false);
  assert.equal(looksUnnamed(["0", "1", "x", "3"]), false);                   // breaks the sequence
  assert.equal(looksUnnamed(["1", "2", "3"]), false);                        // doesn't start at 0
});

// a valid 3-cell × 2-gene gene-major CSC (columns = genes; indptr over genes; indices = cells)
const okCsc = () => ({ data: Float32Array.from([1, 2, 3, 4]), indices: Int32Array.from([0, 2, 1, 2]), indptr: Int32Array.from([0, 2, 4]) });

test("assertSparseOk passes a consistent matrix", () => {
  assert.doesNotThrow(() => assertSparseOk(okCsc(), 3, 2));
});

test("assertSparseOk throws on the shapes a truncated/corrupt file produces", () => {
  const bad = (m: any, n = 3, g = 2) => assert.throws(() => assertSparseOk(m, n, g), /corrupt or truncated/);
  bad({ ...okCsc(), indptr: Int32Array.from([0, 2]) });                                  // indptr length ≠ ncols+1
  bad({ ...okCsc(), indices: Int32Array.from([0, 2, 1]) });                              // data/indices length mismatch
  bad({ ...okCsc(), indptr: Int32Array.from([0, 2, 9]) });                               // indptr end ≠ nnz
  bad({ data: Float32Array.from([1, 2, 3, 4]), indices: Int32Array.from([0, 9, 1, 2]), indptr: Int32Array.from([0, 2, 4]) }); // row index out of range
  bad({ data: Float32Array.from([1, NaN, 3, 4]), indices: Int32Array.from([0, 2, 1, 2]), indptr: Int32Array.from([0, 2, 4]) }); // non-finite
  bad({ ...okCsc(), indptr: Int32Array.from([0, 3, 2]) });                               // non-decreasing violated (and end≠nnz)
});
