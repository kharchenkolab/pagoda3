// Unit tests for the pure palette module. Run: `node --test src/render/palettes.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { PALETTES, normalizePalette, paletteNames, setCustomPalette, serializeCustomPalette, restoreCustomPalette } from "./palettes.ts";

test("custom palette: setCustomPalette builds a gradient from stops; serialize/restore round-trips; 'custom' resolves", () => {
  assert.equal(normalizePalette("custom"), "custom");
  assert.equal(setCustomPalette([[0, 0, 0], [255, 0, 0]]), true);
  assert.deepEqual(PALETTES.custom(0), [0, 0, 0]);     // low stop
  assert.deepEqual(PALETTES.custom(1), [255, 0, 0]);   // high stop
  assert.deepEqual(PALETTES.custom(0.5), [128, 0, 0]); // midpoint interpolation
  assert.deepEqual(serializeCustomPalette(), [[0, 0, 0], [255, 0, 0]]);
  assert.equal(setCustomPalette([]), false);           // empty → no-op
  restoreCustomPalette([[10, 20, 30]]);                 // single stop = flat colour
  assert.deepEqual(PALETTES.custom(0.7), [10, 20, 30]);
});

test("normalizePalette accepts spellings/aliases, rejects unknown", () => {
  assert.equal(normalizePalette("red-to-blue"), "rdbu");
  assert.equal(normalizePalette("red to blue"), "rdbu");
  assert.equal(normalizePalette("RedBlue"), "rdbu");
  assert.equal(normalizePalette("RdBu"), "rdbu");
  assert.equal(normalizePalette("viridis"), "viridis");
  assert.equal(normalizePalette("coolwarm"), "bluered");
  assert.equal(normalizePalette("grays"), "greys");
  assert.equal(normalizePalette("nope"), null);
  assert.equal(normalizePalette(undefined as any), null);
});

test("paletteNames includes the canonical set", () => {
  const n = paletteNames();
  for (const k of ["amber", "viridis", "rdbu", "bluered", "blues"]) assert.ok(n.includes(k), `missing ${k}`);
});

test("rdbu runs red(low) → blue(high); amber matches the original ramp endpoints", () => {
  const lo = PALETTES.rdbu(0), hi = PALETTES.rdbu(1);
  assert.ok(lo[0] > lo[2], "rdbu(0) should be reddish (r>b)");
  assert.ok(hi[2] > hi[0], "rdbu(1) should be bluish (b>r)");
  assert.deepEqual(PALETTES.amber(0), [27, 34, 48]);
  assert.deepEqual(PALETTES.amber(1), [224, 164, 88]);
});

test("palettes clamp out-of-range t and return integer rgb", () => {
  const c = PALETTES.viridis(2);   // clamps to 1
  assert.deepEqual(c, PALETTES.viridis(1));
  for (const v of PALETTES.rdbu(0.37)) { assert.ok(Number.isInteger(v) && v >= 0 && v <= 255); }
});
