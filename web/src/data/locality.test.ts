// The tier-2/tier-3 decision rule. The whole point is that it is decidable with NO reads, so these
// tests are plain arithmetic — and they encode the two real shapes measured on a 13,533-cell store:
// a lassoed embedding region (1,500 cells, 40 runs) and imported per-cell labels (1,504 cells, 1,333
// runs). Run: node --test src/data/locality.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCount, planGroupStats } from "./locality.ts";

const codesFor = (n: number, member: (i: number) => boolean) =>
  Int32Array.from({ length: n }, (_, i) => (member(i) ? 0 : -1));

test("runCount: consecutive rows are one run", () => {
  assert.equal(runCount([3, 4, 5, 6], null), 1);
  assert.equal(runCount([6, 3, 5, 4], null), 1, "order of the input must not matter");
});

test("runCount: gaps split runs", () => {
  assert.equal(runCount([0, 1, 5, 6, 9], null), 3);
  assert.equal(runCount([0, 2, 4, 6], null), 4, "stride-2 is maximally fragmented");
  assert.equal(runCount([], null), 0);
  assert.equal(runCount([7], null), 1);
});

test("runCount: it is PHYSICAL rows that matter, not cell ids", () => {
  // cells 0,2,4 are scattered by id but adjacent once permuted -> one read, not three
  const posOf = Int32Array.from([0, 9, 1, 8, 2, 7]);
  assert.equal(runCount([0, 2, 4], posOf), 1);
  assert.equal(runCount([0, 2, 4], null), 3, "and the same cells look fragmented without the permutation");
});

test("plan: a compact region is read outright — exact statistics", () => {
  // the lasso shape: 1,500 cells lying in 40 contiguous blocks
  const posOf = Int32Array.from({ length: 13533 }, (_, i) => i);
  const codes = codesFor(13533, (i) => Math.floor(i / 37.5) % 9 === 0);   // ~40 blocks of ~37 cells
  const p = planGroupStats(codes, posOf);
  assert.equal(p.mode, "read");
  assert.ok(p.runs < 100, `expected few runs, got ${p.runs}`);
  assert.match(p.reason, /contiguous blocks/);
});

test("plan: cells scattered one-per-block are sampled", () => {
  // the imported-per-cell-label shape: every 9th cell, ~one run each
  const posOf = Int32Array.from({ length: 13533 }, (_, i) => i);
  const codes = codesFor(13533, (i) => i % 9 === 0);
  const p = planGroupStats(codes, posOf);
  assert.equal(p.mode, "sample");
  assert.ok(p.runs > 1000, `expected ~one run per cell, got ${p.runs}`);
  assert.match(p.reason, /scattered over/);
});

test("plan: a grouping covering the whole dataset is sampled even though it is contiguous", () => {
  // the trap: "read every cell" of a full partition IS the whole-matrix pass this tier exists to avoid
  const posOf = Int32Array.from({ length: 13533 }, (_, i) => i);
  const p = planGroupStats(Int32Array.from({ length: 13533 }, (_, i) => i % 27), posOf);
  assert.equal(p.mode, "sample");
  assert.equal(p.runs, 1, "perfectly contiguous — and still not worth reading whole");
  assert.match(p.reason, /sample budget/);
});

test("plan: the two budgets are independent", () => {
  const posOf = null;
  const compactSmall = codesFor(1000, (i) => i < 500);            // 1 run, 500 cells
  assert.equal(planGroupStats(compactSmall, posOf).mode, "read");
  // same cells, but a request budget tighter than the run count
  assert.equal(planGroupStats(codesFor(1000, (i) => i % 2 === 0), posOf, { maxRuns: 10 }).mode, "sample");
  // same layout, but a byte budget smaller than the group
  assert.equal(planGroupStats(compactSmall, posOf, { sampleCells: 100 }).mode, "sample");
});

test("plan: unlabelled cells carry no statistics and are not counted", () => {
  const codes = Int32Array.from([0, -1, -1, 0, -1]);
  const p = planGroupStats(codes, null);
  assert.equal(p.cells, 2);
  assert.equal(planGroupStats(Int32Array.from([-1, -1]), null).cells, 0);
});

test("plan: a MIXED grouping takes the sampled path for all of its groups", () => {
  // group 0 compact, group 1 scattered — one table must not mix exact and estimated rows
  const codes = Int32Array.from({ length: 4000 }, (_, i) => (i < 400 ? 0 : i % 3 === 0 ? 1 : -1));
  const p = planGroupStats(codes, null, { maxRuns: 50 });
  assert.equal(p.mode, "sample", "the scattered half decides for the whole grouping");
});
