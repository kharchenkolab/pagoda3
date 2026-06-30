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

test("guardSize: refuses an oversized .h5ad, passes a small one", () => {
  const big = G({ X: G({ data: D(null, [300_000_000]) }, { "encoding-type": "csr_matrix", shape: [100000, 30000] }) });
  assert.throws(() => guardSize(big, 0), /too large/);
  const small = G({ X: G({ data: D(null, [1000]) }, { "encoding-type": "csr_matrix", shape: [100, 40] }) });
  assert.doesNotThrow(() => guardSize(small, 0));
});
