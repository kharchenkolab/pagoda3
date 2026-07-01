import { test } from "node:test";
import assert from "node:assert/strict";
import { applyQCFilter } from "./qc.ts";

// A 4-cell × 4-gene gene-major CSC (columns = genes, indices = cell rows):
//   gene0: cells 0,1,2 (vals 5,1,3)   gene1: cells 0,2,3 (2,4,6)
//   gene2: cells 0,2,3 (7,8,9)        gene3: cell 2 (2)
// n_genes per cell: c0=3, c1=1, c2=4, c3=2 ; n_counts: c0=14, c1=1, c2=17, c3=15
// cells per gene:  g0=3, g1=3, g2=3, g3=1
function makeSpec() {
  return {
    kind: "sample",
    axes: {
      cells: { labels: ["c0", "c1", "c2", "c3"], role: "observation" },
      genes: { labels: ["g0", "g1", "g2", "g3"], role: "feature" },
    },
    fields: {
      counts: { role: "measure", span: ["cells", "genes"], encoding: "csc", shape: [4, 4],
        data: Float32Array.from([5, 1, 3, 2, 4, 6, 7, 8, 9, 2]),
        indices: Int32Array.from([0, 1, 2, 0, 2, 3, 0, 2, 3, 2]),
        indptr: Int32Array.from([0, 3, 6, 9, 10]) },
      batch: { role: "label", span: ["cells"], encoding: "utf8", values: ["A", "B", "A", "C"] },
      gene_type: { role: "label", span: ["genes"], encoding: "utf8", values: ["x", "y", "z", "w"] },
    },
  } as any;
}

test("applyQCFilter drops low-gene cells + low-cell genes and re-indexes the CSC", () => {
  const spec = makeSpec();
  const rep = applyQCFilter(spec, /*minGenes*/ 2, /*minCells*/ 2)!;
  assert.equal(rep.droppedCells, 1);   // cell1 (1 gene)
  assert.equal(rep.droppedGenes, 1);   // gene3 (1 cell)
  assert.equal(rep.keptCells, 3);
  assert.equal(rep.keptGenes, 3);

  const cf = spec.fields.counts;
  assert.deepEqual([...cf.shape], [3, 3]);
  // kept genes g0,g1,g2 as columns; cells re-indexed 0→0, 2→1, 3→2 (cell1 gone)
  assert.deepEqual([...cf.indptr], [0, 2, 5, 8]);
  assert.deepEqual([...cf.data], [5, 3, 2, 4, 6, 7, 8, 9]);
  assert.deepEqual([...cf.indices], [0, 1, 0, 1, 2, 0, 1, 2]);

  // axis labels + fields subset to kept cells/genes
  assert.deepEqual(spec.axes.cells.labels, ["c0", "c2", "c3"]);
  assert.deepEqual(spec.axes.genes.labels, ["g0", "g1", "g2"]);
  assert.deepEqual(spec.fields.batch.values, ["A", "A", "C"]);       // cell-spanning
  assert.deepEqual(spec.fields.gene_type.values, ["x", "y", "z"]);   // gene-spanning

  // QC covariates recorded for the kept cells
  assert.deepEqual([...spec.fields.n_genes.data], [3, 4, 2]);
  assert.deepEqual([...spec.fields.n_counts.data], [14, 17, 15]);
});

test("applyQCFilter is a no-op report when nothing fails the thresholds", () => {
  const spec = makeSpec();
  const rep = applyQCFilter(spec, 1, 1)!;
  assert.equal(rep.droppedCells, 0);
  assert.equal(rep.droppedGenes, 0);
  assert.deepEqual([...spec.fields.counts.shape], [4, 4]);   // untouched
  assert.equal(spec.fields.n_genes, undefined);              // no mutation on a clean pass
});

test("applyQCFilter skips (no mutation) rather than emptying the matrix", () => {
  const spec = makeSpec();
  const rep = applyQCFilter(spec, /*minGenes*/ 100, 1)!;   // no cell has 100 genes
  assert.equal(rep.skipped, true);
  assert.deepEqual([...spec.fields.counts.shape], [4, 4]);   // untouched
  assert.deepEqual(spec.axes.cells.labels, ["c0", "c1", "c2", "c3"]);
});
