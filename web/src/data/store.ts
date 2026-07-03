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
  private url: string;   // an explicit field (not a `private url` param property — node's type-strip test runner rejects those)
  constructor(url: string) { this.url = url; this.zs = ZipFileStore.fromUrl(url); }
  private k(key: string): `/${string}` { return (key[0] === "/" ? key : "/" + key) as `/${string}`; }
  async get(key: string): Promise<Uint8Array | undefined> {
    try { return await this.zs.get(this.k(key)); } catch (e) { this.explain(e); }
  }
  async getRange(key: string, start: number, end: number): Promise<Uint8Array | undefined> {
    if (end <= start) return new Uint8Array(0);
    try { return await this.zs.getRange(this.k(key), { offset: start, length: end - start }); }   // [start,end) → offset+length
    catch (e) { this.explain(e); }
  }

  // zarrita/unzipit collapse two very different problems into one opaque message: a host that doesn't honour
  // HTTP Range / HEAD-Content-Length (the whole-file-instead-of-a-range read makes the End-Of-Central-Directory
  // scan fail) reads as "maybe not zip file" — identical to a genuinely truncated/deflated file. Translate both
  // observed error shapes (see store.test.ts) into one actionable message instead of that misleading throw.
  private explain(e: unknown): never {
    const msg = String((e as any)?.message || e);
    if (/end of central directory|could not get length/i.test(msg))
      throw new Error(
        `Couldn't open ${this.url} as a .lstar.zarr.zip. Either the file is truncated / not a valid zip, or the ` +
        `host doesn't support HTTP Range + HEAD (Content-Length) — both are required to read a hosted .zip. ` +
        `Serve it from a static host that honours byte ranges (nginx, Apache, S3, GitHub Pages), or drag the ` +
        `file into the page to open it locally.`, { cause: e });
    if (/failed http request/i.test(msg))
      throw new Error(
        `Couldn't fetch ${this.url} (${msg.replace(/^.*?status:/, "status:")}). A hosted .lstar.zarr.zip needs a ` +
        `host that answers HEAD and Range requests. Check the URL, or drag the file in to open it locally.`,
        { cause: e });
    throw e as Error;
  }

  // Non-fatal diagnostics. A DEFLATE-compressed .zip opens and reads correctly, but every chunk read has to
  // fetch the WHOLE entry and inflate it (zarrita has no sub-range for a deflated entry) — silently defeating
  // the byte-range fast path that hosting a single file is for. Surface it so the load log can flag the footgun.
  // Empty array ⇒ nothing to report (STORED zip, as it should be). Best-effort: never throws.
  async storageWarnings(): Promise<string[]> {
    try {
      const info: any = await (this.zs as any).info;
      const entries: any[] = Object.values(info?.entries ?? {});
      const deflated = entries.filter((e) => e && e.compressionMethod && e.compressionMethod !== 0);
      if (deflated.length)
        return [`This .zip is DEFLATE-compressed (${deflated.length}/${entries.length} entries) — it opens, but ` +
                `every chunk read fetches the whole entry, so hosted range access is degraded. Repack it STORED: ` +
                `\`zip -0 -r store.lstar.zarr.zip store.lstar.zarr/\`.`];
      return [];
    } catch { return []; }
  }
}

/** Pick the store for a `?store=` URL: a `.zip` → the range-read ZIP archive above; else the directory HttpStore. */
export function storeForUrl(url: string): LstarStore {
  return /\.zip($|\?)/i.test(url) ? new ZipHttpStore(url) : new HttpStore(url);
}
