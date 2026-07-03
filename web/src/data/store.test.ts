// Integration test for `storeForUrl` — pagoda3's routing onto lstar's stores. The heavy lifting (the STORED
// zip codec, ZIP64, range reads, DEFLATE rejection) lives in and is tested by lstar's own js/test/zip.test.ts;
// here we only prove pagoda3 wires it up right: a `.zip` URL routes to lstar's range-reading `ZipStore`, a
// non-zip URL routes to the directory `HttpStore`, an end-to-end read over a Range-serving host is byte-exact,
// and a DEFLATE-packed zip is rejected (not silently degraded). Fixtures are built with lstar's OWN
// `packStoredZip` so the test can't drift from the codec it exercises.
// Run: `node --test src/data/store.test.ts`
import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { zipSync } from "fflate";
import { packStoredZip } from "../../../../lstar/js/core/zip.ts";
import { HttpStore } from "../../../../lstar/js/core/http-store.ts";
import { storeForUrl } from "./store.ts";

const META = new TextEncoder().encode('{"zarr_consolidated_format":1,"metadata":{}}');
const BIG = new Uint8Array(200 * 1024).map((_, i) => (i * 31 + 7) & 0xff);
const STORED = packStoredZip([[".zmetadata", META], ["counts/c/0", BIG]]);   // lstar's own STORED packer

// A local static host honouring HEAD + Range (206), with byte accounting so we can prove sub-range transfer.
function serve(buf: Uint8Array) {
  let served = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "HEAD") { res.writeHead(200, { "Content-Length": String(buf.length), "Accept-Ranges": "bytes" }); return res.end(); }
    const m = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
    if (m) {
      const s = +m[1], e = m[2] ? +m[2] : buf.length - 1, sl = buf.subarray(s, e + 1); served += sl.length;
      res.writeHead(206, { "Content-Range": `bytes ${s}-${e}/${buf.length}`, "Content-Length": String(sl.length) }); return res.end(sl);
    }
    served += buf.length; res.writeHead(200, { "Content-Length": String(buf.length) }); res.end(buf);
  });
  return new Promise<{ url: (name: string) => string; close: () => void; served: () => number }>((resolve) => {
    server.listen(0, () => { const port = (server.address() as any).port; resolve({ url: (n) => `http://localhost:${port}/${n}`, close: () => server.close(), served: () => served }); });
  });
}

test("storeForUrl: a non-.zip URL routes to the directory HttpStore", async () => {
  const s = await storeForUrl("https://example.org/some/store/");
  assert.ok(s instanceof HttpStore, "a directory URL should give an HttpStore");
});

test("storeForUrl: a .zip URL reads end-to-end over HTTP range, byte-exact", async () => {
  const h = await serve(STORED);
  try {
    const store: any = await storeForUrl(h.url("s.lstar.zarr.zip"));
    assert.ok(!(store instanceof HttpStore), "a .zip URL should give a ZipStore, not HttpStore");
    assert.deepEqual(await store.get(".zmetadata"), META);
    assert.deepEqual(await store.get("counts/c/0"), BIG);
    assert.deepEqual(await store.getRange("counts/c/0", 1000, 1064), BIG.subarray(1000, 1064));
  } finally { h.close(); }
});

test("storeForUrl: a sub-range read never drags the whole 200KB chunk across the wire", async () => {
  const h = await serve(STORED);   // fresh server: only open + one 64-byte ranged read
  try {
    const store: any = await storeForUrl(h.url("s.lstar.zarr.zip"));
    await store.getRange("counts/c/0", 1000, 1064);
    assert.ok(h.served() < BIG.length, `served ${h.served()} should be well under the untouched chunk (${BIG.length})`);
  } finally { h.close(); }
});

test("storeForUrl: the zip store tolerates a LEADING-SLASH key (reader passes chunk keys as /fields/…/0)", async () => {
  // The regression this guards: the reader's ConsolidatedStore hands data-chunk keys to the inner store WITH a
  // leading slash, but a zip's central-directory names have none. HttpStore strips it; lstar's ZipStore did an
  // exact match and missed → every chunk read as zeros → the dataset silently collapsed. `/counts/c/0` must
  // resolve identically to `counts/c/0`.
  const h = await serve(STORED);
  try {
    const store: any = await storeForUrl(h.url("s.lstar.zarr.zip"));
    assert.deepEqual(await store.get("/counts/c/0"), BIG, "a /-prefixed key must resolve like the slash-less one");
    assert.deepEqual(await store.get("/.zmetadata"), META);
    assert.deepEqual(await store.getRange("/counts/c/0", 1000, 1064), BIG.subarray(1000, 1064));
  } finally { h.close(); }
});

test("storeForUrl: a ?query after .zip still routes to the ZipStore", async () => {
  const h = await serve(STORED);
  try {
    const store: any = await storeForUrl(h.url("s.lstar.zarr.zip") + "?v=2");
    assert.ok(!(store instanceof HttpStore));
    assert.deepEqual(await store.get(".zmetadata"), META);
  } finally { h.close(); }
});

test("storeForUrl: a DEFLATE-packed .zip is rejected at open with an actionable 'repack STORED' error", async () => {
  // fflate level 6 on a compressible payload → DEFLATE entries; lstar's ZipStore must refuse it (not degrade).
  const deflated = zipSync({ ".zmetadata": new Uint8Array(4096) /* zeros compress → really deflated */ }, { level: 6 });
  const h = await serve(deflated);
  try {
    await assert.rejects(() => storeForUrl(h.url("bad.lstar.zarr.zip")), (e: Error) => {
      assert.match(e.message, /DEFLATE/i);
      assert.match(e.message, /STORED/i);
      return true;
    });
  } finally { h.close(); }
});
