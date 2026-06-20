import { test } from "node:test";
import assert from "node:assert/strict";
import { runCapability, capability, capabilityMenu, resolveCells, type CapCtx } from "./capabilities.ts";

// A mock data context: 10 cells, a categorical `cell_type` (A/B), and stub kernels that echo their inputs so we can
// assert the primitives wire the right cells through.
function mockCtx(over?: Partial<CapCtx>): CapCtx {
  const codes = Int32Array.from([0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);   // 4×A, 6×B
  return {
    n: 10,
    selectedCells: () => [0, 1, 2, 3],
    metaOf: async (f: string) => f === "cell_type" ? { kind: "categorical", codes, categories: ["A", "B"] } : { kind: "numeric", values: new Float32Array(10), min: 0, max: 1 },
    cellsOfCategory: (_f: string, v: string) => v === "A" ? [0, 1, 2, 3] : [4, 5, 6, 7, 8, 9],
    view: {
      subsampleDE: async (A: number[], B: number[]) => ({ ranked: [
        { symbol: "UP", lfc: 2, meanA: 3, meanB: 0.1 }, { symbol: "DN", lfc: -1.5, meanA: 0.1, meanB: 2 }, { symbol: "MID", lfc: 0.2, meanA: 1, meanB: 0.9 },
      ], nA: A.length, approx: B.length > 0 }),
      overdispersedGenes: async (cells: number[], topN?: number) => [
        { symbol: "HVG1", resid: 5.4, mean: 1.2 }, { symbol: "HVG2", resid: 3.1, mean: 0.8 },
      ].slice(0, topN),
      geneExpression: async (g: string) => ({ values: Float32Array.from([0, 2, 0, 4, 1, 0, 3, 0, 0, 5]) }),   // same vector for any gene
    },
    ...over,
  } as CapCtx;
}

test("overdispersion: resolves a category, returns {symbol, score=resid}", async () => {
  const r = await runCapability(mockCtx(), "overdispersion", { field: "cell_type", value: "A", n: 5 });
  assert.equal(r.nA, 4);
  assert.deepEqual(r.genes[0], { symbol: "HVG1", score: 5.4, mean: 1.2 });
  assert.equal(r.genes[1].score, 3.1);
});

test("de: A vs B, dir filters by sign of logFC", async () => {
  const up = await runCapability(mockCtx(), "de", { A: { field: "cell_type", value: "A" }, B: { field: "cell_type", value: "B" }, dir: "up" });
  assert.deepEqual(up.genes.map((g: any) => g.symbol), ["UP", "MID"]);   // both lfc>0, sorted desc
  const down = await runCapability(mockCtx(), "de", { A: { field: "cell_type", value: "A" }, dir: "down" });   // B defaults to complement
  assert.deepEqual(down.genes.map((g: any) => g.symbol), ["DN"]);
  const abs = await runCapability(mockCtx(), "de", { A: { cells: [0, 1] }, dir: "abs" });   // raw |logFC|
  assert.equal(abs.genes.length, 3);
});

test("de: default dir 'both' is BALANCED two-sided (up genes then down), not one-sided", async () => {
  // a one-sided-dominant mock: 3 strong-down genes + 1 weak-up. 'abs' top-2 would be all down; 'both' must surface the up gene.
  const ctx = mockCtx({ view: {
    subsampleDE: async (A: number[], B: number[]) => ({ ranked: [
      { symbol: "D1", lfc: -3, meanA: 0, meanB: 3 }, { symbol: "D2", lfc: -2.5, meanA: 0, meanB: 2.5 }, { symbol: "D3", lfc: -2, meanA: 0, meanB: 2 }, { symbol: "U1", lfc: 0.4, meanA: 0.5, meanB: 0.1 },
    ], nA: A.length, nB: B.length, approx: B.length > 0 }),
    overdispersedGenes: async () => [], geneExpression: async () => ({ values: new Float32Array(10) }),
  } as any });
  const r = await runCapability(ctx, "de", { A: { cells: [0, 1] }, B: { cells: [4, 5] }, n: 2 });   // default dir → 'both'
  assert.equal(r.dir, "both");
  assert.ok(r.genes.some((g: any) => g.lfc > 0), "balanced 'both' must include an up gene");
  assert.ok(r.genes.some((g: any) => g.lfc < 0), "balanced 'both' must include a down gene");
  assert.deepEqual(r.genes.map((g: any) => g.symbol), ["U1", "D1"]);   // half up (U1) + half down (strongest = D1), sorted signed desc
});

test("markers: defaults to the selection vs the rest, up by default", async () => {
  const r = await runCapability(mockCtx(), "markers", {});   // no cells → selection [0..3]
  assert.equal(r.nA, 4);
  assert.deepEqual(r.genes.map((g: any) => g.symbol), ["UP", "MID"]);   // dir up → positive lfc, sorted desc
});

test("groupStats: per-group mean + frac for genes", async () => {
  const r = await runCapability(mockCtx(), "groupStats", { field: "cell_type", genes: ["G1"] });
  assert.deepEqual(r.groups, ["A", "B"]);
  // vec=[0,2,0,4 | 1,0,3,0,0,5]; A(4 cells): mean=(0+2+0+4)/4=1.5, frac=2/4=0.5; B(6): mean=9/6=1.5, frac=3/6=0.5
  assert.deepEqual(r.mean[0], [1.5, 1.5]);
  assert.deepEqual(r.frac[0], [0.5, 0.5]);
});

test("resolveCells: cells | category | default-selection", async () => {
  const ctx = mockCtx();
  assert.deepEqual(await resolveCells(ctx, { cells: [1, 2, 99, -1] }), [1, 2]);   // out-of-range dropped
  assert.deepEqual(await resolveCells(ctx, { field: "cell_type", value: "B" }), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(await resolveCells(ctx, {}), [0, 1, 2, 3]);
});

test("unknown capability throws with the available list; menu omits run()", async () => {
  await assert.rejects(() => runCapability(mockCtx(), "bogus", {}), /unknown compute 'bogus'.*overdispersion/);
  assert.ok(capability("overdispersion"));
  for (const c of capabilityMenu()) { assert.equal((c as any).run, undefined); assert.ok(c.name && c.summary && c.example && c.returns, `menu item ${c.name} missing a field`); }
});
