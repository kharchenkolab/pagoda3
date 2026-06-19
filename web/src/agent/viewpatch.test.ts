// Unit tests for the pure view-patch reducer. Run: `node --test src/agent/viewpatch.test.ts` (Node strips types).
import { test } from "node:test";
import assert from "node:assert";
import { normalizeViewPatch } from "./viewpatch.ts";
import type { World, NormOp } from "./viewpatch.ts";

// A small fake world: two groupings, a handful of genes (IL17A deliberately absent), two embeddings, and
// panels #4 (Heatmap, already pinning GNLY) and #5 (Embedding).
function makeWorld(): World {
  const values: Record<string, string[]> = {
    leiden: ["0", "1", "2", "3", "4", "5"],
    cell_type: ["B (naive)", "B (memory)", "CD8 T"],
    sample: ["GSM1", "GSM2"],
    condition: ["disease", "control"],
  };
  const genes = new Set(["CD3D", "MS4A1", "IL17RA", "GNLY"]);
  const panels: Record<number, { type: string; genes: string[] }> = {
    4: { type: "Heatmap", genes: ["GNLY"] },
    5: { type: "Embedding", genes: [] },
    6: { type: "Heatmap", genes: [] },
    7: { type: "Embedding", genes: [] },
    8: { type: "Embedding", genes: [] },
  };
  return {
    panelTypes: ["Embedding", "Heatmap", "CompositionBars", "DeTable", "Note"],
    categoricals: ["leiden", "cell_type", "sample", "condition"],
    groupings: ["leiden", "cell_type"],
    valuesOf: (g) => values[g] || [],
    geneExists: (s) => genes.has(s),
    embeddings: ["umap", "umap.unintegrated"],
    panelExists: (id) => id in panels,
    panelType: (id) => panels[id]?.type,
    panelGenes: (id) => panels[id]?.genes || [],
    colormaps: ["amber", "viridis", "rdbu", "bluered", "blues"],
    normalizeColormap: (n) => ({ amber: "amber", viridis: "viridis", rdbu: "rdbu", redblue: "rdbu", redtoblue: "rdbu" } as Record<string, string>)[String(n).toLowerCase().replace(/[\s_-]+/g, "")] || null,
  };
}

const find = (ops: NormOp[], kind: string) => ops.filter((o) => o.kind === kind);

test("global color: valid grouping accepted, bad gene/grouping rejected", () => {
  const w = makeWorld();
  const ok = normalizeViewPatch({ color: "meta:cell_type" }, w);
  assert.deepEqual(find(ok.ops, "color"), [{ kind: "color", handle: "meta:cell_type" }]);
  assert.equal(ok.rejected.length, 0);

  const badGene = normalizeViewPatch({ color: "gene:NOTAGENE" }, w);
  assert.equal(find(badGene.ops, "color").length, 0);
  assert.match(badGene.rejected[0], /unknown gene/);

  const badGroup = normalizeViewPatch({ color: "meta:foo" }, w);
  assert.match(badGroup.rejected[0], /unknown field/);

  const okGene = normalizeViewPatch({ color: "gene:CD3D" }, w);
  assert.equal(find(okGene.ops, "color").length, 1);
  const qc = normalizeViewPatch({ color: "qc:mito" }, w);   // qc/geneset pass without a catalog
  assert.equal(find(qc.ops, "color").length, 1);
});

test("focus set and clearFocus", () => {
  const w = makeWorld();
  const set = normalizeViewPatch({ focus: { dim: "condition", value: "disease" } }, w);
  assert.deepEqual(find(set.ops, "focus"), [{ kind: "focus", dim: "condition", value: "disease", label: "condition = disease" }]);
  // cell-SET focus (a population over several labels) is accepted with a label
  const sset = normalizeViewPatch({ focus: { set: { category: { grouping: "condition", value: "disease" } }, label: "T cells" } }, w);
  assert.deepEqual(find(sset.ops, "focus"), [{ kind: "focus", set: { category: { grouping: "condition", value: "disease" } }, label: "T cells" }]);
  const cleared = normalizeViewPatch({ clearFocus: true }, w);
  assert.deepEqual(find(cleared.ops, "clearFocus"), [{ kind: "clearFocus" }]);
  // clearFocus wins over focus
  const both = normalizeViewPatch({ clearFocus: true, focus: { dim: "leiden", value: "0" } }, w);
  assert.equal(find(both.ops, "focus").length, 0);
  assert.equal(find(both.ops, "clearFocus").length, 1);
  // bad focus field / value rejected
  assert.match(normalizeViewPatch({ focus: { dim: "nope", value: "x" } }, w).rejected[0], /unknown field/);
  assert.match(normalizeViewPatch({ focus: { dim: "condition", value: "nope" } }, w).rejected[0], /not a value of condition/);
});

test("display alpha is clamped; booleans pass through", () => {
  const w = makeWorld();
  const hi = normalizeViewPatch({ display: { alpha: 5 } }, w);
  assert.equal((find(hi.ops, "display")[0] as any).patch.alpha, 1);
  const lo = normalizeViewPatch({ display: { alpha: 0 } }, w);
  assert.equal((find(lo.ops, "display")[0] as any).patch.alpha, 0.02);
  const flags = normalizeViewPatch({ display: { labels: false, legend: true } }, w);
  assert.deepEqual((find(flags.ops, "display")[0] as any).patch, { labels: false, legend: true });
});

test("add panel: valid type with config; unknown type rejected", () => {
  const w = makeWorld();
  const ok = normalizeViewPatch({ panels: [{ add: "Embedding", title: "X", colorBy: "gene:CD3D", embedding: "umap.unintegrated" }] }, w);
  const add = find(ok.ops, "addPanel")[0] as any;
  assert.equal(add.spec.type, "Embedding");
  assert.equal(add.spec.colorBy, "gene:CD3D");
  assert.equal(add.spec.embedding, "umap.unintegrated");

  const bad = normalizeViewPatch({ panels: [{ add: "Sankey" }] }, w);
  assert.equal(find(bad.ops, "addPanel").length, 0);
  assert.match(bad.rejected[0], /unknown panel type/);
});

test("add Heatmap: dotplot + grouping + genes, with unknown gene noted", () => {
  const w = makeWorld();
  const r = normalizeViewPatch({ panels: [{ add: "Heatmap", group: "cell_type", heatMode: "dotplot", genes: ["IL17A", "IL17RA"] }] }, w);
  const spec = (find(r.ops, "addPanel")[0] as any).spec;
  assert.equal(spec.heatMode, "dot");          // dotplot → dot
  assert.equal(spec.group, "cell_type");
  assert.deepEqual(spec.genes, ["IL17A", "IL17RA"]);   // both KEPT (IL17A surfaces as "not in this dataset" in the panel)
  assert.match(r.notes.join(" "), /IL17A/);            // and reported to the agent
});

test("configure Heatmap: heatMode + genes merge with existing", () => {
  const w = makeWorld();
  const merge = normalizeViewPatch({ panels: [{ id: 4, heatMode: "heatmap", genes: ["MS4A1"] }] }, w);
  const cfg = find(merge.ops, "configPanel")[0] as any;
  assert.equal(cfg.id, 4);
  assert.equal(cfg.patch.heatMode, "heat");
  assert.deepEqual(cfg.patch.genes, ["GNLY", "MS4A1"]);    // merged with existing GNLY

  const clear = normalizeViewPatch({ panels: [{ id: 4, clearGenes: true, genes: ["CD3D"] }] }, w);
  assert.deepEqual((find(clear.ops, "configPanel")[0] as any).patch.genes, ["CD3D"]);   // cleared first
});

test("scope: valid resolves; bad grouping/value rejected; clearScope → null", () => {
  const w = makeWorld();
  const ok = normalizeViewPatch({ panels: [{ id: 5, scopeGrouping: "cell_type", scopeValue: "B (naive)" }] }, w);
  assert.deepEqual((find(ok.ops, "configPanel")[0] as any).patch.scope, { grouping: "cell_type", value: "B (naive)" });

  const badVal = normalizeViewPatch({ panels: [{ id: 5, scopeGrouping: "cell_type", scopeValue: "B naive" }] }, w);
  assert.equal(find(badVal.ops, "configPanel").length, 0);
  assert.match(badVal.rejected[0], /not a value of cell_type/);

  const clear = normalizeViewPatch({ panels: [{ id: 5, clearScope: true }] }, w);
  assert.strictEqual((find(clear.ops, "configPanel")[0] as any).patch.scope, null);
});

test("colormap: alias normalized; unknown rejected", () => {
  const w = makeWorld();
  const ok = normalizeViewPatch({ panels: [{ id: 5, colormap: "red-to-blue" }] }, w);
  assert.equal((find(ok.ops, "configPanel")[0] as any).patch.colormap, "rdbu");   // alias → canonical
  const add = normalizeViewPatch({ panels: [{ add: "Embedding", colormap: "viridis" }] }, w);
  assert.equal((find(add.ops, "addPanel")[0] as any).spec.colormap, "viridis");
  const bad = normalizeViewPatch({ panels: [{ id: 5, colormap: "rainbow" }] }, w);
  assert.equal(find(bad.ops, "configPanel").length, 0);
  assert.match(bad.rejected[0], /unknown colormap "rainbow"/);
});

test("heatMode/genes ignored on non-Heatmap panels (noted)", () => {
  const w = makeWorld();
  const r = normalizeViewPatch({ panels: [{ id: 5, genes: ["CD3D"], heatMode: "dotplot" }] }, w);
  assert.equal(find(r.ops, "configPanel").length, 0);       // nothing valid to change
  assert.match(r.notes.join(" "), /only to Heatmap/);
});

test("remove panel: valid id ok, bad id rejected", () => {
  const w = makeWorld();
  const ok = normalizeViewPatch({ panels: [{ id: 5, remove: true }] }, w);
  assert.deepEqual(find(ok.ops, "removePanel"), [{ kind: "removePanel", id: 5 }]);
  const bad = normalizeViewPatch({ panels: [{ id: 99, remove: true }] }, w);
  assert.equal(find(bad.ops, "removePanel").length, 0);
  assert.match(bad.rejected[0], /no panel/);
});

test("configure unknown panel id and empty patch are rejected", () => {
  const w = makeWorld();
  const badId = normalizeViewPatch({ panels: [{ id: 42, colorBy: "gene:CD3D" }] }, w);
  assert.match(badId.rejected[0], /no such panel/);
  const empty = normalizeViewPatch({ panels: [{ id: 5 }] }, w);
  assert.match(empty.rejected[0], /nothing to change/);
});

test("facet: by-field expands to values; defaults to all; bad field/values handled", () => {
  const w = makeWorld();
  const all = normalizeViewPatch({ facet: { by: "condition" } }, w);
  assert.deepEqual(find(all.ops, "facet"), [{ kind: "facet", by: "condition", values: ["disease", "control"], panel: undefined, layout: "auto" }]);

  const subset = normalizeViewPatch({ facet: { by: "condition", values: ["disease"], layout: "stack" } }, w);
  assert.equal(find(subset.ops, "facet").length, 0);   // <2 values → rejected
  assert.match(subset.rejected.join(" "), /need ≥2/);

  const someBad = normalizeViewPatch({ facet: { by: "cell_type", values: ["B (naive)", "B (memory)", "NOPE"] } }, w);
  const op = find(someBad.ops, "facet")[0] as any;
  assert.deepEqual(op.values, ["B (naive)", "B (memory)"]);
  assert.match(someBad.notes.join(" "), /ignored unknown/);

  const badField = normalizeViewPatch({ facet: { by: "nope" } }, w);
  assert.equal(find(badField.ops, "facet").length, 0);
  assert.match(badField.rejected.join(" "), /unknown field/);

  const badPanel = normalizeViewPatch({ facet: { by: "condition", panel: 99 } }, w);
  assert.equal(find(badPanel.ops, "facet").length, 0);
  assert.match(badPanel.rejected.join(" "), /no panel/);
});

test("arrange: rows + columns place existing panels; bad ids / overflow rejected", () => {
  const w = makeWorld();   // panels 4 (Heatmap), 5 (Embedding), 6/7/8 exist
  const rows = normalizeViewPatch({ arrange: { rows: [[4, 5]] } }, w);
  assert.deepEqual(find(rows.ops, "arrange"), [{ kind: "arrange", place: [{ id: 4, col: 0, full: false }, { id: 5, col: 1, full: false }] }]);

  const oneRow = normalizeViewPatch({ arrange: { rows: [[4], [5]] } }, w);   // 1-id rows → full-width stack
  assert.deepEqual((find(oneRow.ops, "arrange")[0] as any).place, [{ id: 4, full: true }, { id: 5, full: true }]);

  const cols = normalizeViewPatch({ arrange: { columns: [[4], [5]] } }, w);  // two columns, one each
  assert.deepEqual((find(cols.ops, "arrange")[0] as any).place, [{ id: 4, col: 0, full: false }, { id: 5, col: 1, full: false }]);

  // THREE columns side by side — no 2-column cap. rows:[[4,5,6]] fans across cols 0/1/2 …
  const three = normalizeViewPatch({ arrange: { rows: [[4, 5, 6]] } }, w);
  assert.deepEqual((find(three.ops, "arrange")[0] as any).place, [{ id: 4, col: 0, full: false }, { id: 5, col: 1, full: false }, { id: 6, col: 2, full: false }]);
  // … and columns:[[4],[5],[6]] is the equivalent three-column form
  const threeCols = normalizeViewPatch({ arrange: { columns: [[4], [5], [6]] } }, w);
  assert.deepEqual((find(threeCols.ops, "arrange")[0] as any).place, [{ id: 4, col: 0, full: false }, { id: 5, col: 1, full: false }, { id: 6, col: 2, full: false }]);
  // a deep column still stacks: columns:[[4,7],[5],[6]] → col 0 holds 4 then 7
  const deepCol = normalizeViewPatch({ arrange: { columns: [[4, 7], [5], [6]] } }, w);
  assert.deepEqual((find(deepCol.ops, "arrange")[0] as any).place, [{ id: 4, col: 0, full: false }, { id: 7, col: 0, full: false }, { id: 5, col: 1, full: false }, { id: 6, col: 2, full: false }]);

  // beyond MAX_COLS (4) is the real ceiling now — five across / five columns is rejected
  assert.match(normalizeViewPatch({ arrange: { rows: [[4, 5, 6, 7, 8]] } }, w).rejected.join(" "), /at most 4 panels/);
  assert.match(normalizeViewPatch({ arrange: { columns: [[4], [5], [6], [7], [8]] } }, w).rejected.join(" "), /at most 4 columns/);
  assert.match(normalizeViewPatch({ arrange: { rows: [[4, 4]] } }, w).rejected.join(" "), /more than once/);
  assert.match(normalizeViewPatch({ arrange: { rows: [[404]] } }, w).rejected.join(" "), /unknown panel/);
});

test("panel col pin accepts a third column (clamped to MAX_COLS)", () => {
  const w = makeWorld();
  const third = normalizeViewPatch({ panels: [{ id: 5, col: 2 }] }, w);
  assert.deepEqual(find(third.ops, "configPanel"), [{ kind: "configPanel", id: 5, patch: { col: 2 } }]);
  const clamped = normalizeViewPatch({ panels: [{ id: 5, col: 99 }] }, w);   // absurd pin clamps, doesn't explode
  assert.equal((find(clamped.ops, "configPanel")[0] as any).patch.col, 3);
});

test("a compound patch yields ops in order with no rejections", () => {
  const w = makeWorld();
  const r = normalizeViewPatch({
    color: "meta:cell_type",
    display: { alpha: 0.5 },
    panels: [
      { add: "Heatmap", group: "cell_type", heatMode: "dotplot" },
      { id: 5, colorBy: "gene:MS4A1" },
    ],
  }, w);
  assert.equal(r.rejected.length, 0);
  assert.deepEqual(r.ops.map((o) => o.kind), ["color", "display", "addPanel", "configPanel"]);
});
