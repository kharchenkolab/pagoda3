import { test } from "node:test";
import assert from "node:assert/strict";
import { sample, overdispersedCore, deCore, groupStatsForCellsCore, meanVarCore, logFupperTail, type ODPanel } from "./odcore.ts";

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

test("overdispersedCore: same MEAN, higher VARIANCE ranks as more overdispersed; zero-variance excluded; deterministic", () => {
  // 10 cells × 5 genes (lognorm values given directly). g0=LO and g1=HI share mean 1.5 but HI has 9× the variance.
  // g4=FLAT is constant (variance 0) → must be excluded. g2/g3 are filler so the LOWESS trend has enough points.
  const col = (lo: number, hi: number) => [lo, lo, lo, lo, lo, hi, hi, hi, hi, hi];
  const LO = col(1, 2), HI = col(0, 3), F2 = col(0.5, 1.5), F3 = col(3, 4), FLAT = col(2, 2);
  const dense = LO.map((_, c) => [LO[c], HI[c], F2[c], F3[c], FLAT[c]]);
  const panel = buildPanel(dense);
  const cells = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  const out = overdispersedCore(panel, cells, 10, 1000);
  const byG: Record<number, any> = {}; for (const r of out) byG[r.g] = r;

  // shape
  assert.ok(out.every((r) => "g" in r && "mean" in r && "varr" in r && "resid" in r && "nobs" in r));
  // sorted by resid desc
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].resid >= out[i].resid);
  // means: LO and HI both 1.5
  assert.ok(Math.abs(byG[0].mean - 1.5) < 1e-9 && Math.abs(byG[1].mean - 1.5) < 1e-9);
  // HI variance ≫ LO variance
  assert.ok(byG[1].varr > byG[0].varr * 3);
  // the OVERDISPERSION call: HI (g1) is more overdispersed than LO (g0), and is the top hit
  assert.ok(byG[1].resid > byG[0].resid, "higher-variance gene must score higher");
  assert.equal(out[0].g, 1, "the high-variance gene ranks #1");
  // zero-variance gene excluded
  assert.equal(byG[4], undefined, "constant (zero-variance) gene is not scored");

  // determinism: identical output across runs
  assert.deepEqual(overdispersedCore(panel, cells, 10, 1000), out);
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
