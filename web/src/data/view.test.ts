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
// 4 cells x 3 genes (A,B,C). Gene B is expressed in cells 1 and 3, so a CORRECT gene-B column is
// rows [1,3] — the number both paths below must produce.
const CELLMAJOR = {                                   // CSR over (cells, genes)
  data: Float32Array.from([5, 7, 2, 9, 4]),
  indices: Int32Array.from([0, 1, 2, 1, 0]),          // c0:{A=5,B=7} c1:{C=2} c2:{B=9} c3:{A=4}
  indptr: Int32Array.from([0, 2, 3, 4, 5]),
};
const stubDs = (encoding: string, onColumn?: (name: string, col: number) => void, basisName = "counts", cellmajor = false): any => ({
  fieldNames: () => [basisName],
  field: (n: string) => (n === basisName
    ? { encoding, span: ["cells", "genes"], shape: [4, 3], provenance: basisName === "counts" ? undefined : { viewer: "basis" } }
    : n === "counts_cellmajor" ? { encoding: "csr", span: ["cells", "genes"], shape: [4, 3], state: "raw" } : undefined),
  axisLength: (a: string) => (a === "cells" ? 4 : 3),
  axisLabels: async (a: string) => (a === "genes" ? ["A", "B", "C"] : ["c0", "c1", "c2", "c3"]),
  hasField: (n: string) => cellmajor && n === "counts_cellmajor",
  fieldSparse: async () => ({ ...CELLMAJOR, shape: [4, 3], fmt: "csr" }),
  cscColumn: async (name: string, col: number) => { onColumn?.(name, col); return { rows: new Int32Array([0]), vals: new Float64Array([1]) }; },
});

// A degraded store must keep WORKING, not just stop being wrong: the gene column is derivable from the
// cell-major copy, so derive it. (The banner tells the user to re-prep; the viewer doesn't go dark.)
test("geneExpression: derives the gene column from the cell-major copy when the basis is cell-major", async () => {
  let called = false;
  const v = new LstarView(stubDs("csr", () => { called = true; }, "counts", true));
  const out = await v.geneExpression("B");
  assert.equal(called, false, "must not read the cell-major basis as if it were gene-major");
  // gene B: cell1 -> 7, cell3 -> 9 (log1p), everything else 0
  assert.deepEqual([...out.values].map((x) => +x.toFixed(4)),
    [Math.log1p(7), 0, Math.log1p(9), 0].map((x) => +x.toFixed(4)));
  assert.equal(out.col, 1);
});

test("geneExpression: refuses only when there is NO readable counts at all", async () => {
  let called = false;
  const v = new LstarView(stubDs("csr", () => { called = true; }));   // cell-major basis AND no cell-major copy
  await assert.rejects(() => v.geneExpression("B"), /no cell-major copy to fall back to/, "must name the defect, not read garbage");
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

test("groupStatsForGenesInSubset: falls back to the cell-major copy too", async () => {
  const v = new LstarView(stubDs("csr", undefined, "counts", true));
  const gs = await v.groupStatsForGenesInSubset(Int32Array.from([0, 0, 1, 1]), 2, [1], [0, 1, 2, 3]);
  // gene B (col 1) in group 0 = cells {0,1}: only cell1 expresses it (7); group 1 = cells {2,3}: cell2 (9)
  assert.equal(+gs.mean[0 * 3 + 1].toFixed(4), +(Math.log1p(7) / 2).toFixed(4));
  assert.equal(+gs.mean[1 * 3 + 1].toFixed(4), +(Math.log1p(9) / 2).toFixed(4));
  assert.deepEqual([...gs.frac.slice(1, 2)], [0.5]);
});

test("groupStatsForGenesInSubset: refuses only when there is no readable counts at all", async () => {
  const v = new LstarView(stubDs("csr"));
  await assert.rejects(() => v.groupStatsForGenesInSubset(Int32Array.from([0, 0, 1, 1]), 2, [0, 1], [0, 1, 2, 3]),
    /no cell-major copy to fall back to/);
});

// The basis is not always named `counts`: a store with no raw measure is prepped from e.g. `logcounts`, and
// `extend_for_viewer` marks the chosen field with provenance.viewer="basis". Resolving by name alone would
// report "no gene-major counts" on a perfectly good store.
test("countsBasis: finds a stamped basis that is NOT named counts", async () => {
  const seen: [string, number][] = [];
  const v = new LstarView(stubDs("csc", (n, c) => seen.push([n, c]), "logcounts"));
  assert.deepEqual(v.countsBasis(), { name: "logcounts", encoding: "csc", geneMajor: true });
  await v.geneExpression("B");
  assert.deepEqual(seen, [["logcounts", 1]], "reads the stamped basis, not a field named counts");
});

test("countsBasis: reports the encoding of a stale (cell-major) basis, and names it in the error", async () => {
  const v = new LstarView(stubDs("csr", undefined, "logcounts"));
  assert.deepEqual(v.countsBasis(), { name: "logcounts", encoding: "csr", geneMajor: false });
  await assert.rejects(() => v.geneExpression("B"), /`logcounts` is csr/);
});

test("warmColumns: a prefetch stays silent on a cell-major counts (no wrong-bytes warm, no throw)", () => {
  let called = false;
  const v = new LstarView(stubDs("csr", () => { called = true; }));
  assert.doesNotThrow(() => v.warmColumns([0, 1]));
  assert.equal(called, false);
});

// --- coarsening by summation ------------------------------------------------------------------------
// Sufficient stats are additive over cells, so a grouping that is a COARSENING of an already-summarized
// one is derivable by summing rows — zero matrix reads. That is the shape of every category the viewer
// makes at runtime (scType, a Reconcile draft, a merged clustering: all assigned PER CLUSTER), which
// prep-time precompute can never cover because they don't exist until the user makes them.
//
// 6 cells x 2 genes. Base `clust` = 3 clusters {0,1},{2,3},{4,5}. Its stats are the ground truth here;
// the derived grouping must equal the sum of the rows it absorbs, and must be REFUSED when it isn't
// actually a coarsening.
const NG = 2;
const BASE_STATS = {                                   // 3 groups x 2 genes, row-major
  sum:   Float64Array.from([1, 2, /**/ 3, 4, /**/ 5, 6]),
  sumsq: Float64Array.from([1, 4, /**/ 9, 16, /**/ 25, 36]),
  nexpr: Float64Array.from([2, 1, /**/ 2, 2, /**/ 1, 2]),
};
const coarsenDs = (targetCodes: number[], targetCats: string[], baseCodes = [0, 0, 1, 1, 2, 2]): any => ({
  fieldNames: () => ["counts", "stats_clust_sum", "stats_clust_sumsq", "stats_clust_nexpr"],
  axisNames: () => ["cells", "genes", "groups_clust"],
  hasField: (n: string) => ["stats_clust_sum", "stats_clust_sumsq", "stats_clust_nexpr", "counts_cellmajor"].includes(n),
  field: (n: string) => (n === "counts" ? { encoding: "csc", span: ["cells", "genes"], shape: [6, NG] }
    : n === "counts_cellmajor" ? { encoding: "csr", span: ["cells", "genes"], state: "raw", shape: [6, NG] } : undefined),
  axisLength: (a: string) => (a === "cells" ? 6 : NG),
  axisLabels: async (a: string) => (a === "groups_clust" ? ["c0", "c1", "c2"]
    : a === "genes" ? ["A", "B"] : ["x0", "x1", "x2", "x3", "x4", "x5"]),
  fieldDense: async (n: string) => ({ data: n.endsWith("_sum") ? BASE_STATS.sum : n.endsWith("_sumsq") ? BASE_STATS.sumsq : BASE_STATS.nexpr }),
  fieldCategorical: async () => ({ codes: Int32Array.from(baseCodes), categories: ["c0", "c1", "c2"] }),
  csrRows: () => { throw new Error("must not read the counts matrix"); },
  __target: { codes: Int32Array.from(targetCodes), categories: targetCats },
  __base: { codes: Int32Array.from(baseCodes), categories: ["c0", "c1", "c2"] },
});

// view.metadata() is the seam both the base and the target go through; stub it per grouping.
function viewFor(ds: any) {
  const v: any = new LstarView(ds);
  v.metadata = async (name: string) => ({ kind: "categorical", ...(name === "clust" ? ds.__base : ds.__target) });
  return v;
}

test("coarsening: a per-cluster label sums the base rows, reading no counts", async () => {
  // {c0,c1} -> "T", {c2} -> "B": a Reconcile/scType-shaped assignment
  const v = viewFor(coarsenDs([0, 0, 0, 0, 1, 1], ["T", "B"]));
  const gs = await v.groupStats("merged");
  assert.deepEqual([...gs.groups], ["T", "B"]);
  // T = clust rows 0+1, B = clust row 2 — exactly, not approximately
  assert.deepEqual([...gs.mean].map((x: number) => +x.toFixed(6)),
    [(1 + 3) / 4, (2 + 4) / 4, 5 / 2, 6 / 2].map((x) => +x.toFixed(6)));
  assert.deepEqual([...gs.frac], [(2 + 2) / 4, (1 + 2) / 4, 1 / 2, 2 / 2]);
});

test("coarsening: refused when a base group is SPLIT across groups", async () => {
  // cell 2 and cell 3 are both in base c1 but land in different target groups → not a coarsening
  const v = viewFor(coarsenDs([0, 0, 0, 1, 1, 1], ["X", "Y"]));
  await assert.rejects(() => v.groupStats("split"), /must not read the counts matrix/,
    "must fall through to reading counts rather than silently summing a wrong partition");
});

test("coarsening: refused when the grouping labels cells the base does not", async () => {
  // base leaves cells 4,5 unlabelled (-1) but the grouping assigns them: summing would undercount
  const v = viewFor(coarsenDs([0, 0, 1, 1, 1, 1], ["P", "Q"], [0, 0, 1, 1, -1, -1]));
  await assert.rejects(() => v.groupStats("uncovered"), /must not read the counts matrix/);
});

test("coarsening: a base group left unlabelled here is dropped, not miscounted", async () => {
  // base c2 maps to -1 (unassigned): its rows must contribute to nothing
  const v = viewFor(coarsenDs([0, 0, 1, 1, -1, -1], ["P", "Q"]));
  const gs = await v.groupStats("partial");
  assert.deepEqual([...gs.mean].map((x: number) => +x.toFixed(6)),
    [1 / 2, 2 / 2, 3 / 2, 4 / 2].map((x) => +x.toFixed(6)), "row 2 excluded");
});

test("coarsening: stats rows are aligned by LABEL, not by position", async () => {
  // groups_clust axis order reversed vs the categorical's order — a positional join would scramble it
  const ds = coarsenDs([0, 0, 0, 0, 1, 1], ["T", "B"]);
  ds.axisLabels = async (a: string) => (a === "groups_clust" ? ["c2", "c1", "c0"]
    : a === "genes" ? ["A", "B"] : ["x0", "x1", "x2", "x3", "x4", "x5"]);
  ds.fieldDense = async (n: string) => ({                       // rows reordered to match the axis
    data: n.endsWith("_sum") ? Float64Array.from([5, 6, 3, 4, 1, 2])
      : n.endsWith("_sumsq") ? Float64Array.from([25, 36, 9, 16, 1, 4])
      : Float64Array.from([1, 2, 2, 2, 2, 1]),
  });
  const gs = await viewFor(ds).groupStats("merged");
  assert.deepEqual([...gs.mean].map((x: number) => +x.toFixed(6)),
    [(1 + 3) / 4, (2 + 4) / 4, 5 / 2, 6 / 2].map((x) => +x.toFixed(6)));
});

// --- global gene stats: coverage, not field order ----------------------------------------------------
// globalGeneStats sums every row of ONE summarized grouping to get per-gene totals over all cells, and
// the a-vs-rest DE divides by `N - nA`. Summing any FULL partition gives identical totals, so the choice
// of grouping is harmless — until one doesn't cover every cell, when the totals are short AND `N` is
// overstated, making every rest-mean too small and every lfc too large, with no error.
const NG3 = 2;
const globalDs = (order: string[], cov: Record<string, number[]>, rows: Record<string, number[]>): any => ({
  fieldNames: () => order.flatMap((g) => [`stats_${g}_sum`, `stats_${g}_sumsq`, `stats_${g}_nexpr`]),
  hasField: (n: string) => order.some((g) => n === `stats_${g}_sumsq` || n === `stats_${g}_nexpr`),
  axisNames: () => order.map((g) => `groups_${g}`),
  field: () => undefined,
  axisLength: (a: string) => (a === "cells" ? 4 : NG3),
  axisLabels: async (a: string) => (a === "genes" ? ["A", "B"] : ["c0", "c1", "c2", "c3"]),
  fieldDense: async (n: string) => {
    const g = /^stats_(.+)_(sum|sumsq|nexpr)$/.exec(n)![1];
    return { data: Float64Array.from(rows[g]) };
  },
  __cov: cov,
});
function globalView(ds: any) {
  const v: any = new LstarView(ds);
  v.metadata = async (g: string) => ({ kind: "categorical", codes: Int32Array.from(ds.__cov[g]), categories: ["p", "q"] });
  return v;
}

test("globalGeneStats: prefers a grouping that covers every cell over an earlier partial one", async () => {
  // `partial` comes first in field order but leaves 2 of 4 cells unlabelled; `full` covers all 4.
  const ds = globalDs(["partial", "full"],
    { partial: [0, 1, -1, -1], full: [0, 0, 1, 1] },
    { partial: [1, 1, 2, 2], full: [10, 20, 30, 40] });     // 2 groups x 2 genes each
  const gs = await (globalView(ds) as any).globalGeneStats();
  assert.equal(gs.N, 4, "N is the covered cell count");
  assert.deepEqual([...gs.sumLog], [40, 60], "totals come from the full-coverage grouping");
});

test("globalGeneStats: with only a partial grouping, N is the covered count, not nCells", async () => {
  const ds = globalDs(["partial"], { partial: [0, 1, -1, -1] }, { partial: [1, 1, 2, 2] });
  const gs = await (globalView(ds) as any).globalGeneStats();
  assert.equal(gs.N, 2, "must not claim all 4 cells — the rows only cover 2");
  assert.deepEqual([...gs.sumLog], [3, 3]);
});

test("globalGeneStats: null when nothing is summarized", async () => {
  assert.equal(await (globalView(globalDs([], {}, {})) as any).globalGeneStats(), null);
});

// --- tier 2 / tier 3: read it when that's affordable, sample when it isn't --------------------------
// 8 cells x 2 genes, cell-major. Group 0 = cells 0..3, group 1 = cells 4..7. Every cell expresses both
// genes with value = cell index + 1, so exact answers are hand-checkable.
const CM8 = {
  data: Float32Array.from(Array.from({ length: 8 }, (_, c) => [c + 1, c + 1]).flat()),
  indices: Int32Array.from(Array.from({ length: 8 }, () => [0, 1]).flat()),
  indptr: Int32Array.from(Array.from({ length: 9 }, (_, i) => 2 * i)),
};
const tierDs = (opts: { order?: Int32Array | null; onRead?: (cells: number[]) => void } = {}): any => {
  const rowsFor = (cells: number[]) => {
    const data: number[] = [], indices: number[] = [], indptr = [0];
    for (const c of cells) { for (let k = CM8.indptr[c]; k < CM8.indptr[c + 1]; k++) { data.push(CM8.data[k]); indices.push(CM8.indices[k]); } indptr.push(data.length); }
    return { data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), rows: cells };
  };
  return {
    fieldNames: () => ["counts_cellmajor", ...(opts.order ? ["counts_cellmajor_order"] : [])],
    axisNames: () => ["cells", "genes"],
    hasField: (n: string) => n === "counts_cellmajor" || (!!opts.order && n === "counts_cellmajor_order"),
    field: (n: string) => (n === "counts_cellmajor" ? { encoding: "csr", span: ["cells", "genes"], state: "raw", shape: [8, 2] } : undefined),
    axisLength: (a: string) => (a === "cells" ? 8 : 2),
    axisLabels: async (a: string) => (a === "genes" ? ["A", "B"] : Array.from({ length: 8 }, (_, i) => `c${i}`)),
    fieldDense: async () => ({ data: opts.order ?? new Int32Array(0) }),
    csrRows: async (_n: string, cells: number[]) => { opts.onRead?.(cells); return rowsFor(cells); },
    sampleRows: async (_n: string, ids: number[], max: number) => ids.filter((_, i) => i % 2 === 0).slice(0, max),
  };
};
const tierView = (ds: any, codes: number[], cats: string[]) => {
  const v: any = new LstarView(ds);
  v.metadata = async () => ({ kind: "categorical", codes: Int32Array.from(codes), categories: cats });
  return v;
};

test("tier 2: a group that coalesces is READ — exact means, approx false", async () => {
  const seen: number[][] = [];
  const v = tierView(tierDs({ onRead: (c) => seen.push(c) }), [0, 0, 0, 0, 1, 1, 1, 1], ["a", "b"]);
  const gs = await v.groupStats("g");
  assert.equal(gs.approx, false);
  assert.deepEqual(seen[0], [0, 1, 2, 3, 4, 5, 6, 7], "reads every labelled cell, not a sample");
  // group a = log1p(1..4) / 4 exactly
  const meanA = [1, 2, 3, 4].reduce((s, x) => s + Math.log1p(x), 0) / 4;
  assert.equal(+gs.mean[0].toFixed(6), +meanA.toFixed(6));
  assert.deepEqual([...gs.frac.slice(0, 2)], [1, 1]);
});

test("tier 3: a scattered group is SAMPLED and says so", async () => {
  // maxRuns forced low so the plan takes the sampled branch on this tiny fixture
  const ds = tierDs();
  const v = tierView(ds, [0, 1, 0, 1, 0, 1, 0, 1], ["a", "b"]);
  v.statsSampleCells = 4;
  const gs = await v.groupStats("g");
  assert.equal(gs.approx, true, "estimated results must be labelled");
  assert.equal(gs.plan.mode, "sample");
});

// The trap this design has to avoid: S is summed over the cells actually read, so dividing by the FULL
// group size would scale every mean down by the sampling fraction — a quiet, plausible-looking error.
test("tier 3: the divisor is cells MEASURED, while n still reports the real group size", async () => {
  const ds = tierDs();
  const v = tierView(ds, [0, 0, 0, 0, 1, 1, 1, 1], ["a", "b"]);
  v.statsSampleCells = 4;                       // 8 labelled cells > budget -> sample; sampleRows takes evens
  const gs = await v.groupStats("g");
  assert.equal(gs.approx, true);
  assert.deepEqual([...gs.n], [4, 4], "n is the true group size, for display");
  assert.deepEqual([...gs.nUsed], [2, 2], "but only 2 of each group were read");
  // group a sampled cells are 0 and 2 -> values 1 and 3
  const meanA = (Math.log1p(1) + Math.log1p(3)) / 2;
  assert.equal(+gs.mean[0].toFixed(6), +meanA.toFixed(6), "mean divides by 2, not by 4");
});

test("tier 3: markers blank padj on a sampled table, keep it on an exact one", async () => {
  const exact = tierView(tierDs(), [0, 0, 0, 0, 1, 1, 1, 1], ["a", "b"]);
  const mExact = await exact.markers("g", 2);
  assert.ok([...mExact.get("a")!].every((r: any) => !Number.isNaN(r.padj)), "an exact table keeps its padj");

  const ds = tierDs();
  const sampled = tierView(ds, [0, 0, 0, 0, 1, 1, 1, 1], ["a", "b"]);
  sampled.statsSampleCells = 4;
  const mSampled = await sampled.markers("g", 2);
  assert.ok([...mSampled.get("a")!].every((r: any) => Number.isNaN(r.padj)),
    "a sampled significance value would read as biology, not as methodology — blank it");
  assert.ok([...mSampled.get("a")!].every((r: any) => Number.isFinite(r.lfc)), "lfc still reported: it converges");
});

test("tier selection uses PHYSICAL rows: the permutation can make a scattered group compact", async () => {
  // cells 0,2,4,6 are stride-2 by id, but adjacent once permuted -> one run -> read, not sample
  const order = Int32Array.from([0, 4, 1, 5, 2, 6, 3, 7]);
  const seen: number[][] = [];
  const v = tierView(tierDs({ order, onRead: (c) => seen.push(c) }), [0, 1, 0, 1, 0, 1, 0, 1], ["a", "b"]);
  const gs = await v.groupStats("g");
  assert.equal(gs.approx, false, "compact once permuted — no need to estimate");
  assert.equal(seen[0].length, 8);
});
