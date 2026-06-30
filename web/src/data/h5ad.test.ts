import { test } from "node:test";
import assert from "node:assert";
import { anndataSpec, guardSize } from "./h5ad.ts";
import { MemStore } from "./localstore.ts";
import { writeStore } from "../../../../lstar/js/core/writer.ts";
import { openLstar } from "./store.ts";

// A minimal stand-in for an opened h5wasm File: Datasets carry value/shape/attrs; Groups walk paths.
const mapAttrs = (a: any) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { value: v }]));
const D = (value: any, shape: number[] | null, attrs: any = {}): any => ({ value, shape, attrs: mapAttrs(attrs), get: () => undefined, keys: () => [] });
function G(children: Record<string, any>, attrs: any = {}): any {
  const g: any = { attrs: mapAttrs(attrs), keys: () => Object.keys(children) };
  g.get = (path: string) => { const segs = String(path).split("/"); let n: any = children[segs[0]]; for (let i = 1; i < segs.length && n; i++) n = n.get(segs[i]); return n; };
  return g;
}

test("anndataSpec: CSR X → CSC counts (orientation), categorical→utf8 label, embedding, numeric", async () => {
  // 3 cells × 2 genes, CSR: c0=[1,0]  c1=[0,2]  c2=[3,4]
  const X = G({ data: D(Float32Array.from([1, 2, 3, 4]), [4]), indices: D(Int32Array.from([0, 1, 0, 1]), [4]), indptr: D(Int32Array.from([0, 1, 2, 4]), [4]) },
              { "encoding-type": "csr_matrix", shape: [3, 2] });
  const obs = G({
    _index: D(["c0", "c1", "c2"], [3]),
    leiden: G({ categories: D(["A", "B"], [2]), codes: D(Int8Array.from([0, 1, 0]), [3]) }, { "encoding-type": "categorical" }),
    nUMI: D(Float32Array.from([1, 2, 7]), [3], { "encoding-type": "array" }),
  }, { "column-order": ["leiden", "nUMI"] });
  const f = G({ X, obs, var: G({ _index: D(["g0", "g1"], [2]) }), obsm: G({ X_umap: D(Float32Array.from([0, 1, 2, 3, 4, 5]), [3, 2], { "encoding-type": "array" }) }) });

  const spec = await anndataSpec(f);
  const store = new MemStore();
  await writeStore(store, spec);
  const ds = await openLstar(store);

  assert.equal(ds.axisLength("cells"), 3);
  assert.equal(ds.axisLength("genes"), 2);

  // counts must be CSC and element-wise equal to the original CSR X
  const sp = await ds.fieldSparse("counts");
  assert.equal(sp.fmt, "csc");
  const B = [[0, 0], [0, 0], [0, 0]];
  for (let g = 0; g < 2; g++) for (let k = Number(sp.indptr[g]); k < Number(sp.indptr[g + 1]); k++) B[sp.indices[k]][g] = sp.data[k];
  assert.deepEqual(B, [[1, 0], [0, 2], [3, 4]]);

  // a categorical obs column becomes a utf8 label (the form the viewer reads), per-cell strings
  assert.deepEqual(await ds.fieldStrings("leiden"), ["A", "B", "A"]);
  // numeric obs column → dense measure over cells
  assert.equal(ds.field("nUMI")?.role, "measure");
  // obsm embedding → role embedding, [cells, 2]
  assert.equal(ds.field("umap")?.role, "embedding");
  const e = await ds.fieldDense("umap");
  assert.deepEqual([e.shape[0], e.shape[1]], [3, 2]);
});

test("anndataSpec: named index (_index attr), dense X (intrinsic shape), wide obsm clamped to 2D", async () => {
  // Real-world layout the synthetic fixture missed: the row index lives in a *named* column (the group's
  // `_index` attr points to it), X is a dense dataset with NO `shape` attr (shape is intrinsic), and obsm
  // carries a wide X_pca[n,50]-style array. 3 cells × 2 genes; X dense row-major c0=[1,0] c1=[0,2] c2=[3,4].
  const X = D(Float32Array.from([1, 0, 0, 2, 3, 4]), [3, 2], { "encoding-type": "array" });
  const obs = G({ cellname: D(["c0", "c1", "c2"], [3]),
                  louvain: G({ categories: D(["A", "B"], [2]), codes: D(Int8Array.from([0, 1, 0]), [3]) }, { "encoding-type": "categorical" }) },
                { _index: "cellname", "column-order": ["louvain"] });
  const varg = G({ gene_names: D(["g0", "g1"], [2]) }, { _index: "gene_names" });
  // X_pca with 4 components — should be clamped to the first 2; rows [0,1,2,3] [4,5,6,7] [8,9,10,11].
  const obsm = G({ X_pca: D(Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), [3, 4], { "encoding-type": "array" }) });
  const f = G({ X, obs, var: varg, obsm });

  const spec = await anndataSpec(f);
  // shape resolved from the named index + intrinsic dense shape (not a `shape` attr)
  assert.equal(spec.axes.cells.labels.length, 3);
  assert.deepEqual(spec.axes.genes.labels, ["g0", "g1"]);
  assert.deepEqual(spec.axes.cells.labels, ["c0", "c1", "c2"]);
  // dense X → CSC counts, element-wise correct
  const c = spec.fields.counts as any;
  assert.equal(c.encoding, "csc");
  const B = [[0, 0], [0, 0], [0, 0]];
  for (let g = 0; g < 2; g++) for (let k = Number(c.indptr[g]); k < Number(c.indptr[g + 1]); k++) B[c.indices[k]][g] = c.data[k];
  assert.deepEqual(B, [[1, 0], [0, 2], [3, 4]]);
  // the louvain categorical became a utf8 label, expanded per cell
  assert.deepEqual((spec.fields.louvain as any).values, ["A", "B", "A"]);
  // wide obsm clamped to 2 columns (first two components kept)
  const pca = spec.fields.pca as any;
  assert.deepEqual(pca.shape, [3, 2]);
  assert.deepEqual(Array.from(pca.data), [0, 1, 4, 5, 8, 9]);
});

test("anndataSpec: legacy compound obs (a Dataset, not a group) throws an actionable error", async () => {
  // pre-0.7 AnnData stored obs/var as compound HDF5 *tables*. A real h5wasm Dataset has no `keys()`.
  const legacyObs: any = { value: null, shape: [3], attrs: {}, get: () => undefined };   // Dataset-like: no keys()
  const f = G({ X: D(Float32Array.from([1, 0, 0, 2, 3, 4]), [3, 2], { "encoding-type": "array" }), obs: legacyObs });
  await assert.rejects(() => anndataSpec(f), /legacy AnnData/i);
});

test("guardSize: refuses an oversized .h5ad, passes a small one", () => {
  const big = G({ X: G({ data: D(null, [300_000_000]) }, { "encoding-type": "csr_matrix", shape: [100000, 30000] }) });
  assert.throws(() => guardSize(big, 0), /too large/);
  const small = G({ X: G({ data: D(null, [1000]) }, { "encoding-type": "csr_matrix", shape: [100, 40] }) });
  assert.doesNotThrow(() => guardSize(small, 0));
});
