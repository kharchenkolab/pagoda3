// Unit tests for the code-result validator. Run: `node --test src/agent/codeapi.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { validateComputeResult, buildComputeSnapshot } from "./codeapi.ts";

const N = 5;

// A mock ctx for the shared snapshot builder: 5 cells, one categorical, a couple of resolvable genes.
function snapCtx() {
  return {
    n: N,
    categoricalFields: () => ["cell_type"],
    metaOf: async (_f: string) => ({ kind: "categorical", codes: Int32Array.from([0, 0, 1, 1, 1]), categories: ["A", "B"] }),
    embedding: { data: Float32Array.from([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]) },
    groupings: () => ["cell_type"],
    groupStatsCached: async (_g: string) => ({ groups: ["A", "B"], mean: [[1, 2]], frac: [[0.5, 0.9]], nGenes: 1 }),
    view: {
      genes: async () => [],
      geneCol: async (s: string) => (s === "GHOST" ? null : 1),
      geneExpression: async (_s: string) => ({ values: Float32Array.from([0, 1, 2, 3, 4]) }),
    },
  } as any;
}

test("buildComputeSnapshot: cats + embedding always travel; declared genes resolve; unknowns reported; args + stats pass through", async () => {
  const { snapshot, unknown } = await buildComputeSnapshot(snapCtx(), { genes: ["CD3D", "GHOST"], grouping: "cell_type", args: { thr: 0.4 } });
  assert.deepEqual(Object.keys(snapshot.cats), ["cell_type"]);
  assert.equal(snapshot.embedding.length, 2 * N);
  assert.deepEqual(Object.keys(snapshot.genes), ["CD3D"]);   // GHOST dropped
  assert.deepEqual(unknown, ["GHOST"]);
  assert.deepEqual(snapshot.args, { thr: 0.4 });
  assert.ok(snapshot.stats && snapshot.stats.groups.length === 2);
  assert.equal(snapshot.n, N);
});

test("buildComputeSnapshot: maxGenes caps the declared list (bounds the snapshot for the widget caller)", async () => {
  await assert.rejects(() => buildComputeSnapshot(snapCtx(), { genes: ["A", "B", "C"], maxGenes: 2 }), /too many genes/);
});

test("genes: valid rows pass; bad shapes rejected; junk rows filtered", () => {
  const ok = validateComputeResult({ kind: "genes", rows: [{ symbol: "CD3D", score: 2 }, { symbol: "MS4A1" }], title: "x" }, N);
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.result, { kind: "genes", rows: [{ symbol: "CD3D", score: 2, lfc: undefined }, { symbol: "MS4A1", score: undefined, lfc: undefined }], title: "x" });
  assert.match(validateComputeResult({ kind: "genes", rows: "nope" }, N).error!, /rows: array/);
  assert.match(validateComputeResult({ kind: "genes", rows: [{ score: 1 }] }, N).error!, /no valid rows/);   // no symbol
});

test("values: length must equal n; needs label; non-finite coerced to 0", () => {
  const ok = validateComputeResult({ kind: "values", values: [1, 2, NaN, 4, 5], label: "sig" }, N);
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.result, { kind: "values", values: [1, 2, 0, 4, 5], label: "sig" });
  assert.match(validateComputeResult({ kind: "values", values: [1, 2], label: "x" }, N).error!, /length 2 != number of cells 5/);
  assert.match(validateComputeResult({ kind: "values", values: [1, 2, 3, 4, 5] }, N).error!, /non-empty label/);
  assert.match(validateComputeResult({ kind: "values", values: 7, label: "x" }, N).error!, /values: number\[\]/);
  // accepts a typed array of the right length
  const tv = validateComputeResult({ kind: "values", values: Float32Array.from([1, 2, 3, 4, 5]), label: "t" }, N);
  assert.deepEqual(tv.result, { kind: "values", values: [1, 2, 3, 4, 5], label: "t" });
});

test("note: needs text", () => {
  assert.deepEqual(validateComputeResult({ kind: "note", text: "hi" }, N).result, { kind: "note", text: "hi", title: undefined });
  assert.match(validateComputeResult({ kind: "note", text: "" }, N).error!, /non-empty text/);
});

test("cells: ids filtered to in-range, deduped; empty rejected", () => {
  const ok = validateComputeResult({ kind: "cells", ids: [0, 2, 2, 9, -1, 4], label: "hi" }, N);
  assert.deepEqual(ok.result, { kind: "cells", ids: [0, 2, 4], label: "hi" });   // 9 and -1 dropped, 2 deduped
  assert.match(validateComputeResult({ kind: "cells", ids: [9, 10] }, N).error!, /no valid in-range ids/);
  assert.match(validateComputeResult({ kind: "cells", ids: 3 }, N).error!, /ids: number\[\]/);
});

test("kind + shape guards", () => {
  assert.match(validateComputeResult({ kind: "scatter" }, N).error!, /unknown result kind/);
  assert.match(validateComputeResult(null, N).error!, /must return an object/);
  assert.match(validateComputeResult("hi", N).error!, /must return an object/);
});
