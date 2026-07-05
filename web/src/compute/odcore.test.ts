import { test } from "node:test";
import assert from "node:assert/strict";
import { sample, overdispersedReduce, overdispersedRank, overdispersed, deCore, groupStatsForCellsCore, meanVarCore, logFupperTail, pseudobulkDECore, pseudobulkPairedDECore, type ODPanel, type ODResult } from "./odcore.ts";
import { overdispersionFromStats as lsOverdispersion } from "../../../../lstar/js/core/compute.ts";   // the single-sourced scorer, for the composition check

// Build a cell-major CSR panel from a dense [cell][gene] matrix (stores only nonzeros, like the real panel).
function buildPanel(dense: number[][], lognorm = true): ODPanel {
  const data: number[] = [], indices: number[] = [], indptr: number[] = [0];
  const nGenes = dense[0].length;
  for (const row of dense) { for (let g = 0; g < nGenes; g++) if (row[g] !== 0) { data.push(row[g]); indices.push(g); } indptr.push(data.length); }
  return { data: Float64Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), nGenes, lognorm };
}

test("sample: deterministic stride (no Math.random) — worker + main pick the SAME cells", () => {
  assert.deepEqual(sample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5), [0, 2, 4, 6, 8]);   // stride = floor(10/5) = 2
  assert.deepEqual(sample([1, 2, 3], 5), [1, 2, 3]);                                // n <= k → all (as a fresh array)
  assert.deepEqual(sample([0, 1, 2, 3, 4, 5], 5), sample([0, 1, 2, 3, 4, 5], 5));   // repeatable
});

// The overdispersion path is now SPLIT: pagoda3 owns the cell-major subset REDUCE (overdispersedReduce) +
// the RANK/filter (overdispersedRank); the layout-independent scoring (pagoda2 LOWESS/F-test) is single-
// sourced in lstar's overdispersionFromStats, reached via overdispersed(). The two pure halves are unit-
// tested WASM-free here; the WASM-backed end-to-end is the convergence regression at the end.
const OD_COL = (lo: number, hi: number) => [lo, lo, lo, lo, lo, hi, hi, hi, hi, hi];
function odPanel(): ODPanel {
  // 10 cells × 5 genes (lognorm values direct). g0=LO and g1=HI share mean 1.5 but HI has 9× the variance.
  // g4=FLAT is constant (variance 0) → must be excluded. g2/g3 are filler so the LOWESS trend has points.
  const LO = OD_COL(1, 2), HI = OD_COL(0, 3), F2 = OD_COL(0.5, 1.5), F3 = OD_COL(3, 4), FLAT = OD_COL(2, 2);
  return buildPanel(LO.map((_, c) => [LO[c], HI[c], F2[c], F3[c], FLAT[c]]));
}

test("overdispersedReduce: per-gene mean/var/nobs over a cell subset (the cell-major reduce we own); deterministic", () => {
  const panel = odPanel();
  const r = overdispersedReduce(panel, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 1000);
  // means: LO(g0) and HI(g1) both 1.5; variance HI ≫ LO (0=>3 vs 1=>2, i.e. 9× the spread)
  assert.ok(Math.abs(r.mean[0] - 1.5) < 1e-9 && Math.abs(r.mean[1] - 1.5) < 1e-9);
  assert.ok(r.varr[1] > r.varr[0] * 3, "HI variance ≫ LO variance");
  assert.equal(r.varr[4], 0, "FLAT gene has zero variance");
  assert.equal(r.nobs[0], 10, "g0 (LO=[1×5,2×5]) expressed in all 10 cells");
  assert.equal(r.nobs[1], 5, "g1 (HI=[0×5,3×5]) expressed in 5 cells (zeros dropped)");
  // determinism: identical output across runs (deterministic stride sampler, no Math.random)
  const r2 = overdispersedReduce(panel, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 1000);
  assert.deepEqual(Array.from(r2.mean), Array.from(r.mean));
  assert.deepEqual(Array.from(r2.varr), Array.from(r.varr));
});

test("overdispersedRank: filters zero-variance genes, sorts by resid desc, honors topN (the rank we own)", () => {
  const r = { mean: Float64Array.from([1.5, 1.5, 1, 2, 2]), varr: Float64Array.from([0.25, 2.25, 0.5, 0.5, 0]), nobs: Int32Array.from([10, 10, 10, 10, 10]) };
  const scores = [0.1, 0.9, 0.5, 0.3, 99];   // g1 top; g4's score is high but it's FLAT (var 0) so must be dropped
  const out = overdispersedRank(r, scores, 50);
  const byG: Record<number, ODResult> = {}; for (const x of out) byG[x.g] = x;
  assert.ok(out.every((x) => "g" in x && "mean" in x && "varr" in x && "resid" in x && "nobs" in x));
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].resid >= out[i].resid, "sorted by resid desc");
  assert.equal(out[0].g, 1, "highest-resid non-flat gene ranks #1");
  assert.equal(byG[4], undefined, "zero-variance gene excluded even with a huge score");
  assert.equal(overdispersedRank(r, scores, 2).length, 2, "topN caps the table");
});

// Build a 10-cell panel from per-gene (mean, var) targets: a two-value column (5 cells at mean+d, 5 at
// mean-d, d=√var) hits any (mean, var) exactly. Used to lay genes on a clean mean–variance trend so the
// pagoda2 LOWESS fit is well-posed (a 5-gene toy degenerates to all-zero residuals in either implementation).
function trendPanel(targets: Array<{ m: number; v: number }>): ODPanel {
  const dense = Array.from({ length: 10 }, (_, c) => targets.map(({ m, v }) => { const d = Math.sqrt(v); return c < 5 ? m + d : m - d; }));
  return buildPanel(dense);
}

test("overdispersed (convergence): reduce + lstar overdispersionFromStats + rank — outlier scores high, flat excluded, WASM non-degenerate", async () => {
  // End-to-end via the SHARED lstar kernel (WASM) — the retired odcore LOWESS/F-test is now single-sourced.
  // 27 genes on a Poisson-ish trend (var ≈ 0.15·mean) + one clear over-dispersed outlier at mean 2 (var 1.5,
  // ~10× the trend) + one flat gene (var 0). (Byte-identity to the old pure-JS path was proven on real data in
  // the Q3 gate; here we lock in the composition + behavior through the new call.)
  const OUT_G = 27, FLAT_G = 28;
  const targets = Array.from({ length: 27 }, (_, i) => { const m = 0.5 + (3.5 * i) / 26; return { m, v: 0.15 * m }; });
  targets.push({ m: 2.0, v: 1.5 });   // g27 = over-dispersed outlier
  targets.push({ m: 2.0, v: 0 });     // g28 = flat (must be excluded)
  const panel = trendPanel(targets);
  const cells = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  const out = await overdispersed(panel, cells, 1000, 1000);
  const byG: Record<number, ODResult> = {}; for (const r of out) byG[r.g] = r;

  // sorted by resid desc; flat gene dropped
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].resid >= out[i].resid, "sorted by resid desc");
  assert.equal(byG[FLAT_G], undefined, "constant (zero-variance) gene is not scored");
  // WASM actually engaged (a degenerate fit returns all-zero residuals — guard against that regression)
  assert.ok(out.some((r) => r.resid !== 0), "overdispersion residuals are non-degenerate (WASM fit resolved)");
  // the outlier is over-dispersed vs a trend gene at the SAME mean (g13 has m≈2.25) and ranks near the top
  assert.ok(byG[OUT_G].resid > byG[13].resid, "the off-trend outlier scores above an on-trend gene at similar mean");
  assert.ok(out.slice(0, 3).some((r) => r.g === OUT_G), "the outlier ranks in the top 3");

  // composition correctness: overdispersed() == reduce → overdispersionFromStats → rank (M threaded through)
  const r = overdispersedReduce(panel, cells, 1000);
  const s = await lsOverdispersion(r.mean, r.varr, r.nobs);
  assert.deepEqual(out, overdispersedRank(r, s, 1000));
});

test("deCore: A-high gene has lfc>0, B-high lfc<0; ranked by |logFC|; group means correct; deterministic", () => {
  // 6 cells × 3 genes (lognorm). A = cells 0-2, B = cells 3-5. g0 is high in A, g1 high in B, g2 ~flat.
  const A = [0, 1, 2], B = [3, 4, 5];
  const dense = [
    [3, 0, 1], [3, 0, 1], [3, 0, 1],     // A cells
    [0, 3, 0.5], [0, 3, 0.5], [0, 3, 0.5],   // B cells
  ];
  const panel = buildPanel(dense);
  const out = deCore(panel, A, B);
  const byG: Record<number, any> = {}; for (const r of out) byG[r.g] = r;
  assert.equal(out.length, 3);
  assert.deepEqual(byG[0], { g: 0, meanA: 3, meanB: 0, lfc: 3 });       // higher in A
  assert.deepEqual(byG[1], { g: 1, meanA: 0, meanB: 3, lfc: -3 });      // higher in B
  assert.deepEqual(byG[2], { g: 2, meanA: 1, meanB: 0.5, lfc: 0.5 });   // ~flat
  for (let i = 1; i < out.length; i++) assert.ok(Math.abs(out[i - 1].lfc) >= Math.abs(out[i].lfc));   // |lfc| desc
  assert.equal(out[2].g, 2, "the flat gene ranks last");
  assert.deepEqual(deCore(panel, A, B), out);   // deterministic
});

test("groupStatsForCellsCore: per-group mean(log1p) + fraction-expressing over a cell subset", () => {
  // 6 cells × 2 genes. codes: cells 0-2 = group 0, cells 3-5 = group 1. geneCol null (all-genes panel), ngGlobal = 2.
  const dense = [[2, 1], [2, 0], [2, 1], [0, 3], [4, 3], [0, 3]];
  const panel = buildPanel(dense);
  const codes = Int32Array.from([0, 0, 0, 1, 1, 1]);
  const r = groupStatsForCellsCore(panel, null, 2, codes, 2, [0, 1, 2, 3, 4, 5]);
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-5, `${a} ≈ ${b}`);
  assert.deepEqual(Array.from(r.n), [3, 3]);
  // layout = [g0·gene0, g0·gene1, g1·gene0, g1·gene1]
  near(r.mean[0], 2);          // g0 gene0: (2+2+2)/3
  near(r.mean[1], 2 / 3);      // g0 gene1: (1+0+1)/3
  near(r.mean[2], 4 / 3);      // g1 gene0: (0+4+0)/3
  near(r.mean[3], 3);          // g1 gene1: (3+3+3)/3
  near(r.frac[0], 1);          // g0 gene0 expressed in all 3
  near(r.frac[2], 1 / 3);      // g1 gene0 expressed in 1 of 3
  // determinism
  assert.deepEqual(groupStatsForCellsCore(panel, null, 2, codes, 2, [0, 1, 2, 3, 4, 5]), r);
});

test("meanVarCore: per-gene mean+var over a CELL SUBSET (the subset counterpart to colMeanVar)", () => {
  const dense = [[2, 1], [2, 0], [2, 1], [0, 3], [0, 3], [0, 3]];
  const panel = buildPanel(dense);
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-5, `${a} ≈ ${b}`);
  const sub = meanVarCore(panel, [0, 1, 2]);        // cells 0-2 only
  near(sub[0].mean, 2); near(sub[0].var, 0); assert.equal(sub[0].nnz, 3);     // gene0: [2,2,2]
  near(sub[1].mean, 2 / 3); near(sub[1].var, 2 / 9); assert.equal(sub[1].nnz, 2);   // gene1: [1,0,1]
  const all = meanVarCore(panel, [0, 1, 2, 3, 4, 5]);   // all cells
  near(all[0].mean, 1); near(all[0].var, 1);            // gene0: [2,2,2,0,0,0] → mean 1, var 1
});

test("logFupperTail: monotone — a larger variance ratio is more significant (more negative log p)", () => {
  const a = logFupperTail(2, 50, 50), b = logFupperTail(10, 50, 50);
  assert.ok(b < a, "larger F → smaller upper-tail p → more negative log p");
  assert.equal(logFupperTail(0, 10, 10), 0);   // f<=0 guard
});

test("t-test p via T²~F(1,df): matches a known two-sided value", () => {
  const p = Math.exp(logFupperTail(2 * 2, 1, 10));   // |t|=2, df=10 → two-sided p ≈ 0.0734
  assert.ok(Math.abs(p - 0.0734) < 0.002, `p=${p} ≈ 0.0734`);
});

test("pseudobulkDECore: a gene that differs across replicate groups beats a null gene; ≥2-reps guard", () => {
  const ng = 2, G = 4;   // samples 0,1 = group A; 2,3 = group B (per-replicate means, row-major s*ng+j)
  //                gene0          gene1
  const meanA = [ 2.0, 1.0,   2.2, 1.1,   0, 0,    0, 0   ];   // reps 0,1 carry A
  const nA    = [ 50, 50, 0, 0 ];
  const meanB = [ 0, 0,   0, 0,   0.5, 1.05,  0.6, 0.95 ];     // reps 2,3 carry B
  const nB    = [ 0, 0, 50, 50 ];
  const { rows, repsA, repsB } = pseudobulkDECore(meanA, nA, meanB, nB, ng, G, 10);
  assert.deepEqual(repsA, [0, 1]); assert.deepEqual(repsB, [2, 3]);   // ≥minCells filter picks the right replicates
  assert.equal(rows.length, 2);
  assert.equal(rows[0].g, 0);                          // the strongly-different gene ranks first
  assert.ok(Math.abs(rows[0].lfc - 1.55) < 1e-6);      // (2.1) − (0.55)
  assert.equal(rows[0].nA, 2); assert.equal(rows[0].nB, 2);   // replicate counts, not cell counts
  assert.ok(rows[0].p < rows[1].p, "differing gene more significant than the null gene");
  const nullGene = rows.find((r) => r.g === 1)!;
  assert.ok(nullGene.p > 0.3, `null gene not significant (p=${nullGene.p})`);
  // a group with <2 replicates → no rows (caller turns repsA/repsB into a clear error)
  const one = pseudobulkDECore(meanA, [50, 0, 0, 0], meanB, nB, ng, G, 10);
  assert.equal(one.rows.length, 0); assert.deepEqual(one.repsA, [0]);
});

test("pseudobulkPairedDECore: paired across levels carrying BOTH sides; consistent within-pair shift is significant; ≥2 guard", () => {
  const ng = 2, G = 3;   // 3 samples, EACH with A-cells and B-cells (paired). row-major s*ng+j
  //  gene0: A−B = +1.0 every sample (consistent shift). gene1: A−B = ~0 (null).
  const meanA = [ 3.0, 1.0,   3.1, 1.1,   2.9, 0.9 ];
  const nA    = [ 40, 40, 40 ];
  const meanB = [ 2.0, 1.05,  2.1, 0.95,  1.9, 1.0 ];
  const nB    = [ 40, 40, 40 ];
  const { rows, reps } = pseudobulkPairedDECore(meanA, nA, meanB, nB, ng, G, 10);
  assert.deepEqual(reps, [0, 1, 2]);                 // all three carry BOTH sides → paired replicates
  assert.equal(rows.length, 2);
  assert.equal(rows[0].g, 0);                         // the consistently-shifted gene ranks first
  assert.ok(Math.abs(rows[0].lfc - 1.0) < 1e-6);      // mean paired difference ≈ +1.0
  assert.equal(rows[0].nA, 3); assert.equal(rows[0].nB, 3);   // paired-level count
  assert.ok(rows[0].p < 0.05, `consistent shift is significant (p=${rows[0].p})`);
  assert.ok(rows.find((r) => r.g === 1)!.p > 0.3, "null gene not significant");
  // a level missing one side is NOT a paired replicate; only 1 paired level left → <2 → no rows
  const dropped = pseudobulkPairedDECore(meanA, [40, 0, 40], meanB, [40, 40, 0], ng, G, 10);
  assert.deepEqual(dropped.reps, [0]); assert.equal(dropped.rows.length, 0);
});
