// Unit tests for the widget manifest validator (pure). Run: `node --test src/widget/contract.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { validateManifest } from "./contract.ts";

test("validateManifest: title/height/controls + typed PARAMS; junk filtered", () => {
  const m = validateManifest({
    title: "W", height: 99999,
    controls: [{ id: "go", label: "Go" }, { id: "x" /* no label */ }],
    params: [
      { id: "thr", label: "Threshold", type: "number", value: 5, min: 0, max: 100, step: 1 },
      { id: "mode", label: "Mode", type: "select", value: "a", options: ["a", "b"] },
      { id: "on", label: "On", type: "bool", value: true },
      { id: "bad", label: "Bad", type: "matrix", value: 0 },   // unknown type → dropped
      { label: "noId", type: "number", value: 1 },             // no id → dropped
    ],
  });
  assert.equal(m.title, "W");
  assert.equal(m.height, 2000);   // clamped
  assert.deepEqual(m.controls, [{ id: "go", label: "Go" }]);   // junk control dropped
  assert.equal(m.params!.length, 3);   // bad type + no-id dropped
  assert.deepEqual(m.params![0], { id: "thr", label: "Threshold", type: "number", value: 5, min: 0, max: 100, step: 1 });
  assert.deepEqual(m.params![1], { id: "mode", label: "Mode", type: "select", value: "a", options: ["a", "b"] });
  assert.equal(m.params![2].type, "bool");
});

test("validateManifest: tolerant of empty / missing", () => {
  assert.deepEqual(validateManifest(null), {});
  assert.deepEqual(validateManifest({}), {});
  assert.equal(validateManifest({ params: "nope" }).params, undefined);
});
