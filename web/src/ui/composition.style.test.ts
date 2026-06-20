// The CompositionBars panel's style descriptor (pure). Run: `node --test src/ui/composition.style.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { defaultCompositionStyle, COMPOSITION_STYLE } from "./composition.style.ts";
import { getStyle, clampStyle } from "../render/style.ts";

test("defaults === former literals; self-registers; clamps through the protocol", () => {
  const d = defaultCompositionStyle(true);
  assert.deepEqual([d.bar.maxWidth, d.bar.gap], [64, 8]);
  assert.deepEqual([d.ribbon.selOpacity, d.ribbon.hovOpacity], [0.42, 0.16]);
  assert.equal(d.axis.font, 8);
  assert.equal(getStyle("CompositionBars"), COMPOSITION_STYLE);
  assert.equal(clampStyle(COMPOSITION_STYLE, { bar: { maxWidth: 999 } }).clean.bar.maxWidth, 200);   // clamped
});
