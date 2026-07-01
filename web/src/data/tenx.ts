// 10x "triplet" (MatrixMarket) matrices: matrix.mtx(.gz) + barcodes.tsv(.gz) + features.tsv/genes.tsv(.gz),
// dropped as a folder or a zip — the common raw GEO format. The .mtx is genes×cells (transposed vs AnnData);
// we build the store's gene-major CSC directly. Which file is which is auto-detected from the mtx header dims
// (so oddly-named GEO triplets work: the .tsv with nCells lines = barcodes, nGenes lines = features), with
// filename hints as a fast path. A folder can hold several samples → detectTriplets returns them all (the caller
// picks). Gene labels use the SYMBOL column (col 2 of features/genes.tsv).
import { gunzipSync, strFromU8 } from "fflate";
import { type DatasetSpec, type AxisSpec, type FieldSpec } from "../../../../lstar/js/core/writer.ts";
import type { LstarStore } from "./store.ts";
import type { OpenProgress } from "../ui/loading.ts";
import { assertSparseOk } from "./h5adcheck.ts";
import { finalizeSpec } from "./intake.ts";

export interface Entry { path: string; read: () => Promise<Uint8Array>; }
export interface Triplet { key: string; label: string; matrix: Entry; tsvs: Entry[]; }

const ungz = (b: Uint8Array): Uint8Array => (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) ? gunzipSync(b) : b;
const base = (p: string) => p.replace(/^.*\//, "");
const ROLE_SUFFIX = /[_.]?(matrix\.mtx|barcodes\.tsv|features\.tsv|genes\.tsv)(\.gz)?$/i;

/** MatrixMarket coordinate matrix (10x: genes×cells) → the store's gene-major CSC (indptr over genes, indices
 *  = cells). Two passes over the text so no per-triplet arrays are kept. Gunzips if needed. */
export function parseMtx(raw: Uint8Array): { nGenes: number; nCells: number; csc: { data: Float32Array; indices: Int32Array; indptr: Int32Array } } {
  const t = strFromU8(ungz(raw)); const N = t.length; let i = 0;
  let field = "integer";
  { let j = 0; while (j < N && t[j] !== "\n") j++; const head = t.slice(0, j).toLowerCase();
    if (!head.includes("matrixmarket") || !head.includes("coordinate")) throw new Error("Not a MatrixMarket (.mtx) file.");
    const m = head.match(/coordinate\s+(\w+)/); if (m) field = m[1]; i = j + 1; }
  while (i < N && t[i] === "%") { while (i < N && t[i] !== "\n") i++; i++; }   // skip comment lines
  const ws = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
  const readInt = () => { while (i < N && ws(t.charCodeAt(i))) i++; let v = 0; while (i < N) { const c = t.charCodeAt(i); if (c >= 48 && c <= 57) { v = v * 10 + (c - 48); i++; } else break; } return v; };
  const readTok = () => { while (i < N && ws(t.charCodeAt(i))) i++; const s = i; while (i < N && !ws(t.charCodeAt(i))) i++; return t.slice(s, i); };
  const nGenes = readInt(), nCells = readInt(), nnz = readInt();
  if (!(nGenes > 0 && nCells > 0 && nnz >= 0)) throw new Error("Malformed .mtx header.");
  const pattern = field === "pattern";
  const bodyStart = i;
  const geneCount = new Int32Array(nGenes);
  for (let k = 0; k < nnz; k++) { const r = readInt(); readInt(); if (!pattern) readTok(); if (r >= 1 && r <= nGenes) geneCount[r - 1]++; }
  const indptr = new Int32Array(nGenes + 1); for (let g = 0; g < nGenes; g++) indptr[g + 1] = indptr[g] + geneCount[g];
  const data = new Float32Array(indptr[nGenes]), indices = new Int32Array(indptr[nGenes]);
  const wpos = Int32Array.from(indptr.subarray(0, nGenes));
  i = bodyStart;
  for (let k = 0; k < nnz; k++) { const r = readInt() - 1, c = readInt() - 1; const v = pattern ? 1 : Number(readTok());
    if (r >= 0 && r < nGenes && c >= 0 && c < nCells) { const w = wpos[r]++; data[w] = v; indices[w] = c; } }
  return { nGenes, nCells, csc: { data, indices, indptr } };
}

const tsvLines = (raw: Uint8Array): string[] => { const t = strFromU8(ungz(raw)).replace(/\n+$/, ""); return t ? t.split("\n") : []; };
const tsvCol = (lines: string[], col: number): string[] => lines.map((l) => { const p = l.split("\t"); return (p[col] ?? p[0] ?? "").trim(); });

/** Group a flat list of files into 10x samples (a matrix + its two tsv siblings), keyed by the shared
 *  directory+prefix. Skips groups that don't have a matrix and ≥2 tsvs. */
export function detectTriplets(entries: Entry[]): Triplet[] {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!ROLE_SUFFIX.test(e.path)) continue;
    const key = e.path.replace(ROLE_SUFFIX, "");
    (groups.get(key) || groups.set(key, []).get(key)!).push(e);
  }
  const out: Triplet[] = [];
  for (const [key, es] of groups) {
    const matrix = es.find((e) => /\.mtx(\.gz)?$/i.test(e.path));
    const tsvs = es.filter((e) => /\.tsv(\.gz)?$/i.test(e.path));
    if (matrix && tsvs.length >= 2) out.push({ key, label: base(key).replace(/[_.]$/, "") || base(key.replace(/\/$/, "")) || "sample", matrix, tsvs });
  }
  return out;
}

/** Read one detected triplet into a store: parse the mtx, resolve barcodes-vs-features (by header dims, then
 *  by name), build a gene-major-CSC spec, and finalize (QC → embed → markers). */
export async function openTriplet(tri: Triplet, progress?: OpenProgress, force = false): Promise<LstarStore> {
  progress?.stage("Reading matrix…");
  const { nGenes, nCells, csc } = parseMtx(await tri.matrix.read());
  progress?.stage("Reading barcodes + features…");
  const parsed = await Promise.all(tri.tsvs.map(async (e) => ({ e, lines: tsvLines(await e.read()) })));
  // barcodes has nCells lines, features has nGenes lines; fall back to filename hints if the dims are ambiguous
  let bc = parsed.find((p) => p.lines.length === nCells) || parsed.find((p) => /barcode/i.test(p.e.path));
  let ft = parsed.find((p) => p.lines.length === nGenes) || parsed.find((p) => /feature|gene/i.test(p.e.path));
  if (bc && ft && bc.e === ft.e) ft = parsed.find((p) => p.e !== bc!.e);   // don't let one file fill both roles
  if (!bc) bc = parsed.find((p) => p !== ft);
  if (!ft) ft = parsed.find((p) => p !== bc);
  if (!bc || !ft) throw new Error("Couldn't identify the barcodes + features files for this matrix.");
  const barcodes = tsvCol(bc.lines, 0);
  const genes = tsvCol(ft.lines, ft.lines[0]?.includes("\t") ? 1 : 0);   // col 2 = symbol when present, else the single column
  assertSparseOk(csc, nCells, nGenes);
  const axes: Record<string, AxisSpec> = {
    cells: { labels: barcodes.length === nCells ? barcodes : Array.from({ length: nCells }, (_, i) => "cell" + i), role: "observation" },
    genes: { labels: genes.length === nGenes ? genes : Array.from({ length: nGenes }, (_, i) => "gene" + i), role: "feature" },
  };
  const fields: Record<string, FieldSpec> = {
    counts: { role: "measure", span: ["cells", "genes"], encoding: "csc", state: "raw", shape: [nCells, nGenes], data: csc.data, indices: csc.indices, indptr: csc.indptr } as any,
  };
  return finalizeSpec({ kind: "sample", axes, fields, profiles: [] }, progress, { force });
}
