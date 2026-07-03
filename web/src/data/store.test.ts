// Integration test for ZipHttpStore — the remote `*.lstar.zarr.zip` reader. Builds a STORED (no-deflate)
// zip in memory, serves it over a local HTTP server that honours HEAD + Range (with byte accounting), wraps
// it in ZipHttpStore, and asserts: (a) `get`/`getRange` are byte-exact through the archive, (b) a missing key
// is `undefined` not a throw, (c) reads are RANGE reads — a small sub-range never drags the whole zip across
// the wire. This locks in the two properties the hosted single-file story depends on: STORED entries stay
// sub-range-readable, and the adapter maps lstar's `get(key)/getRange(key,start,end)` onto zarrita cleanly.
// Run: `node --test src/data/store.test.ts`
import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { zipSync } from "fflate";
import { ZipHttpStore } from "./store.ts";

// A STORED zip with one big "chunk" entry + small entries. `level: 0` = STORED (verified: local-header
// compression-method byte is 0), so every entry is byte-range-readable inside the archive.
const BIG = new Uint8Array(200 * 1024).map((_, i) => (i * 31 + 7) & 0xff);
const META = new TextEncoder().encode('{"cells":100,"genes":50,"hello":"world"}');
const ZMETA = new TextEncoder().encode('{"zarr_consolidated_format":1,"metadata":{}}');
const ENTRIES: Record<string, Uint8Array> = { "counts/c/0": BIG, "meta.json": META, ".zmetadata": ZMETA };
const ZIP = zipSync(ENTRIES, { level: 0 });

// A local static host: HEAD → length + Accept-Ranges; GET Range → 206 sub-slice; GET plain → 200 whole file.
// `served` accumulates bytes actually written so the test can prove sub-range (not whole-file) transfer.
function serveZip(buf: Uint8Array) {
  let served = 0, wholeFileGets = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "HEAD") { res.writeHead(200, { "Content-Length": String(buf.length), "Accept-Ranges": "bytes" }); return res.end(); }
    const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
    if (range) {
      const s = +range[1], e = range[2] ? +range[2] : buf.length - 1;
      const slice = buf.subarray(s, e + 1); served += slice.length;
      res.writeHead(206, { "Content-Range": `bytes ${s}-${e}/${buf.length}`, "Content-Length": String(slice.length) });
      return res.end(slice);
    }
    wholeFileGets++; served += buf.length; res.writeHead(200, { "Content-Length": String(buf.length) }); res.end(buf);
  });
  return new Promise<{ url: string; close: () => void; stats: () => { served: number; wholeFileGets: number } }>((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as any).port;
      resolve({ url: `http://localhost:${port}/s.lstar.zarr.zip`, close: () => server.close(), stats: () => ({ served, wholeFileGets }) });
    });
  });
}

test("ZipHttpStore: get() returns byte-exact entry contents through the archive", async () => {
  const h = await serveZip(ZIP);
  try {
    const store = new ZipHttpStore(h.url);
    // keys WITHOUT a leading slash, exactly as lstar's reader passes them (the adapter's k() prepends "/").
    assert.deepEqual(await store.get("meta.json"), META);
    assert.deepEqual(await store.get(".zmetadata"), ZMETA);
    assert.deepEqual(await store.get("counts/c/0"), BIG);
  } finally { h.close(); }
});

test("ZipHttpStore: getRange() returns the exact sub-range; empty range needs no fetch", async () => {
  const h = await serveZip(ZIP);
  try {
    const store = new ZipHttpStore(h.url);
    // [start, end) exclusive-end, matching lstar's LstarStore.getRange contract.
    assert.deepEqual(await store.getRange("meta.json", 3, 9), META.subarray(3, 9));
    assert.deepEqual(await store.getRange("counts/c/0", 1000, 1064), BIG.subarray(1000, 1064));
    // full-entry range == get()
    assert.deepEqual(await store.getRange("meta.json", 0, META.length), META);
    // degenerate empty range short-circuits to an empty buffer (no request, no error)
    assert.deepEqual(await store.getRange("counts/c/0", 42, 42), new Uint8Array(0));
  } finally { h.close(); }
});

test("ZipHttpStore: a missing key resolves to undefined (not a throw)", async () => {
  const h = await serveZip(ZIP);
  try {
    const store = new ZipHttpStore(h.url);
    assert.equal(await store.get("does/not/exist"), undefined);
  } finally { h.close(); }
});

test("ZipHttpStore: a small read is a RANGE read — the 200KB chunk is never dragged across the wire", async () => {
  const h = await serveZip(ZIP);
  try {
    const store = new ZipHttpStore(h.url);
    // Open (central directory) + read a 6-byte slice of a SMALL entry. If range reads work, the big
    // 200KB `counts/c/0` chunk data is never fetched, so total bytes served stays well under the zip size.
    await store.get(".zmetadata");
    await store.getRange("meta.json", 3, 9);
    const { served, wholeFileGets } = h.stats();
    assert.equal(wholeFileGets, 0, "server should never have answered a whole-file GET");
    assert.ok(served < ZIP.length / 2, `range reads should serve a small fraction; served ${served} of ${ZIP.length}`);
    assert.ok(served < BIG.length, `served (${served}) must be less than the untouched 200KB chunk (${BIG.length})`);
  } finally { h.close(); }
});

// A misbehaving/incompatible host: HEAD, Range, and Content-Length can each be broken independently. Serve the
// zip in each broken mode and assert the adapter throws a LEGIBLE, actionable message (not zarrita's opaque
// "maybe not zip file"). `mode` mirrors the observed failure surface (see the table in the Phase 2 work).
function serveBroken(buf: Uint8Array, mode: "head405" | "nolength" | "norange") {
  const server = http.createServer((req, res) => {
    if (req.method === "HEAD") {
      if (mode === "head405") { res.writeHead(405); return res.end(); }
      const hdr: Record<string, string> = { "Accept-Ranges": "bytes" };
      if (mode !== "nolength") hdr["Content-Length"] = String(buf.length);
      res.writeHead(200, hdr); return res.end();
    }
    const m = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
    if (m && mode !== "norange") {
      const s = +m[1], e = m[2] ? +m[2] : buf.length - 1, sl = buf.subarray(s, e + 1);
      res.writeHead(206, { "Content-Range": `bytes ${s}-${e}/${buf.length}`, "Content-Length": String(sl.length) }); return res.end(sl);
    }
    res.writeHead(200, { "Content-Length": String(buf.length) }); res.end(buf);   // Range ignored → whole file
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, () => resolve({ url: `http://localhost:${(server.address() as any).port}/s.lstar.zarr.zip`, close: () => server.close() }));
  });
}

test("ZipHttpStore: a host that ignores Range or drops Content-Length throws an actionable error, not 'not a zip'", async () => {
  for (const mode of ["nolength", "norange"] as const) {
    const h = await serveBroken(ZIP, mode);
    try {
      const store = new ZipHttpStore(h.url);
      await assert.rejects(() => store.get(".zmetadata"), (e: Error) => {
        assert.match(e.message, /HTTP Range/i, `${mode}: message should name Range as the requirement`);
        assert.doesNotMatch(e.message, /maybe not zip file/i, `${mode}: must not leak zarrita's misleading text`);
        return true;
      });
    } finally { h.close(); }
  }
});

test("ZipHttpStore: a host that refuses HEAD throws an actionable fetch error", async () => {
  const h = await serveBroken(ZIP, "head405");
  try {
    const store = new ZipHttpStore(h.url);
    await assert.rejects(() => store.get(".zmetadata"), (e: Error) => {
      assert.match(e.message, /HEAD and Range|status:/i);
      return true;
    });
  } finally { h.close(); }
});

test("ZipHttpStore: storageWarnings flags a DEFLATE zip and stays quiet for STORED", async () => {
  // STORED → no warning.
  const hs = await serveZip(ZIP);
  try { assert.deepEqual(await new ZipHttpStore(hs.url).storageWarnings(), []); } finally { hs.close(); }
  // DEFLATE (level 6) → one warning that names the STORED repack fix.
  const deflated = zipSync(ENTRIES, { level: 6 });
  const hd = await serveZip(deflated);
  try {
    const ws = await new ZipHttpStore(hd.url).storageWarnings();
    assert.equal(ws.length, 1);
    assert.match(ws[0], /DEFLATE-compressed/);
    assert.match(ws[0], /zip -0 -r/);
  } finally { hd.close(); }
});
