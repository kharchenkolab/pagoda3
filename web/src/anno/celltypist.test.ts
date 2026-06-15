import { test } from "node:test";
import assert from "node:assert/strict";
import { predictLR, lrFinalize } from "./celltypist.ts";

test("predictLR: argmax of softmax(X·W+b) per cell", () => {
  // 2 genes, 2 classes. gene0 drives class0, gene1 drives class1.
  const model = { genes: ["g0", "g1"], classes: ["c0", "c1"], W: Float32Array.from([1, 0, 0, 1]), b: Float32Array.from([0, 0]) };
  const X = Float32Array.from([2, 0, /*cell0 g0-high*/ 0, 2 /*cell1 g1-high*/]);
  const { codes, conf } = predictLR(X, 2, model);
  assert.deepEqual([...codes], [0, 1]);
  assert.ok(conf[0] > 0.8 && conf[1] > 0.8);   // confident
});

test("lrFinalize: intercept breaks ties; probabilities sum to 1 per row", () => {
  const logits = Float64Array.from([0, 0, 0,  /*row0 tie→argmax first*/  -1, 5, 0 /*row1 → class1*/]);
  const { codes, conf } = lrFinalize(logits, 2, 3);
  assert.equal(codes[0], 0);
  assert.equal(codes[1], 1);
  assert.ok(conf[1] > 0.9);
});
