// The Heatmap panel's style descriptor (pure). Run: `node --test src/ui/heatmap.style.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { defaultHeatmapStyle, HEATMAP_STYLE } from "./heatmap.style.ts";
import { getStyle, clampStyle, describeStyle } from "../render/style.ts";

test("defaults === former inline literals; theme-aware ramp", () => {
  const d = defaultHeatmapStyle(true), light = defaultHeatmapStyle(false);
  assert.equal(d.dot.sizeScale, 1);
  assert.equal(d.dot.minRadius, 0.5);
  assert.deepEqual([d.cell.colMin, d.cell.colMax, d.cell.rowMin, d.cell.rowMax], [6, 40, 7, 26]);
  assert.deepEqual([d.font.floor, d.font.max], [5, 9]);
  assert.deepEqual(d.ramp.hi, [224, 164, 88]);
  assert.deepEqual(light.ramp.hi, [186, 96, 22]);   // theme split
  assert.equal(d.highlight.selOpacity, 0.22);
});

test("self-registers as 'Heatmap'; clamp + describe go through the generic protocol", () => {
  assert.equal(getStyle("Heatmap"), HEATMAP_STYLE);
  assert.equal(clampStyle(HEATMAP_STYLE, { dot: { sizeScale: 99 } }).clean.dot.sizeScale, 3);   // clamped to range max
  const rows = describeStyle(HEATMAP_STYLE, true, defaultHeatmapStyle(true));
  assert.ok(rows.find((r) => r.key === "dot.sizeScale" && r.range![1] === 3));
});
