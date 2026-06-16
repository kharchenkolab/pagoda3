// Unit tests for applyEdits (widget patch editing). Run: `node --test src/widget/edits.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { applyEdits } from "./edits.ts";

const SRC = "const a = 1;\nconst b = 2;\nfoo(a);\nfoo(b);\n";

test("applies unique str_replace edits (old_str/new_str) in order", () => {
  const r = applyEdits(SRC, [{ old_str: "const a = 1;", new_str: "const a = 10;" }, { old_str: "foo(b)", new_str: "bar(b)" }]);
  assert.equal(r.ok, true);
  assert.equal(r.source, "const a = 10;\nconst b = 2;\nfoo(a);\nbar(b);\n");
  assert.equal(r.applied.length, 2);
});

test("tolerant of adjacent trained spellings (old_string/new_string, old/new)", () => {
  assert.equal(applyEdits(SRC, [{ old_string: "const b = 2;", new_string: "const b = 20;" }]).source, "const a = 1;\nconst b = 20;\nfoo(a);\nfoo(b);\n");
  assert.equal(applyEdits(SRC, [{ old: "const b = 2;", new: "const b = 20;" } as any]).source, "const a = 1;\nconst b = 20;\nfoo(a);\nfoo(b);\n");
});

test("not-found is reported and the edit is atomic (nothing committed)", () => {
  const r = applyEdits(SRC, [{ old_str: "const a = 1;", new_str: "X" }, { old_str: "nope()", new_str: "Y" }]);
  assert.equal(r.ok, false);
  assert.equal(r.source, SRC, "source unchanged when any edit fails");
  assert.match(r.failed[0].why, /not found/);
});

test("ambiguous match (>1) is rejected with a disambiguation hint", () => {
  const r = applyEdits(SRC, [{ old_str: "foo(", new_str: "baz(" }]);   // foo( appears twice
  assert.equal(r.ok, false);
  assert.match(r.failed[0].why, /more than one/);
});

test("empty edit list is a no-op success; new_str=\"\" deletes", () => {
  assert.equal(applyEdits(SRC, []).source, SRC);
  assert.equal(applyEdits(SRC, [{ old_str: "foo(a);\n", new_str: "" }]).source, "const a = 1;\nconst b = 2;\nfoo(b);\n");
});
