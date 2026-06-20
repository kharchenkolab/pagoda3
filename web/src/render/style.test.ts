// Unit tests for the per-panel style spec (resolver + merge + clamp). Run: `node --test src/render/style.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { defaultEmbeddingStyle, deepMerge, resolveEmbeddingStyle, clampStyle, styleSchema, describeStyle } from "./style.ts";

test("defaults are theme-aware; un-patched render is the former literals", () => {
  const dark = defaultEmbeddingStyle(true), light = defaultEmbeddingStyle(false);
  assert.equal(dark.point.radius, 2.4);          // the old inline literal
  assert.equal(dark.point.opacity, 0.7);
  assert.equal(dark.label.fontSize, 12.5);
  assert.equal(dark.fit.pad, 0.86);
  assert.deepEqual(dark.label.textColor, [240, 244, 250, 255]);   // theme split
  assert.deepEqual(light.label.textColor, [38, 50, 58, 255]);
});

test("deepMerge: nested override, arrays + primitives replace wholesale", () => {
  const base = { point: { radius: 2.4, opacity: 0.7 }, label: { padding: [5, 2] } };
  const merged = deepMerge(base, { point: { radius: 5 }, label: { padding: [1, 1] } });
  assert.deepEqual(merged, { point: { radius: 5, opacity: 0.7 }, label: { padding: [1, 1] } });   // radius overridden, opacity kept, array replaced
  assert.equal(deepMerge(base, null), base);   // no-op for nullish patch
});

test("resolveEmbeddingStyle: layers apply in order (later wins), null layers skipped", () => {
  const s = resolveEmbeddingStyle(true, { point: { opacity: 0.5 } }, null, { point: { opacity: 0.9, radius: 4 } });
  assert.equal(s.point.opacity, 0.9);   // last layer wins
  assert.equal(s.point.radius, 4);
  assert.equal(s.label.fontSize, 12.5);   // untouched → default
});

test("clampStyle: known numerics clamped to range; unknown numeric noted but kept; strings/bools pass", () => {
  const r = clampStyle("Embedding", { point: { radius: 999, opacity: 5 }, label: { show: false, fontSize: 1, fontFamily: "serif" }, point2: { wat: 3 } });
  assert.equal(r.clean.point.radius, 20);     // clamped to max
  assert.equal(r.clean.point.opacity, 1);     // clamped
  assert.equal(r.clean.label.fontSize, 5);    // clamped to min
  assert.equal(r.clean.label.show, false);    // bool passes
  assert.equal(r.clean.label.fontFamily, "serif");   // string passes
  assert.equal(r.clean.point2.wat, 3);        // unknown kept
  assert.ok(r.notes.some((n) => /point2\.wat/.test(n)));   // …but noted as unvalidated
});

test("describeStyle: flat rows with current (from resolved) + default + range; unknown panel → []", () => {
  const resolved = resolveEmbeddingStyle(true, { point: { radius: 6 } });   // radius overridden, rest default
  const rows = describeStyle("Embedding", true, resolved);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(byKey["point.radius"], { key: "point.radius", current: 6, default: 2.4, range: [0.3, 20] });   // current reflects the override; default + range from schema
  assert.equal(byKey["point.opacity"].current, 0.7);   // untouched → default value as current
  assert.equal(byKey["label.show"].current, true);     // bool leaf, no range
  assert.ok(rows.length > 15);                         // the whole surface is enumerated
  assert.deepEqual(describeStyle("Nope", true), []);
});

test("styleSchema: Embedding describable; unknown panel → null", () => {
  const sc = styleSchema("Embedding");
  assert.ok(sc && sc.ranges["point.radius"] && sc.defaults.point.radius === 2.4);
  assert.equal(styleSchema("Nope"), null);
});
