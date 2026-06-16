// Unit tests for applyEdits (widget patch editing). Run: `node --test src/widget/edits.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { applyEdits } from "./edits.ts";

const SRC = "const a = 1;\nconst b = 2;\nfoo(a);\nfoo(b);\n";

test("applies unique search/replace edits in order", () => {
  const r = applyEdits(SRC, [{ old: "const a = 1;", new: "const a = 10;" }, { old: "foo(b)", new: "bar(b)" }]);
  assert.equal(r.ok, true);
  assert.equal(r.source, "const a = 10;\nconst b = 2;\nfoo(a);\nbar(b);\n");
  assert.equal(r.applied.length, 2);
});

test("not-found is reported and the edit is atomic (nothing committed)", () => {
  const r = applyEdits(SRC, [{ old: "const a = 1;", new: "X" }, { old: "nope()", new: "Y" }]);
  assert.equal(r.ok, false);
  assert.equal(r.source, SRC, "source unchanged when any edit fails");
  assert.match(r.failed[0].why, /not found/);
});

test("ambiguous match (>1) is rejected with a disambiguation hint", () => {
  const r = applyEdits(SRC, [{ old: "foo(", new: "baz(" }]);   // foo( appears twice
  assert.equal(r.ok, false);
  assert.match(r.failed[0].why, /more than one/);
});

test("empty edit list is a no-op success", () => {
  const r = applyEdits(SRC, []);
  assert.equal(r.ok, true); assert.equal(r.source, SRC);
});
