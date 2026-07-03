// The app's L* reader is now the canonical @lstar/core package — a single source of truth, so the reader
// no longer drifts from the format. We import the package's reader.ts / http-store.ts directly (tsconfig
// already includes ../../lstar/js/core and vite allows the path), matching the WASM-kernel copy pattern.
// HttpStore adds the byte-range fast path + the consolidated `.zmetadata` open (one request, not ~80).
export { openLstar, LstarDataset } from "../../../../lstar/js/core/reader.ts";
export type { AxisMeta, FieldMeta, LstarStore } from "../../../../lstar/js/core/reader.ts";

import { HttpStore } from "../../../../lstar/js/core/http-store.ts";
import { ZipStore, httpZipSource } from "../../../../lstar/js/core/zip.ts";
import type { LstarStore } from "../../../../lstar/js/core/reader.ts";
export { HttpStore };   // re-export (the byte-range fast path + consolidated `.zmetadata` open) — used directly by main.ts too

// TEMPORARY shim — remove once lstar's ZipStore normalizes keys itself (reported; see misc/note_for_lstar.md).
// The reader's ConsolidatedStore passes DATA-chunk keys to the inner store WITH a leading slash (`/fields/…/0`)
// while requesting `.zmetadata` without one. HttpStore (`key.slice(1)`) and NodeFSStore (`path.join`) both
// tolerate the slash; lstar's ZipStore does an exact `idx.get(key)` against slash-less central-directory names,
// so every chunk misses → reads as zeros → the whole dataset collapses (all cells one point, one category).
// Strip the leading slash at the boundary, exactly as HttpStore does. Idempotent (a slash-less key is
// unchanged), so this stays correct — and can simply be deleted — once ZipStore strips internally.
function slashTolerant(s: LstarStore): LstarStore {
  const k = (key: string) => (key[0] === "/" ? key.slice(1) : key);
  return { get: (key) => s.get(k(key)), getRange: (key, a, b) => s.getRange!(k(key), a, b) };
}

/**
 * Pick the store for a `?store=` URL. A `*.lstar.zarr.zip` → lstar's STORED single-file `ZipStore`, which
 * reads the archive's central directory once then seeks into it with ONE HTTP `Range` per chunk (via
 * `httpZipSource`) — the same byte-range fast path as the directory `HttpStore`, over one file. It is the
 * canonical lstar codec (ZIP64-aware, parity with Python/R/C++), so pagoda3 doesn't fork its own: it enforces
 * STORED (a DEFLATE zip throws a clear "repack STORED" error at open) and, unlike a naive range reader,
 * degrades to a whole-file slice on a host that ignores `Range` rather than breaking. Anything else → the
 * directory `HttpStore`. Async because `ZipStore.open` reads the central directory up front; the `url` label
 * prefixes any open error with the store's address.
 */
export async function storeForUrl(url: string): Promise<LstarStore> {
  return /\.zip($|\?)/i.test(url) ? slashTolerant(await ZipStore.open(httpZipSource(url), url)) : new HttpStore(url);
}
