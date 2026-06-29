// Unit test for the gene-set doc parser. Run: `node --test src/compute/genesets.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { parseGeneSetDoc } from "./genesets.ts";

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
