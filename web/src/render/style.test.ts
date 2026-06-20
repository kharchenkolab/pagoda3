// Unit tests for the GENERIC style protocol (registry + merge + resolve + clamp + describe) — exercised with a MOCK
// descriptor, so it tests the protocol with no knowledge of any real panel. Run: `node --test src/render/style.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { registerStyle, getStyle, styledTypes, deepMerge, resolveStyle, clampStyle, describeStyle, type StyleDescriptor } from "./style.ts";

const MOCK: StyleDescriptor = {
  defaults: (dark: boolean) => ({ point: { radius: 2, opacity: 0.7 }, label: { weight: dark ? 700 : 400, show: true, padding: [5, 2] } }),
  ranges: { "point.radius": [0.5, 10], "point.opacity": [0, 1], "label.weight": [100, 900] },
  fromDisplay: (d: any) => (d && d.alpha != null ? { point: { opacity: d.alpha } } : {}),
};
registerStyle("Mock", MOCK);

test("registry: a panel registers + is looked up by type; unknown → null", () => {
  assert.equal(getStyle("Mock"), MOCK);
  assert.equal(getStyle("Nope"), null);
  assert.ok(styledTypes().includes("Mock"));
});

test("deepMerge: nested override; arrays + primitives replace; undefined skipped", () => {
  const merged = deepMerge({ point: { radius: 2, opacity: 0.7 }, label: { padding: [5, 2] } }, { point: { radius: 5, opacity: undefined }, label: { padding: [1, 1] } });
  assert.deepEqual(merged, { point: { radius: 5, opacity: 0.7 }, label: { padding: [1, 1] } });   // radius set, opacity kept (undefined skipped), array replaced
});

test("resolveStyle: descriptor defaults (theme) ← layers in order; null layers skipped", () => {
  const s = resolveStyle(MOCK, true, MOCK.fromDisplay!({ alpha: 0.3 }), null, { point: { radius: 4 } });
  assert.equal(s.point.opacity, 0.3);   // display alias
  assert.equal(s.point.radius, 4);      // later layer wins
  assert.equal(s.label.weight, 700);    // theme default (dark)
  assert.equal(resolveStyle(MOCK, false, null).label.weight, 400);   // light theme default
});

test("clampStyle: known numerics clamped; unknown numeric noted but kept; strings/bools pass; null desc → pass-through", () => {
  const r = clampStyle(MOCK, { point: { radius: 999 }, label: { show: false, weight: 50 }, extra: { wat: 3 } });
  assert.equal(r.clean.point.radius, 10);   // clamped to max
  assert.equal(r.clean.label.weight, 100);  // clamped to min
  assert.equal(r.clean.label.show, false);
  assert.equal(r.clean.extra.wat, 3);
  assert.ok(r.notes.some((n) => /extra\.wat/.test(n)));
  assert.deepEqual(clampStyle(null, { a: 1 }).clean, { a: 1 });   // null descriptor → unchanged
});

test("describeStyle: flat rows current(from resolved)+default+range; null desc → []", () => {
  const resolved = resolveStyle(MOCK, true, { point: { radius: 6 } });
  const byKey = Object.fromEntries(describeStyle(MOCK, true, resolved).map((r) => [r.key, r]));
  assert.deepEqual(byKey["point.radius"], { key: "point.radius", current: 6, default: 2, range: [0.5, 10] });
  assert.equal(byKey["point.opacity"].current, 0.7);   // untouched → default as current
  assert.equal(byKey["label.show"].current, true);     // bool leaf, no range
  assert.deepEqual(describeStyle(null, true), []);
});
