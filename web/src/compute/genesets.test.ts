// Unit tests for the gene-set collection registry. Run: `node --test src/compute/genesets.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { parseGeneSetDoc, registerCustomCollection, listCollections, loadCollection, clearCustomCollections, parseGmt, serializeCustomCollections, restoreCustomCollections, customCollections } from "./genesets.ts";

test("parseGeneSetDoc: builds pathway array + union gene space; drops empty sets", () => {
  const db = parseGeneSetDoc(JSON.stringify({
    source: "Reactome", organism: "human",
    pathways: { "R-1": { name: "alpha", genes: ["A", "B", "C"] }, "R-2": { name: "beta", genes: ["B", "D"] }, "R-3": { name: "empty", genes: [] } },
  }));
  assert.equal(db.nPathways, 2);                                  // empty set dropped
  assert.deepEqual([...db.geneSpace].sort(), ["A", "B", "C", "D"]);
  assert.equal(db.pathways.find((p) => p.id === "R-1")!.name, "alpha");
  assert.equal(db.organism, "human");
});

test("parseGeneSetDoc: manifest meta (id/label/source/split) overrides the doc; else derives a default id", () => {
  const raw = JSON.stringify({ source: "GO", organism: "mouse", pathways: { "GO:1": { name: "x", genes: ["a"] } } });
  const withMeta = parseGeneSetDoc(raw, { id: "go_bp_mouse", label: "GO:BP", source: "GO", split: "BP", organism: "mouse" });
  assert.equal(withMeta.id, "go_bp_mouse"); assert.equal(withMeta.label, "GO:BP"); assert.equal(withMeta.split, "BP");
  const bare = parseGeneSetDoc(JSON.stringify({ source: "WikiPathways", organism: "human", pathways: { p: { name: "n", genes: ["a"] } } }));
  assert.equal(bare.id, "wikipathways_human");                     // derived <source>_<organism> when no meta/id
  assert.equal(bare.label, "WikiPathways");
});

test("registerCustomCollection: a session collection shows in listCollections + loads by id", async () => {
  clearCustomCollections();
  const db = parseGeneSetDoc(JSON.stringify({ pathways: { S1: { name: "sig", genes: ["A", "B"] } } }), { id: "custom:mine", label: "My sig", source: "Custom", organism: "human" });
  registerCustomCollection(db);
  const list = await listCollections();
  const mine = list.find((c) => c.id === "custom:mine");
  assert.ok(mine && mine.custom === true && mine.source === "Custom");
  const loaded = await loadCollection("custom:mine");             // resolves from the in-memory registry, no fetch
  assert.equal(loaded.nPathways, 1); assert.deepEqual([...loaded.geneSpace].sort(), ["A", "B"]);
  clearCustomCollections();
});

test("parseGmt: name⇥desc⇥genes → a Custom collection; comment/blank lines + empty sets dropped", () => {
  const gmt = ["MY_SIG\tmy description\tTP53\tBRCA1\tEGFR", "# comment", "", "EMPTY\tdesc", "OTHER\t\tCD8A\tCD4"].join("\n");
  const db = parseGmt(gmt, { name: "My panel.gmt", organism: "human" });
  assert.equal(db.source, "Custom"); assert.equal(db.organism, "human"); assert.match(db.id, /^custom:/);
  assert.equal(db.nPathways, 2);                                   // EMPTY (no genes) dropped
  assert.deepEqual(db.pathways.find((p) => p.id === "MY_SIG")!.genes, ["TP53", "BRCA1", "EGFR"]);
  assert.ok(db.geneSpace.has("CD8A"));
});

test("custom collections round-trip through serialize/restore (session persistence)", () => {
  clearCustomCollections();
  registerCustomCollection(parseGmt("S\tx\tA\tB\tC", { name: "sig" }));
  const ser = serializeCustomCollections();
  clearCustomCollections(); assert.equal(customCollections().length, 0);
  restoreCustomCollections(ser);
  const back = customCollections();
  assert.equal(back.length, 1); assert.equal(back[0].label, "sig"); assert.equal(back[0].nPathways, 1);
  assert.deepEqual([...back[0].geneSpace].sort(), ["A", "B", "C"]);
  clearCustomCollections();
});
