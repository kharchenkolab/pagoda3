import { test } from "node:test";
import assert from "node:assert/strict";
import { zscoreByGroup, scoreClusters, assignClusters } from "./sctype.ts";

test("zscoreByGroup standardizes each gene across groups; constant gene → 0", () => {
  // 2 groups, 2 genes. gene0 varies, gene1 constant.
  const gm = Float32Array.from([0, 3, 4, 3]);   // g0:[0,3] g1:[4,3]
  const z = zscoreByGroup(gm, 2, 2);
  assert.ok(z[0] < 0 && z[2] > 0);              // gene0: g0 below mean, g1 above
  assert.equal(z[1], 0); assert.equal(z[3], 0); // gene1 constant → 0
});

test("scoreClusters + assignClusters pick the right cell type per cluster", () => {
  // genes: 0=CD3D, 1=GNLY, 2=CD14. 3 clusters each high in one gene.
  const G = 3, nGenes = 3;
  const gm = Float32Array.from([
    5, 0, 0,   // cluster 0: T (CD3D high)
    0, 5, 0,   // cluster 1: NK (GNLY high)
    0, 0, 5,   // cluster 2: Mono (CD14 high)
  ]);
  const z = zscoreByGroup(gm, G, nGenes);
  const markers = {
    "T cell": { positive: [0], negative: [1] },
    "NK cell": { positive: [1], negative: [0] },
    "Monocyte": { positive: [2], negative: [] },
  };
  const assigned = assignClusters(scoreClusters(z, G, nGenes, markers));
  assert.deepEqual(assigned.map((a) => a.cellType), ["T cell", "NK cell", "Monocyte"]);
  assert.ok(assigned.every((a) => a.margin > 0));   // a clear winner each time
});

test("negative markers penalize — a CD3D+ cluster is not called NK", () => {
  const z = zscoreByGroup(Float32Array.from([5, 1, 1, 5]), 2, 2);   // g0 CD3D-high, g1 gene1-high
  const markers = {
    "T cell": { positive: [0], negative: [] },
    "NK cell": { positive: [1], negative: [0] },   // CD3D is a negative for NK
  };
  const assigned = assignClusters(scoreClusters(z, 2, 2, markers));
  assert.equal(assigned[0].cellType, "T cell");    // cluster 0 (CD3D high) → T, NK penalized
});
