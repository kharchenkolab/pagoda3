// Unit tests for the app WidgetHost's pure mappers (no DOM/app). Run: `node --test src/widget/apphost.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { selToInfo, widgetSelToRef, fieldsInfo } from "./apphost.ts";

test("selToInfo: EntityRef → selection descriptor (count, never ids)", () => {
  assert.equal(selToInfo(null, () => 0), null);
  assert.deepEqual(selToInfo({ kind: "cells", ids: Int32Array.of(3, 4, 5) }, () => 999), { kind: "cells", count: 3 });
  assert.deepEqual(
    selToInfo({ kind: "category", grouping: "cell_type", value: "NK" }, (r: any) => r.value === "NK" ? 42 : 0),
    { kind: "category", grouping: "cell_type", value: "NK", count: 42 });
});

test("widgetSelToRef: widget selection arg → EntityRef", () => {
  assert.equal(widgetSelToRef(null), null);
  assert.equal(widgetSelToRef({}), null);
  const cells = widgetSelToRef({ cells: [1, 2, 3] }) as any;
  assert.equal(cells.kind, "cells"); assert.ok(cells.ids instanceof Int32Array); assert.deepEqual(Array.from(cells.ids), [1, 2, 3]);
  assert.deepEqual(widgetSelToRef({ category: { grouping: "g", value: "v" } }), { kind: "category", grouping: "g", value: "v" });
});

test("fieldsInfo: split metadataFields into categorical/numeric name lists", () => {
  const out = fieldsInfo([
    { name: "cell_type", kind: "categorical" }, { name: "mito", kind: "numeric" },
    { name: "leiden", kind: "categorical" }, { name: "n_umi", kind: "numeric" },
  ]);
  assert.deepEqual(out, { categorical: ["cell_type", "leiden"], numeric: ["mito", "n_umi"] });
});
