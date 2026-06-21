// Unit tests for the pure field-role heuristic. Run: `node --test src/data/fieldroles.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldBuckets, looksLikeReplicate } from "./fieldroles.ts";

const cats = [
  { name: "leiden", n: 12 }, { name: "cell_type", n: 12 },   // clusterings (have markers)
  { name: "sample", n: 6 }, { name: "condition", n: 2 },     // covariates
];
const numeric = ["mito", "n_umi", "n_gene"];

test("fieldBuckets: groupings vs covariates vs numeric; replicate flagged", () => {
  const b = fieldBuckets(["leiden", "cell_type"], cats, numeric, 2000);
  assert.deepEqual(b.groupings, [{ name: "leiden", n: 12 }, { name: "cell_type", n: 12 }]);
  assert.deepEqual(b.covariates.map((c) => c.name), ["sample", "condition"]);
  assert.equal(b.covariates.find((c) => c.name === "sample")!.replicate, true);    // donor-like name
  assert.equal(b.covariates.find((c) => c.name === "condition")!.replicate, undefined);
  assert.equal(b.replicate, "sample");   // the natural pseudobulk unit
  assert.deepEqual(b.numeric, numeric);
  assert.equal(b.geneCount, 2000);
});

test("fieldBuckets: a set_field_roles override moves a field between buckets", () => {
  // the agent marks "condition" as a partition (a clustering) → it becomes a grouping, not a covariate
  const role = (f: string) => (f === "condition" ? "partition" : undefined) as any;
  const b = fieldBuckets(["leiden", "cell_type"], cats, numeric, 2000, role);
  assert.ok(b.groupings.some((g) => g.name === "condition"));
  assert.ok(!b.covariates.some((c) => c.name === "condition"));
});

test("looksLikeReplicate: donor/sample names, not condition/time", () => {
  for (const y of ["sample", "Sample", "donor", "donor_id", "patient", "PatientID", "orig.ident", "subject"]) assert.ok(looksLikeReplicate(y), `${y} → replicate`);
  for (const n of ["condition", "treatment", "timepoint", "leiden", "cell_type", "genotype"]) assert.ok(!looksLikeReplicate(n), `${n} → not replicate`);
});
