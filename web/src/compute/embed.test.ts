import { test } from "node:test";
import assert from "node:assert";
import { computeEmbedding } from "./embed.ts";

// Build a CSC (gene-major) from a dense generator
function csc(ncells: number, ngenes: number, val: (c: number, g: number) => number) {
  const data: number[] = [], indices: number[] = [], indptr: number[] = [0];
  for (let g = 0; g < ngenes; g++) { for (let c = 0; c < ncells; c++) { const v = val(c, g); if (v) { data.push(v); indices.push(c); } } indptr.push(data.length); }
  return { data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr) };
}

test("computeEmbedding: two clear clusters separate, and the layout is deterministic", async () => {
  // 80 cells, 30 genes: A (0..39) high in genes 0..9, B (40..79) high in genes 10..19 (+ small structured noise)
  const ncells = 80, ngenes = 30;
  const counts = csc(ncells, ngenes, (c, g) => {
    const A = c < 40; let base = 1;
    if (A && g < 10) base = 20; else if (!A && g >= 10 && g < 20) base = 20;
    return base + ((c * 7 + g * 13) % 3);
  });

  const a = await computeEmbedding(counts, ncells, ngenes, { nHVG: 30, nPC: 10 });
  const b = await computeEmbedding(counts, ncells, ngenes, { nHVG: 30, nPC: 10 });

  // seeded → byte-identical across runs
  assert.deepEqual(Array.from(a.umap), Array.from(b.umap));
  assert.equal(a.umap.length, ncells * 2);

  // the two known clusters should be farther apart than they are internally spread
  const cent = (s: number, e: number): [number, number] => { let x = 0, y = 0; for (let c = s; c < e; c++) { x += a.umap[c * 2]; y += a.umap[c * 2 + 1]; } return [x / (e - s), y / (e - s)]; };
  const within = (s: number, e: number, ct: [number, number]) => { let d = 0; for (let c = s; c < e; c++) d += Math.hypot(a.umap[c * 2] - ct[0], a.umap[c * 2 + 1] - ct[1]); return d / (e - s); };
  const cA = cent(0, 40), cB = cent(40, 80);
  const between = Math.hypot(cA[0] - cB[0], cA[1] - cB[1]);
  const spread = (within(0, 40, cA) + within(40, 80, cB)) / 2;
  assert.ok(between > spread * 2, `clusters should separate: between=${between.toFixed(2)} spread=${spread.toFixed(2)}`);

  // eigenvalues are sorted descending (a real PCA spectrum)
  for (let i = 1; i < a.eigs.length; i++) assert.ok(a.eigs[i] <= a.eigs[i - 1] + 1e-6);
});
