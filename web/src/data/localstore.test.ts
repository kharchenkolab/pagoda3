import { test } from "node:test";
import assert from "node:assert";
import { zipSync } from "fflate";
import { ZipStore, FileListStore } from "./localstore.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u?: Uint8Array) => (u ? new TextDecoder().decode(u) : undefined);

test("ZipStore: reads entries, byte ranges [start,end), missing→undefined", async () => {
  const s = new ZipStore(zipSync({ ".zmetadata": enc("META"), "fields/x/0": enc("0123456789") }));
  assert.equal(dec(await s.get(".zmetadata")), "META");
  assert.equal(dec(await s.getRange("fields/x/0", 2, 5)), "234");   // half-open, like HttpStore
  assert.equal(dec(await s.get("fields/x/0")), "0123456789");
  assert.equal(await s.get("nope"), undefined);
  assert.equal(dec(await s.get("/.zmetadata")), "META");           // leading slash tolerated
});

test("ZipStore: strips a single top-level folder prefix (zipped the folder, not its contents)", async () => {
  const s = new ZipStore(zipSync({ "foo.lstar.zarr/.zmetadata": enc("M"), "foo.lstar.zarr/a/0": enc("xy") }));
  assert.equal(dec(await s.get(".zmetadata")), "M");
  assert.equal(dec(await s.get("a/0")), "xy");
});

test("FileListStore: keys by path under the webkitdirectory top dir", async () => {
  const mk = (path: string, body: string) => {
    const f = new File([enc(body)], path.split("/").pop()!);
    (f as any).webkitRelativePath = path;
    return f;
  };
  const s = new FileListStore([mk("d.lstar.zarr/.zmetadata", "M"), mk("d.lstar.zarr/a/0", "xyz")]);
  assert.equal(dec(await s.get(".zmetadata")), "M");
  assert.equal(dec(await s.getRange("a/0", 1, 3)), "yz");
  assert.equal(await s.get("missing"), undefined);
});
