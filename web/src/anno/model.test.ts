import { test } from "node:test";
import assert from "node:assert/strict";
import { seedLayer, emptyLayer, setLabel, clearLabel, compact, reconcile } from "./model.ts";

test("seedLayer copies the source (independent arrays)", () => {
  const src = { codes: Int32Array.from([0, 1, 0, 2]), categories: ["a", "b", "c"] };
  const L = seedLayer("annotation", "derived", src);
  assert.deepEqual([...L.codes], [0, 1, 0, 2]);
  assert.deepEqual(L.categories, ["a", "b", "c"]);
  L.codes[0] = 9; L.categories.push("d");
  assert.deepEqual([...src.codes], [0, 1, 0, 2]);   // source untouched (non-destructive)
  assert.deepEqual(src.categories, ["a", "b", "c"]);
});

test("setLabel adds new categories, updates cells, last-write-wins", () => {
  const L = emptyLayer("annotation", "manual", 5);
  assert.deepEqual([...L.codes], [-1, -1, -1, -1, -1]);
  setLabel(L, [0, 1], "NK");
  assert.deepEqual(L.categories, ["NK"]);
  assert.deepEqual([...L.codes], [0, 0, -1, -1, -1]);
  setLabel(L, [2, 3], "B");
  assert.deepEqual(L.categories, ["NK", "B"]);
  assert.deepEqual([...L.codes], [0, 0, 1, 1, -1]);
  setLabel(L, [1], "B");   // last-write-wins: cell 1 NK → B
  assert.deepEqual([...L.codes], [0, 1, 1, 1, -1]);
  setLabel(L, [99], "X");  // out-of-range ignored
  assert.deepEqual([...L.codes], [0, 1, 1, 1, -1]);
});

test("clearLabel resets cells to -1", () => {
  const L = setLabel(emptyLayer("a", "manual", 3), [0, 1, 2], "T");
  clearLabel(L, [1]);
  assert.deepEqual([...L.codes], [0, -1, 0]);
});

test("compact drops unused categories and remaps codes", () => {
  const L = seedLayer("a", "derived", { codes: Int32Array.from([0, 2, 2, -1]), categories: ["x", "y", "z"] });
  compact(L);   // "y" (index 1) is unused
  assert.deepEqual(L.categories, ["x", "z"]);
  assert.deepEqual([...L.codes], [0, 1, 1, -1]);
});

test("reconcile: per-group dominant label, fraction, and agreement status", () => {
  // base: 2 clusters. cluster 0 = cells 0-3, cluster 1 = cells 4-5
  const base = { codes: Int32Array.from([0, 0, 0, 0, 1, 1]), categories: ["c0", "c1"] };
  const markers = { name: "markers", codes: Int32Array.from([0, 0, 0, 1, 1, 1]), categories: ["NK", "B"] };  // c0 mostly NK (3/4)
  const celltypist = { name: "CellTypist", codes: Int32Array.from([0, 0, 0, 0, 2, 2]), categories: ["NK", "x", "B"] }; // c0 all NK, c1 all B
  const rows = reconcile(base, [markers, celltypist]);

  assert.equal(rows.length, 2);
  // cluster 0: markers→NK (3/4=0.75), CellTypist→NK (1.0) → agree
  assert.equal(rows[0].group, "c0"); assert.equal(rows[0].n, 4);
  assert.deepEqual(rows[0].sources[0], { name: "markers", label: "NK", frac: 0.75 });
  assert.deepEqual(rows[0].sources[1], { name: "CellTypist", label: "NK", frac: 1 });
  assert.equal(rows[0].status, "agree");
  // cluster 1: markers→B (1.0), CellTypist→B (1.0) → agree
  assert.equal(rows[1].status, "agree");
});

test("reconcile: conflict and single-source statuses", () => {
  const base = { codes: Int32Array.from([0, 0, 1, 1]), categories: ["c0", "c1"] };
  const a = { name: "a", codes: Int32Array.from([0, 0, 0, 0]), categories: ["CD8 T"] };
  const b = { name: "b", codes: Int32Array.from([1, 1, -1, -1]), categories: ["x", "CD4 T"] };
  const rows = reconcile(base, [a, b]);
  // cluster 0: a→CD8 T, b→CD4 T → conflict
  assert.equal(rows[0].status, "conflict");
  // cluster 1: a→CD8 T, b silent → single
  assert.equal(rows[1].status, "single");
});
