// Dense-value conversion. An int64/uint64 obs column arrives as a BigInt64Array, and the plain
// `Float32Array.from(bigIntArray)` this used to do THROWS ("Cannot convert a BigInt value to a number") —
// so metadata()/embedding() rejected instead of rendering. Found on a real Seurat-derived store whose
// `integrated_clusters` is int64: the throw was swallowed upstream, leaving the clustering invisible and an
// annotation elected as the reconcile base. Run: `node --test src/data/view.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toF32, LstarView } from "./view.ts";

test("toF32: int64 cluster ids convert (the BigInt trap)", () => {
  const big = BigInt64Array.from([11n, 1n, 6n, 3n, 0n]);
  assert.throws(() => Float32Array.from(big as any), TypeError, "precondition: the naive conversion really does throw");
  const out = toF32(big);
  assert.ok(out instanceof Float32Array);
  assert.deepEqual([...out], [11, 1, 6, 3, 0]);
});

test("toF32: uint64 converts too", () => {
  assert.deepEqual([...toF32(BigUint64Array.from([0n, 42n]))], [0, 42]);
});

test("toF32: a Float32Array passes through untouched (no copy)", () => {
  const f = Float32Array.from([1.5, 2.5]);
  assert.equal(toF32(f), f, "same reference — conversion must not copy the common case");
});

test("toF32: ordinary numeric arrays still convert", () => {
  assert.deepEqual([...toF32(Int32Array.from([3, 4]))], [3, 4]);
  assert.deepEqual([...toF32(Float64Array.from([1.25, -2]))], [1.25, -2]);
  assert.deepEqual([...toF32([7, 8])], [7, 8]);
});

// --- gene-column reads require a GENE-MAJOR (CSC) counts -----------------------------------------
// `cscColumn`/`cscColumns` index a field's indptr by COLUMN, so pointing them at a CELL-major (CSR)
// counts returns cell ROWS dressed up as gene columns — silently, with plausible numbers. Measured on a
// real store whose `counts` is csr: cscColumn("counts",100) came back byte-identical to csrRow("counts",100),
// i.e. cell 100's profile served as gene "DNAJC11" (1454 entries, "cell" indices up to 18325 with only
// 13533 cells; the truth from that store's own stats_*_nexpr is 930 expressing cells). These tests pin the
// encoding check so the viewer refuses instead of colouring the embedding with the wrong vector.
const stubDs = (encoding: string, onColumn?: (name: string, col: number) => void): any => ({
  field: (n: string) => (n === "counts" ? { encoding, span: ["cells", "genes"], shape: [4, 3] } : undefined),
  axisLength: (a: string) => (a === "cells" ? 4 : 3),
  axisLabels: async (a: string) => (a === "genes" ? ["A", "B", "C"] : ["c0", "c1", "c2", "c3"]),
  hasField: () => false,
  cscColumn: async (name: string, col: number) => { onColumn?.(name, col); return { rows: new Int32Array([0]), vals: new Float64Array([1]) }; },
});

test("geneExpression: refuses a cell-major (CSR) counts instead of reading it as gene-major", async () => {
  let called = false;
  const v = new LstarView(stubDs("csr", () => { called = true; }));
  await assert.rejects(() => v.geneExpression("B"), /gene-major \(CSC\) counts/, "must name the defect, not read garbage");
  assert.equal(called, false, "and must not issue the column read at all");
});

test("geneExpression: a gene-major (CSC) counts reads normally", async () => {
  const seen: [string, number][] = [];
  const v = new LstarView(stubDs("csc", (n, c) => seen.push([n, c])));
  const out = await v.geneExpression("B");
  assert.deepEqual(seen, [["counts", 1]], "reads column 1 of the gene-major counts");
  assert.equal(out.col, 1);
  assert.equal(out.values.length, 4);
});

test("groupStatsForGenesInSubset: refuses a cell-major counts", async () => {
  const v = new LstarView(stubDs("csr"));
  await assert.rejects(() => v.groupStatsForGenesInSubset(Int32Array.from([0, 0, 1, 1]), 2, [0, 1], [0, 1, 2, 3]),
    /gene-major \(CSC\) counts/);
});

test("warmColumns: a prefetch stays silent on a cell-major counts (no wrong-bytes warm, no throw)", () => {
  let called = false;
  const v = new LstarView(stubDs("csr", () => { called = true; }));
  assert.doesNotThrow(() => v.warmColumns([0, 1]));
  assert.equal(called, false);
});
