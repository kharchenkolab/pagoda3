// selectCountsBasis — pick the prep count basis by STATE, not the literal name "counts".
// Mirrors lstar's Python/R viewer._select_counts_basis. Run: node --experimental-strip-types --test prep/basis.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCountsBasis } from "./basis.ts";

const M = (span: string[] = ["cells", "genes"], role = "measure", state?: string) => ({ role, span, state });
const ds = (f: Record<string, any>) => ({ fieldNames: () => Object.keys(f), field: (n: string) => f[n] });

test("default: prefers a measure named 'counts' (raw → log1p)", () => {
  assert.deepEqual(selectCountsBasis(ds({ counts: M(["cells", "genes"], "measure", "raw"), X: M(["cells", "genes"], "measure", "scaled") })), { field: "counts", log1p: true });
});

test("default: no 'counts' name → picks a raw-state measure (e.g. an AnnData .X)", () => {
  assert.deepEqual(selectCountsBasis(ds({ X: M(["cells", "genes"], "measure", "raw") })), { field: "X", log1p: true });
});

test("no raw basis (scaled .X + lognorm .raw) → clear error listing measures", () => {
  const call = () => selectCountsBasis(ds({ X: M(["cells", "genes"], "measure", "scaled"), rawX: M(["cells", "genes"], "measure", "lognorm") }));
  assert.throws(call, /no raw counts/);
  assert.throws(call, /X\[scaled\]/);
  assert.throws(call, /basis="lognorm"/);
});

test("counts= forces a measure (and rejects an unknown one)", () => {
  assert.deepEqual(selectCountsBasis(ds({ X: M(["cells", "genes"], "measure", "scaled") }), { counts: "X" }), { field: "X", log1p: true });
  assert.throws(() => selectCountsBasis(ds({ X: M() }), { counts: "nope" }), /counts="nope" is not a measure/);
});

test("basis='lognorm' picks a log-normalized measure, used as-is (log1p false)", () => {
  assert.deepEqual(selectCountsBasis(ds({ X: M(["cells", "genes"], "measure", "scaled"), data: M(["cells", "genes"], "measure", "lognorm") }), { basis: "lognorm" }), { field: "data", log1p: false });
  assert.throws(() => selectCountsBasis(ds({ counts: M(["cells", "genes"], "measure", "raw") }), { basis: "lognorm" }), /no log-normalized measure/);
});

test("ignores non-measures and 1-D fields", () => {
  assert.equal(selectCountsBasis(ds({ leiden: M(["cells"], "label"), od_score: M(["genes"], "measure", "raw"), counts: M(["cells", "genes"], "measure", "raw") })).field, "counts");
});
