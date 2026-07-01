import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, strToU8 } from "fflate";
import { parseMtx, detectTriplets, type Entry } from "./tenx.ts";

// 3 genes × 2 cells (10x mtx is genes×cells). Triplets (1-indexed gene cell value):
//   g1c1=5  g2c1=3  g1c2=7  g3c2=2
const MTX = `%%MatrixMarket matrix coordinate integer general
%
3 2 4
1 1 5
2 1 3
1 2 7
3 2 2
`;

test("parseMtx → gene-major CSC (indptr over genes, indices = cells)", () => {
  const r = parseMtx(strToU8(MTX));
  assert.equal(r.nGenes, 3);
  assert.equal(r.nCells, 2);
  assert.deepEqual([...r.csc.indptr], [0, 2, 3, 4]);   // gene0 has 2 entries, gene1 1, gene2 1
  assert.deepEqual([...r.csc.data], [5, 7, 3, 2]);     // gene0: cell0=5,cell1=7 ; gene1: cell0=3 ; gene2: cell1=2
  assert.deepEqual([...r.csc.indices], [0, 1, 0, 1]);
});

test("parseMtx transparently gunzips", () => {
  const r = parseMtx(gzipSync(strToU8(MTX)));
  assert.equal(r.nGenes, 3); assert.deepEqual([...r.csc.data], [5, 7, 3, 2]);
});

test("parseMtx rejects a non-MatrixMarket file", () => {
  assert.throws(() => parseMtx(strToU8("not a matrix\n1 2 3\n")), /MatrixMarket/);
});

const entry = (path: string): Entry => ({ path, read: async () => new Uint8Array() });

test("detectTriplets groups standard + GEO-named + multi-sample", () => {
  // standard 10x in a folder
  assert.equal(detectTriplets(["filtered/matrix.mtx.gz", "filtered/barcodes.tsv.gz", "filtered/features.tsv.gz"].map(entry)).length, 1);
  // GEO flat naming with a GSM prefix — one sample
  const geo1 = detectTriplets(["GSM5747164_matrix.mtx.gz", "GSM5747164_barcodes.tsv.gz", "GSM5747164_features.tsv.gz"].map(entry));
  assert.equal(geo1.length, 1);
  assert.equal(geo1[0].label, "GSM5747164");
  assert.ok(/\.mtx/.test(geo1[0].matrix.path) && geo1[0].tsvs.length === 2);
  // TWO samples side by side → two triplets
  const two = detectTriplets(["GSM1_matrix.mtx.gz", "GSM1_barcodes.tsv.gz", "GSM1_features.tsv.gz",
                              "GSM2_matrix.mtx.gz", "GSM2_barcodes.tsv.gz", "GSM2_genes.tsv.gz"].map(entry));
  assert.equal(two.length, 2);
  // no matrix → no triplet
  assert.equal(detectTriplets(["a/barcodes.tsv", "a/features.tsv"].map(entry)).length, 0);
});

test("detectTriplets handles the REAL GSE192391 multi-sample naming (dot-attached role, many GSMs)", () => {
  // verbatim filenames from GEO GSE192391_RAW (the series Peter named)
  const files = [
    "GSM5746259_MGI0369_1_SLAB-145-0.barcodes.tsv.gz", "GSM5746259_MGI0369_1_SLAB-145-0.features.tsv.gz", "GSM5746259_MGI0369_1_SLAB-145-0.matrix.mtx.gz",
    "GSM5746260_MGI0369_1_SLAB-145-7.barcodes.tsv.gz", "GSM5746260_MGI0369_1_SLAB-145-7.features.tsv.gz", "GSM5746260_MGI0369_1_SLAB-145-7.matrix.mtx.gz",
    "GSM5746261_MGI0369_1_SLAB-154-0.barcodes.tsv.gz", "GSM5746261_MGI0369_1_SLAB-154-0.features.tsv.gz", "GSM5746261_MGI0369_1_SLAB-154-0.matrix.mtx.gz",
  ].map(entry);
  const tris = detectTriplets(files);
  assert.equal(tris.length, 3);   // three distinct samples → the picker lists all three
  assert.deepEqual(tris.map((t) => t.label).sort(), [
    "GSM5746259_MGI0369_1_SLAB-145-0", "GSM5746260_MGI0369_1_SLAB-145-7", "GSM5746261_MGI0369_1_SLAB-154-0",
  ]);
  for (const t of tris) { assert.ok(/\.matrix\.mtx\.gz$/.test(t.matrix.path)); assert.equal(t.tsvs.length, 2); }
});
