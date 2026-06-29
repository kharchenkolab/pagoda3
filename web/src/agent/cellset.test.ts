// Unit tests for the pure cell-set algebra. Run: `node --test src/agent/cellset.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { validateCellSet, resolveCellSet, describeCellSet } from "./cellset.ts";
import type { CellWorld, CellEnv, CellSet } from "./cellset.ts";

const world: CellWorld = {
  categoricals: ["leiden", "cond"],
  valuesOf: (f) => ({ leiden: ["A", "B"], cond: ["day0", "day7"] } as Record<string, string[]>)[f] || [],
  hasSelection: true,
  hasFocus: false,
};

// cells 0..9; leiden A = first half, B = second half; cond day0 = {0,1,5,6}; selection = {2,3,7}; focus = {0,1,2}
const env: CellEnv = {
  n: 10,
  category: (g, v) => {
    if (g === "leiden") return v === "A" ? [0, 1, 2, 3, 4] : [5, 6, 7, 8, 9];
    if (g === "cond") return v === "day0" ? [0, 1, 5, 6] : [2, 3, 4, 7, 8, 9];
    return [];
  },
  selection: () => [2, 3, 7],
  focus: () => [0, 1, 2],
};
const arr = (s: Set<number>) => [...s].sort((a, b) => a - b);

test("validate: leaves", () => {
  assert.equal(validateCellSet({ all: true }, world), null);
  assert.equal(validateCellSet({ category: { grouping: "leiden", value: "A" } }, world), null);
  assert.equal(validateCellSet({ selection: true }, world), null);
  assert.match(validateCellSet({ focus: true }, world)!, /no active focus/);   // hasFocus=false
  assert.match(validateCellSet({ category: { grouping: "x", value: "A" } }, world)!, /unknown field/);
  assert.match(validateCellSet({ category: { grouping: "leiden", value: "Z" } }, world)!, /not a value of leiden/);
});

test("set: literal id leaf — validate, resolve, describe", () => {
  assert.equal(validateCellSet({ set: [2, 5, 8] }, world), null);
  assert.match(validateCellSet({ set: [] }, world)!, /non-empty array of cell indices/);
  assert.match(validateCellSet({ set: "nope" }, world)!, /non-empty array of cell indices/);
  assert.match(validateCellSet({ set: [1.5] }, world)!, /cell indices/);
  assert.deepEqual(arr(resolveCellSet({ set: [7, 2, 3] }, env)), [2, 3, 7]);
  // composes with the boolean ops like any other leaf — A (leiden A) minus a pinned set
  assert.deepEqual(arr(resolveCellSet({ intersect: [{ category: { grouping: "leiden", value: "A" } }, { complement: { set: [0, 1] } }] }, env)), [2, 3, 4]);
  assert.equal(describeCellSet({ set: [4, 9, 1] } as any), "3 cells");
});

test("validate: structure", () => {
  assert.match(validateCellSet({}, world)!, /exactly one of/);
  assert.match(validateCellSet({ all: true, selection: true }, world)!, /exactly one of/);   // two keys
  assert.match(validateCellSet({ intersect: [] }, world)!, /non-empty array/);
  assert.match(validateCellSet("nope", world)!, /exactly one of/);
});

test("validate: recursion through complement/intersect/union reports the inner error", () => {
  assert.equal(validateCellSet({ complement: { category: { grouping: "leiden", value: "A" } } }, world), null);
  assert.match(validateCellSet({ complement: { category: { grouping: "leiden", value: "Z" } } }, world)!, /not a value/);
  assert.equal(validateCellSet({ union: [{ category: { grouping: "leiden", value: "A" } }, { category: { grouping: "leiden", value: "B" } }] }, world), null);
  assert.match(validateCellSet({ intersect: [{ all: true }, { category: { grouping: "bad", value: "A" } }] }, world)!, /intersect\[1\].*unknown field/);
});

test("resolve: leaves + all", () => {
  assert.deepEqual(arr(resolveCellSet({ all: true }, env)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(arr(resolveCellSet({ category: { grouping: "leiden", value: "A" } }, env)), [0, 1, 2, 3, 4]);
  assert.deepEqual(arr(resolveCellSet({ selection: true }, env)), [2, 3, 7]);
  assert.deepEqual(arr(resolveCellSet({ focus: true }, env)), [0, 1, 2]);
});

test("resolve: boolean ops", () => {
  assert.deepEqual(arr(resolveCellSet({ complement: { category: { grouping: "leiden", value: "A" } } }, env)), [5, 6, 7, 8, 9]);
  assert.deepEqual(arr(resolveCellSet({ intersect: [{ category: { grouping: "leiden", value: "A" } }, { category: { grouping: "cond", value: "day0" } }] }, env)), [0, 1]);
  assert.deepEqual(arr(resolveCellSet({ union: [{ category: { grouping: "leiden", value: "A" } }, { category: { grouping: "cond", value: "day0" } }] }, env)), [0, 1, 2, 3, 4, 5, 6]);
});

test("resolve: nested — leiden A minus cond day0 (A ∩ not day0)", () => {
  const expr: CellSet = { intersect: [{ category: { grouping: "leiden", value: "A" } }, { complement: { category: { grouping: "cond", value: "day0" } } }] };
  assert.deepEqual(arr(resolveCellSet(expr, env)), [2, 3, 4]);   // A={0..4} minus day0={0,1,5,6}
});

test("describe", () => {
  assert.equal(describeCellSet({ category: { grouping: "leiden", value: "B (naive)" } } as any), "B (naive)");
  assert.equal(describeCellSet({ complement: { category: { grouping: "cond", value: "day0" } } } as any), "not day0");
  assert.equal(describeCellSet({ intersect: [{ category: { grouping: "cell_type", value: "CD8 T" } }, { category: { grouping: "cond", value: "day7" } }] } as any), "CD8 T ∩ day7");
});
