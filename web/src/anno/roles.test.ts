import { test } from "node:test";
import assert from "node:assert/strict";
import { prefilterRole, candidateFields } from "./roles.ts";

const N = 35000, S = 6;

test("prefilter: numeric → qc, id-like → covariate, constant → covariate", () => {
  assert.equal(prefilterRole({ name: "pct_mito", kind: "numeric", cardinality: 0 }, N, S), "qc");
  assert.equal(prefilterRole({ name: "barcode", kind: "categorical", cardinality: N }, N, S), "covariate");
  assert.equal(prefilterRole({ name: "all_one", kind: "categorical", cardinality: 1 }, N, S), "covariate");
});

test("prefilter: mid-cardinality categoricals are candidates (agent decides by value)", () => {
  // cell_type (~20), leiden (~28), sample (6), condition (2) all survive as candidates — shape can't tell
  // a 6-value covariate from a 6-value coarse annotation, so the agent reads the values.
  for (const c of [2, 6, 20, 28]) assert.equal(prefilterRole({ name: "x", kind: "categorical", cardinality: c }, N, S), "candidate");
});

test("candidateFields returns only the unsettled categoricals", () => {
  const fields = [
    { name: "pct_mito", kind: "numeric" as const, cardinality: 0 },
    { name: "barcode", kind: "categorical" as const, cardinality: N },
    { name: "cell_type", kind: "categorical" as const, cardinality: 22 },
    { name: "leiden", kind: "categorical" as const, cardinality: 28 },
    { name: "condition", kind: "categorical" as const, cardinality: 2 },
  ];
  assert.deepEqual(candidateFields(fields, N, S), ["cell_type", "leiden", "condition"]);
});
