// The app's L* reader is now the canonical @lstar/core package — a single source of truth, so the reader
// no longer drifts from the format. We import the package's reader.ts / http-store.ts directly (tsconfig
// already includes ../../lstar/js/core and vite allows the path), matching the WASM-kernel copy pattern.
// HttpStore adds the byte-range fast path + the consolidated `.zmetadata` open (one request, not ~80).
export { openLstar, LstarDataset } from "../../../../lstar/js/core/reader.ts";
export type { AxisMeta, FieldMeta, LstarStore } from "../../../../lstar/js/core/reader.ts";

import { ZipFileStore } from "@zarrita/storage";
import { HttpStore } from "../../../../lstar/js/core/http-store.ts";
import type { LstarStore } from "../../../../lstar/js/core/reader.ts";
export { HttpStore };   // re-export (the byte-range fast path + consolidated `.zmetadata` open) — used directly by main.ts too

// A remote `*.lstar.zarr.zip` served over HTTP, read with byte-RANGE requests (never a whole-file download):
// zarrita's ZipFileStore fetches the ZIP central directory once, then Range-reads each chunk's bytes. This
// adapts zarrita's store shape (a `/`-prefixed AbsolutePath + a `{offset,length}` RangeQuery) to lstar's reader
// contract (`get(key)` / `getRange(key,start,end)`), so `openLstar` consumes it exactly like `HttpStore`.
// REQUIRES: the zip written STORED (no deflate) so entries stay sub-range-readable, AND the host honouring
// Range + HEAD — zarrita's HTTPRangeReader does NOT fall back to whole-file slicing the way HttpStore does.
export class ZipHttpStore implements LstarStore {
  private zs: ReturnType<typeof ZipFileStore.fromUrl>;
  constructor(url: string) { this.zs = ZipFileStore.fromUrl(url); }
  private k(key: string): `/${string}` { return (key[0] === "/" ? key : "/" + key) as `/${string}`; }
  async get(key: string): Promise<Uint8Array | undefined> { return this.zs.get(this.k(key)); }
  async getRange(key: string, start: number, end: number): Promise<Uint8Array | undefined> {
    if (end <= start) return new Uint8Array(0);
    return this.zs.getRange(this.k(key), { offset: start, length: end - start });   // [start,end) → offset+length
  }
}

/** Pick the store for a `?store=` URL: a `.zip` → the range-read ZIP archive above; else the directory HttpStore. */
export function storeForUrl(url: string): LstarStore {
  return /\.zip($|\?)/i.test(url) ? new ZipHttpStore(url) : new HttpStore(url);
}
