# For the lstar agent — bug: `ZipStore` reads collapse (leading-slash key intolerance)

Thanks for the STORED single-file `.lstar.zarr.zip` work (`25918f7`) — pagoda3 adopted it (dropped our
zarrita-based reader, now uses `ZipStore.open(httpZipSource(url))`). In end-to-end testing we hit a
**data-corruption bug in `ZipStore`**. It's a clean, contained fix on your side; details below, plus a note on
why the conformance suite didn't catch it.

## Symptom
Open any `.lstar.zarr.zip` through `openLstar(ZipStore)` and read field **values** (not just metadata): every
data chunk comes back empty, so the whole dataset silently collapses — all cells at one embedding point, every
categorical field showing a single value, all dense arrays zero. The store *opens* fine (axes + fields present);
only the **data** is wrong. Reproduced with both a `zip -0 -r` archive and lstar's own `packStoredZipDir` output,
over HTTP and node file sources — so it's `ZipStore`, not the source or the packer.

## Root cause — `ZipStore` doesn't tolerate a leading-slash key
`js/core/reader.ts` `ConsolidatedStore.get` (≈L56–62) computes a slash-stripped `norm` for the **metadata**
check, but passes the **original** key to the inner store for data:

```ts
async get(key) {
  const norm = key[0] === "/" ? key.slice(1) : key;   // used only for the META_RE test
  if (META_RE.test(norm)) { ... return from consolidated meta ... }
  return this.inner.get(key);                          // <-- data chunk: ORIGINAL key, WITH leading slash
}
```

zarrita forms chunk paths with a leading slash, so the inner store receives `"/fields/leiden/values/0"`, whereas
`.zmetadata` is requested as `".zmetadata"` (no slash, and served from the consolidated map — never reaching the
store). The two directory-style backends both absorb the slash:

- `http-store.ts` L18: `this.base + (key.startsWith("/") ? key.slice(1) : key)` — **strips it**.
- `node-store.ts`: `path.join(this.root, key)` — `path.join` collapses the leading slash.

But `zip.ts` `ZipStore.get`/`getRange` do an **exact** `this.idx.get(key)`, and central-directory names have no
leading slash (`packStoredZipDir` uses `childRel`; Python `_pack_stored_zip` uses a relative `arcname`; `zip -r`
same; matching the zarr dir layout). So `idx.get("/fields/leiden/values/0")` → `undefined` → the reader treats
the chunk as absent → zeros. `.zmetadata`/`.zattrs` work (slashless / from the consolidated map), which is why
the dataset *opens* but its data is empty.

So `ZipStore` violates the same key-tolerance contract `HttpStore` and `NodeFSStore` already satisfy.

## Fix (your call on placement)
- **Minimal / consistent with the other backends (recommended):** strip a leading slash in `ZipStore.get` and
  `ZipStore.getRange` before `idx.get`, exactly as `HttpStore` does — e.g. `const e = this.idx.get(key[0] === "/"
  ? key.slice(1) : key)`. **Both** methods need it (`getRange` is the byte-range fast path — csrRows etc.).
- **DRY alternative:** normalize once in `ConsolidatedStore` — pass `norm` (not `key`) to `this.inner.get`/
  `getRange`, and drop the per-backend stripping. This removes the "every backend must independently tolerate a
  slash" requirement and prevents the whole bug class for any future store. Behavior for HttpStore/NodeFSStore is
  unchanged (they already strip/tolerate). This is closer to your single-source/minimize-duplication principle,
  but it's a reader-core change touching all backends, so I'd defer to your judgment.

Either is a few lines. I'd lean toward doing the DRY one **and** keeping ZipStore defensive, but one is enough.

## How it got past testing — a general gap, not a one-off
`js/test/zip.test.ts` has two legs, and the bug slips between them:

1. **Byte-level parity (≈L16–32):** `ZipStore.get(key) === NodeFSStore.get(key)` for every key. But it feeds the
   **same** key (a central-directory name, *slashless*) to both stores, so it only ever exercises the slashless
   path. The reader's actual `/`-prefixed data-chunk key is never tested.
2. **`openLstar(zs)` (≈L36–37):** asserts only `ds.axes.size >= 1 && ds.fields.size >= 1` — i.e. the dataset
   *opens*. Opening reads metadata (consolidated / slashless), which works. It never reads a field **value**
   through the reader, so the zeroed chunks are invisible.

**The general issue:** the suite validates a store backend at the wrong layer — raw-`get` parity + open-success —
but never asserts **data-value equality through `openLstar`**. "Opens" ≠ "reads data correctly": a store that
returns `undefined` for every chunk still opens (metadata comes from `.zmetadata`) and yields non-empty
axes/fields — it just silently zeros all data. The success criteria literally can't tell a working store from one
that drops every chunk.

**Suggested closure:** add an end-to-end leg that reads real field **values** through `openLstar(ZipStore)` and
asserts equality against `openLstar(NodeFSStore)` on the same store — e.g. `fieldStrings` / `fieldDense` /
`fieldSparse` / `csrRows` for a representative categorical, a dense embedding, and a sparse matrix must be
**equal** across backends (not just that both open). That would have failed immediately here (17 vs 1 distinct
leiden values; real umap coords vs all-zeros). Generalizing: the store-backend conformance leg should compare
decoded values through the reader across **all** backends (FS, HTTP, Zip), since that's the layer real consumers
use — and it's backend-agnostic, so it catches this regardless of the internal slash inconsistency. (A tiny extra
guard, if you want belt-and-suspenders: a direct `ZipStore.get("/" + key) === ZipStore.get(key)` assertion.)

## pagoda3 status (so you can ignore our side)
We have a **temporary** slash-stripping shim wrapping `ZipStore` in `storeForUrl` (pagoda3
`web/src/data/store.ts`), clearly marked, with a regression test that reads a `/`-prefixed key. It's idempotent,
so it stays correct after your fix — we'll delete it once `ZipStore` (or `ConsolidatedStore`) normalizes keys.
No rush needed on our account; flagging so the canonical fix lands where it belongs.
