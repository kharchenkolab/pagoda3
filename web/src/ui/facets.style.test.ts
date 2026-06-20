// The MetadataFacets panel's style descriptor (pure). Run: `node --test src/ui/facets.style.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { defaultFacetsStyle, FACETS_STYLE } from "./facets.style.ts";
import { getStyle, clampStyle } from "../render/style.ts";

test("default bins === former literal; self-registers; clamped through the protocol", () => {
  assert.equal(defaultFacetsStyle(true).hist.bins, 28);
  assert.equal(getStyle("MetadataFacets"), FACETS_STYLE);
  assert.equal(clampStyle(FACETS_STYLE, { hist: { bins: 999 } }).clean.hist.bins, 100);   // clamped to max
  assert.equal(clampStyle(FACETS_STYLE, { hist: { bins: 1 } }).clean.hist.bins, 4);        // clamped to min
});
