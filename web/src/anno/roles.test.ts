import { test } from "node:test";
import assert from "node:assert/strict";
import { prefilterRole, candidateFields, looksLikeBatch, looksLikeClusterField, partitionFromNumeric, trackFamily, pickDefaultSources } from "./roles.ts";

const N = 35000, S = 6;

test("prefilter: numeric → qc, id-like → covariate, constant → covariate", () => {
  assert.equal(prefilterRole({ name: "pct_mito", kind: "numeric", cardinality: 0 }, N, S), "qc");
  assert.equal(prefilterRole({ name: "barcode", kind: "categorical", cardinality: N }, N, S), "covariate");
  assert.equal(prefilterRole({ name: "all_one", kind: "categorical", cardinality: 1 }, N, S), "covariate");
});

test("prefilter: mid-cardinality categoricals are candidates (agent decides by value)", () => {
  // cell_type (~20), leiden (~28), sample (6), condition (2) all survive as candidates — shape can't tell
  // a 6-value covariate from a 6-value coarse annotation, so the agent reads the values.
  for (const c of [2, 6, 20, 28]) assert.equal(prefilterRole({ name: "x", kind: "categorical", cardinality: c }, N, S), "candidate");
});

test("candidateFields returns only the unsettled categoricals", () => {
  const fields = [
    { name: "pct_mito", kind: "numeric" as const, cardinality: 0 },
    { name: "barcode", kind: "categorical" as const, cardinality: N },
    { name: "cell_type", kind: "categorical" as const, cardinality: 22 },
    { name: "leiden", kind: "categorical" as const, cardinality: 28 },
    { name: "condition", kind: "categorical" as const, cardinality: 2 },
  ];
  assert.deepEqual(candidateFields(fields, N, S), ["cell_type", "leiden", "condition"]);
});

// ---- annotation-source detection ----------------------------------------------------------------
// The fixture throughout is the real shape that motivated this: an Azimuth hierarchy (l1/l2/l3) + a
// CellTypist pair (voted/raw) + batch columns + a numeric `integrated_clusters`.

test("looksLikeBatch: design/batch columns are never cell-type sources", () => {
  for (const nm of ["sample", "orig.ident", "batch", "donor_id", "condition", "Sex", "timepoint", "tissue"])
    assert.equal(looksLikeBatch(nm), true, nm);
  for (const nm of ["predicted.celltype.l1", "celltypist", "cell_type", "scType", "annotation"])
    assert.equal(looksLikeBatch(nm), false, nm);
});

test("looksLikeBatch: a differently-named column whose VALUES are the sample ids is batch", () => {
  const samples = ["GSM5746259", "GSM5746260"];
  assert.equal(looksLikeBatch("library_x", ["GSM5746259", "GSM5746260"], samples), true);
  assert.equal(looksLikeBatch("library_x", ["GSM5746259"], samples), true, "subset of the sample ids still batch");
  assert.equal(looksLikeBatch("celltypist", ["B cells", "DC2"], samples), false);
});

test("looksLikeClusterField: names that mean 'unsupervised partition'", () => {
  for (const nm of ["leiden", "louvain", "integrated_clusters", "seurat_clusters", "SCT_snn_res.0.8", "clusters"])
    assert.equal(looksLikeClusterField(nm), true, nm);
  for (const nm of ["predicted.celltype.l1", "celltypist", "sample", "nCount_RNA"])
    assert.equal(looksLikeClusterField(nm), false, nm);
});

test("partitionFromNumeric: integer cluster ids → codes+categories; real measures rejected", () => {
  const p = partitionFromNumeric(Float32Array.from([3, 0, 3, 1, 0]));
  assert.deepEqual(p?.categories, ["0", "1", "3"], "levels sorted numerically");
  assert.deepEqual([...p!.codes], [2, 0, 2, 1, 0]);
  assert.equal(partitionFromNumeric(Float32Array.from([0.1, 2.5, 3.7])), null, "non-integral → a measure, not a partition");
  assert.equal(partitionFromNumeric(Float32Array.from([7, 7, 7])), null, "constant carries no partition");
  const many = Float32Array.from({ length: 500 }, (_, i) => i);
  assert.equal(partitionFromNumeric(many, 200), null, "too many levels to be a clustering");
});

test("trackFamily: hierarchy levels and raw variants collapse to their method", () => {
  assert.deepEqual(trackFamily("predicted.celltype.l1"), { family: "predicted.celltype", level: 1, raw: false });
  assert.deepEqual(trackFamily("predicted.celltype.l3"), { family: "predicted.celltype", level: 3, raw: false });
  assert.deepEqual(trackFamily("celltypist_raw"), { family: "celltypist", level: 0, raw: true });
  assert.deepEqual(trackFamily("celltypist"), { family: "celltypist", level: 0, raw: false });
  assert.deepEqual(trackFamily("scType"), { family: "scType", level: 0, raw: false }, "a bare name is its own family");
});

test("pickDefaultSources: one track per method, at the granularity closest to the base", () => {
  // the real store: base `integrated_clusters` has 27 clusters
  const tracks = [
    { name: "predicted.celltype.l1", cardinality: 8 },
    { name: "predicted.celltype.l2", cardinality: 29 },
    { name: "predicted.celltype.l3", cardinality: 49 },
    { name: "celltypist", cardinality: 14 },
    { name: "celltypist_raw", cardinality: 47 },
  ];
  // l2 (29) is nearest 27; celltypist (voted) beats celltypist_raw. 5 tracks → 2 opinions.
  assert.deepEqual(pickDefaultSources(tracks, 27), ["predicted.celltype.l2", "celltypist"]);
});

test("pickDefaultSources: a coarse base pulls the defaults coarser (granularity follows the base)", () => {
  const tracks = [
    { name: "predicted.celltype.l1", cardinality: 8 },
    { name: "predicted.celltype.l2", cardinality: 29 },
    { name: "celltypist", cardinality: 14 },
  ];
  assert.deepEqual(pickDefaultSources(tracks, 7), ["predicted.celltype.l1", "celltypist"]);
});

test("pickDefaultSources: independent methods are all kept (nothing is dropped as redundant)", () => {
  const tracks = [
    { name: "celltypist", cardinality: 14 },
    { name: "scType", cardinality: 12 },
    { name: "cell_type", cardinality: 20 },
  ];
  assert.deepEqual(pickDefaultSources(tracks, 27), ["celltypist", "scType", "cell_type"]);
});
