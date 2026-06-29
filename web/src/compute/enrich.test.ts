// Unit tests for ORA enrichment. Run: `node --test src/compute/enrich.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { hyperUpperTail, enrich, enrichRanked } from "./enrich.ts";

test("hyperUpperTail: bounds, monotonicity, known value", () => {
  // P(X>=k) is 1 at the floor and shrinks as k grows
  assert.equal(hyperUpperTail(0, 10, 10, 20), 1);
  assert.ok(hyperUpperTail(7, 10, 10, 20) > hyperUpperTail(9, 10, 10, 20));
  // classic 2x2: 50 white / 50 black, draw 10, all 10 white — vanishingly unlikely
  assert.ok(hyperUpperTail(10, 10, 50, 100) < 1e-3);
  // a perfectly average overlap stays near 1
  assert.ok(hyperUpperTail(1, 10, 10, 100) > 0.5);
  // every term is a valid probability
  for (let k = 0; k <= 10; k++) { const p = hyperUpperTail(k, 10, 30, 100); assert.ok(p >= 0 && p <= 1); }
});

test("enrich: a query that IS a pathway scores tiny p / huge fold; disjoint sets drop out", () => {
  const universe = new Set(Array.from({ length: 1000 }, (_, i) => "g" + i));
  const pathways = [
    { id: "P1", name: "target", genes: Array.from({ length: 50 }, (_, i) => "g" + i) },        // g0..g49
    { id: "P2", name: "other", genes: Array.from({ length: 50 }, (_, i) => "g" + (500 + i)) },  // g500..g549 (disjoint)
  ];
  const query = Array.from({ length: 20 }, (_, i) => "g" + i);   // g0..g19, all inside P1
  const rows = enrich(query, pathways, universe);
  assert.equal(rows.length, 1);                 // P2 has 0 overlap → below minK, dropped
  assert.equal(rows[0].id, "P1");
  assert.equal(rows[0].k, 20); assert.equal(rows[0].m, 50); assert.equal(rows[0].n, 20);
  assert.ok(rows[0].p < 1e-20);                 // 20/20 of the query landing in a 50/1000 set is astronomically enriched
  assert.ok(rows[0].fold > 15);                 // (20/20)/(50/1000) = 20
  assert.deepEqual(rows[0].genes.slice(0, 3), ["g0", "g1", "g10"]);   // overlap genes reported (sorted)
});

test("enrich: BH-FDR is monotonic with p and ≥ p", () => {
  const universe = new Set(Array.from({ length: 2000 }, (_, i) => "g" + i));
  const pathways = Array.from({ length: 30 }, (_, j) => ({ id: "P" + j, name: "p" + j, genes: Array.from({ length: 40 }, (_, i) => "g" + ((j * 13 + i) % 2000)) }));
  const query = Array.from({ length: 60 }, (_, i) => "g" + i);
  const rows = enrich(query, pathways, universe, { minK: 1 });
  for (let i = 1; i < rows.length; i++) { assert.ok(rows[i].p >= rows[i - 1].p); assert.ok(rows[i].fdr >= rows[i - 1].fdr - 1e-12); }
  rows.forEach((r) => assert.ok(r.fdr >= r.p - 1e-12 && r.fdr <= 1));
});

test("enrich: query genes outside the universe are ignored (background is what you could detect)", () => {
  const universe = new Set(["a", "b", "c", "d", "e"]);
  const rows = enrich(["a", "b", "ZZZ_not_measured"], [{ id: "P", name: "p", genes: ["a", "b", "c"] }], universe, { minK: 2 });
  assert.equal(rows[0].n, 2);   // ZZZ dropped → n counts only a,b
  assert.equal(rows[0].k, 2);
});

test("enrichRanked: splits up/down, and the background is the tested+DETECTED genes (undetected excluded)", () => {
  const geneSpace = new Set(["U1", "U2", "U3", "U4", "U5", "D1", "D2", "D3", "D4", "D5", "X1", "X2", "X3", "Z1"]);
  const pathways = [
    { id: "PUP", name: "up path", genes: ["U1", "U2", "U3", "U4", "U5", "X1"] },
    { id: "PDN", name: "down path", genes: ["D1", "D2", "D3", "D4", "D5", "X2"] },
  ];
  const ranked = [
    ...["U1", "U2", "U3", "U4", "U5"].map((s, i) => ({ symbol: s, lfc: 2 - i * 0.1, meanA: 1, meanB: 0 })),   // up, detected
    ...["D1", "D2", "D3", "D4", "D5"].map((s, i) => ({ symbol: s, lfc: -2 + i * 0.1, meanA: 0, meanB: 1 })),   // down, detected
    { symbol: "X3", lfc: 0.01, meanA: 0.5, meanB: 0.5 },
    { symbol: "Z1", lfc: 1.5, meanA: 0, meanB: 0 },   // ranked + annotated BUT undetected → must not enter the background
  ];
  const res = enrichRanked(ranked, pathways, geneSpace, { topN: 50, direction: "both" });
  const up = res.find((r) => r.direction === "up")!, down = res.find((r) => r.direction === "down")!;
  assert.equal(up.rows[0].id, "PUP");                 // up-regulated genes enrich the up pathway
  assert.equal(down.rows[0].id, "PDN");               // down-regulated → down pathway (no cancellation)
  assert.equal(up.N, 11);                             // background = U1-5 + D1-5 + X3 = 11; Z1 (undetected) excluded
  assert.ok(!up.rows.some((r) => r.genes.includes("Z1")));
});
