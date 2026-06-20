// The Volcano + Box panel style descriptors (pure). Run: `node --test src/ui/volcano.style.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { defaultVolcanoStyle, VOLCANO_STYLE } from "./volcano.style.ts";
import { defaultBoxStyle, BOX_STYLE } from "./box.style.ts";
import { getStyle, clampStyle } from "../render/style.ts";

test("volcano: defaults === former literals; self-registers; clamps", () => {
  const d = defaultVolcanoStyle(true);
  assert.deepEqual([d.thresh.lfc, d.thresh.p], [1, 0.05]);
  assert.equal(d.dot.radius, 3.4);
  assert.equal(d.label.lfc, 1.4);
  assert.deepEqual([d.axis.xMax, d.axis.yMax], [3, 5]);
  assert.equal(getStyle("Volcano"), VOLCANO_STYLE);
  assert.equal(clampStyle(VOLCANO_STYLE, { thresh: { lfc: 99 } }).clean.thresh.lfc, 5);
});

test("box: defaults === former literals; self-registers; clamps", () => {
  const d = defaultBoxStyle(true);
  assert.deepEqual([d.dot.radius, d.dot.opacity, d.dot.maxPer], [2, 0.4, 60]);
  assert.equal(d.mean.width, 2.4);
  assert.equal(getStyle("BoxBySample"), BOX_STYLE);
  assert.equal(clampStyle(BOX_STYLE, { dot: { opacity: 9 } }).clean.dot.opacity, 1);
});
