// Presentation of ESTIMATED results. The NaN cases are the point: the compute layer emits NaN for a
// significance value it did not measure, and `NaN ?? 1` is NaN — the nullish default every consumer was
// written with does NOT catch it, so an unguarded volcano renders circles at cy="NaN".
// Run: node --test src/ui/estimated.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { approxNote, withApproxNote, isPlottableP, significanceText } from "./estimated.ts";

test("approxNote: exact results say nothing", () => {
  assert.equal(approxNote({ approx: false, cells: 100, measured: 100 }), "");
  assert.equal(approxNote(null), "");
  assert.equal(approxNote(undefined), "");
});

test("approxNote: an estimate says how much was measured", () => {
  assert.equal(approxNote({ approx: true, cells: 6767, measured: 3036 }), "estimated · 3,036 of 6,767 cells");
});

test("approxNote: falls back to a bare label when the counts are unknown", () => {
  assert.equal(approxNote({ approx: true }), "estimated");
  assert.equal(approxNote({ approx: true, cells: 0, measured: 0 }), "estimated");
});

test("withApproxNote: composes with an existing caption, no stray separator", () => {
  const q = { approx: true, cells: 100, measured: 40 };
  assert.equal(withApproxNote("leiden vs rest", q), "leiden vs rest · estimated · 40 of 100 cells");
  assert.equal(withApproxNote("", q), "estimated · 40 of 100 cells");
  assert.equal(withApproxNote(undefined, q), "estimated · 40 of 100 cells");
  assert.equal(withApproxNote("leiden vs rest", { approx: false }), "leiden vs rest");
  assert.equal(withApproxNote(undefined, { approx: false }), "");
});

test("isPlottableP: NaN is not plottable — and is not caught by ?? ", () => {
  assert.equal(NaN ?? 1, NaN, "precondition: the nullish default does NOT substitute for NaN");
  assert.equal(isPlottableP(NaN), false);
  assert.equal(isPlottableP(undefined), false);
  assert.equal(isPlottableP(null), false);
  assert.equal(isPlottableP(Infinity), false);
});

test("isPlottableP: 0 is not plottable — -log10(0) is Infinity", () => {
  assert.equal(isPlottableP(0), false);
  assert.equal(isPlottableP(-0.5), false);
  assert.equal(isPlottableP(1.5), false, "above 1 is not a probability");
});

test("isPlottableP: ordinary values are", () => {
  assert.equal(isPlottableP(1), true);
  assert.equal(isPlottableP(0.05), true);
  assert.equal(isPlottableP(1e-300), true);
});

test("significanceText: an unmeasured value renders as absent, never as 0 or 1", () => {
  assert.equal(significanceText(NaN), "—");
  assert.equal(significanceText(undefined), "—");
  assert.equal(significanceText(0), "—");
});

test("significanceText: measured values keep their formatting", () => {
  assert.equal(significanceText(0.0001), "1.0e-4");
  assert.equal(significanceText(0.042), "0.042");
  assert.equal(significanceText(1), "1.000");
});
