// Browser-native local stores (Phase 4): read an L* store off the user's machine — no server, no
// install. Each implements the reader's LstarStore (get + getRange), so `openLstar` and the whole
// viewer work unchanged. `getRange` maps to a true byte sub-read (a File.slice / a typed-array view),
// so the gene/cell fast path works locally too.
//
//   • ZipStore        — a single *.lstar.zarr.zip (a zarr ZipStore), unzipped in memory (fflate). One
//                       file to download + drag in; works in every browser. RAM-bound (small/medium).
//   • DirHandleStore  — a FileSystemDirectoryHandle (Chromium drag-a-folder / directory picker). Any
//                       size — File.slice reads ranges straight off disk.
//   • FileListStore   — a flat FileList from <input webkitdirectory> (the Firefox/Safari folder path).
import { unzipSync } from "fflate";
import type { LstarStore } from "./store.ts";
import type { OpenProgress } from "../ui/loading.ts";
import { detectTriplets, openTriplet, type Entry } from "./tenx.ts";

// Flatten each drop kind into a {path, read} list so 10x triplet detection is source-agnostic.
async function entriesFromDir(dir: any): Promise<Entry[]> {
  const out: Entry[] = [];
  async function walk(d: any, prefix: string, depth: number): Promise<void> {
    if (depth > 2) return;   // 10x nests at most one level (e.g. filtered_feature_bc_matrix/matrix.mtx.gz)
    try { for await (const [name, h] of d.entries()) {
      if (h.kind === "file") out.push({ path: prefix + name, read: async () => new Uint8Array(await (await h.getFile()).arrayBuffer()) });
      else if (h.kind === "directory") await walk(h, prefix + name + "/", depth + 1);
    } } catch { /* entries() unsupported */ }
  }
  await walk(dir, "", 0);
  return out;
}
const entriesFromFileList = (arr: File[]): Entry[] =>
  arr.map((f) => ({ path: (f as any).webkitRelativePath || f.name, read: async () => new Uint8Array(await f.arrayBuffer()) }));
const entriesFromZip = (files: Record<string, Uint8Array>): Entry[] =>
  Object.entries(files).map(([path, bytes]) => ({ path, read: async () => bytes }));

// If these entries are a 10x triplet (and NOT a zarr store), open it. One triplet → open; several → throw a
// pickable error the caller turns into a chooser (opts.sample re-enters with the chosen key). null = not a triplet.
async function tripletResult(entries: Entry[], progress?: OpenProgress, opts?: { force?: boolean; sample?: string }): Promise<{ store: LstarStore; label: string; notes?: string } | null> {
  if (entries.some((e) => /(^|\/)\.z(metadata|group)$/.test(e.path))) return null;   // a zarr store, not a triplet
  const tris = detectTriplets(entries);
  if (!tris.length) return null;
  const pick = opts?.sample ? tris.find((t) => t.key === opts.sample) : (tris.length === 1 ? tris[0] : null);
  if (!pick) throw Object.assign(new Error(`This folder holds ${tris.length} samples — choose one to open.`),
    { samples: tris.map((t) => ({ key: t.key, label: t.label })), pickTriplet: true });
  const store = await openTriplet(pick, progress, opts?.force);
  return { store, label: pick.label, notes: (store as any).__notes };
}

// Strip a single common top-level dir so "zipped the folder" (foo.lstar.zarr/.zmetadata) reads the same
// as "zipped the contents" (.zmetadata). Keys are normalized to the store root.
function rootify(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  if (files[".zmetadata"] || files[".zgroup"]) return files;
  const marker = Object.keys(files)
    .filter((k) => k.endsWith("/.zmetadata") || k.endsWith("/.zgroup"))
    .sort((a, b) => a.length - b.length)[0];
  if (!marker) return files;
  const prefix = marker.replace(/\.(zmetadata|zgroup)$/, "");
  const out: Record<string, Uint8Array> = {};
  for (const k in files) out[k.startsWith(prefix) ? k.slice(prefix.length) : k] = files[k];
  return out;
}

// An in-memory read+write store (Map of key → bytes). Used to materialize a converted .h5ad as a real
// in-memory L* store (lstar writeStore writes into it; openLstar reads it back).
export class MemStore implements LstarStore {
  files = new Map<string, Uint8Array>();
  private norm(k: string) { return k[0] === "/" ? k.slice(1) : k; }
  async get(key: string): Promise<Uint8Array | undefined> { return this.files.get(this.norm(key)); }
  async set(key: string, value: Uint8Array): Promise<void> { this.files.set(this.norm(key), value); }
  async getRange(key: string, start: number, end: number): Promise<Uint8Array | undefined> {
    const v = this.files.get(this.norm(key));
    return v ? v.subarray(start, end) : undefined;
  }
  async getSuffix(key: string, n: number): Promise<Uint8Array | undefined> {   // last n bytes — v3 shard-index reads
    const v = this.files.get(this.norm(key));
    return v ? v.subarray(Math.max(0, v.byteLength - n)) : undefined;
  }
}

export class ZipStore implements LstarStore {
  private files: Record<string, Uint8Array>;
  constructor(zipBytes: Uint8Array) {
    this.files = rootify(unzipSync(zipBytes));
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    return this.files[key[0] === "/" ? key.slice(1) : key];
  }
  async getRange(key: string, start: number, end: number): Promise<Uint8Array | undefined> {
    const v = await this.get(key);
    return v ? v.subarray(start, end) : undefined;   // [start, end) — same contract as HttpStore
  }
  async getSuffix(key: string, n: number): Promise<Uint8Array | undefined> {   // last n bytes — v3 shard-index reads
    const v = await this.get(key);
    return v ? v.subarray(Math.max(0, v.byteLength - n)) : undefined;
  }
}

// Descend into a single *.lstar.zarr child if the picked/dropped folder is a parent, not the store.
async function resolveStoreDir(dir: any): Promise<any> {
  for (const probe of [".zmetadata", ".zgroup"]) {
    try { await dir.getFileHandle(probe); return dir; } catch { /* not here */ }
  }
  try {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === "directory" && name.endsWith(".lstar.zarr")) return h;
    }
  } catch { /* entries() unsupported -> use dir as-is */ }
  return dir;
}

export class DirHandleStore implements LstarStore {
  private dir: any;
  private constructor(dir: any) { this.dir = dir; }
  static async open(dir: any): Promise<DirHandleStore> { return new DirHandleStore(await resolveStoreDir(dir)); }
  private async fileFor(key: string): Promise<File | undefined> {
    const parts = (key[0] === "/" ? key.slice(1) : key).split("/");
    try {
      let h = this.dir;
      for (let i = 0; i < parts.length - 1; i++) h = await h.getDirectoryHandle(parts[i]);
      return await (await h.getFileHandle(parts[parts.length - 1])).getFile();
    } catch { return undefined; }
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    const f = await this.fileFor(key);
    return f ? new Uint8Array(await f.arrayBuffer()) : undefined;
  }
  async getRange(key: string, start: number, end: number): Promise<Uint8Array | undefined> {
    const f = await this.fileFor(key);
    return f ? new Uint8Array(await f.slice(start, end).arrayBuffer()) : undefined;   // true disk range read
  }
  async getSuffix(key: string, n: number): Promise<Uint8Array | undefined> {   // last n bytes — v3 shard-index reads
    const f = await this.fileFor(key);
    return f ? new Uint8Array(await f.slice(Math.max(0, f.size - n)).arrayBuffer()) : undefined;
  }
}

export class FileListStore implements LstarStore {
  private files = new Map<string, File>();
  constructor(list: FileList | File[]) {
    const arr = Array.from(list as any) as File[];
    // key by path-after-the-top-dir (webkitRelativePath = "foo.lstar.zarr/.zmetadata")
    let prefix = "";
    const rels = arr.map((f) => (f as any).webkitRelativePath || f.name);
    const top = rels[0]?.split("/")[0];
    if (top && rels.every((r) => r.startsWith(top + "/"))) prefix = top + "/";
    arr.forEach((f, i) => this.files.set(rels[i].slice(prefix.length), f));
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    const f = this.files.get(key[0] === "/" ? key.slice(1) : key);
    return f ? new Uint8Array(await f.arrayBuffer()) : undefined;
  }
  async getRange(key: string, start: number, end: number): Promise<Uint8Array | undefined> {
    const f = this.files.get(key[0] === "/" ? key.slice(1) : key);
    return f ? new Uint8Array(await f.slice(start, end).arrayBuffer()) : undefined;
  }
  async getSuffix(key: string, n: number): Promise<Uint8Array | undefined> {   // last n bytes — v3 shard-index reads
    const f = this.files.get(key[0] === "/" ? key.slice(1) : key);
    return f ? new Uint8Array(await f.slice(Math.max(0, f.size - n)).arrayBuffer()) : undefined;
  }
}

/** Build a local store from a dropped/picked thing: a .zip File, a FileSystemDirectoryHandle, or a
 *  webkitdirectory FileList. Returns the store + a short label for the UI. `onStage` reports progress
 *  for the slow in-browser paths (h5ad parse, zip unpack). */
export async function localStore(input: File | FileList | File[] | any, progress?: OpenProgress, opts?: { force?: boolean; sample?: string }): Promise<{ store: LstarStore; label: string; notes?: string }> {
  if (input && typeof input.getFile !== "function" && (input.kind === "directory" || typeof input.getDirectoryHandle === "function")) {
    const tri = await tripletResult(await entriesFromDir(input), progress, opts);   // a dropped folder may be a 10x triplet, not a zarr
    if (tri) return tri;
    return { store: await DirHandleStore.open(input), label: (input.name || "folder") };
  }
  if (input instanceof File) {
    if (/\.h5ad$/i.test(input.name)) {
      const { openH5ad } = await import("./h5ad.ts");   // lazy — code-splits the h5wasm WASM out of the main bundle
      const store = await openH5ad(input, progress, opts?.force);
      return { store, label: input.name, notes: (store as any).__notes };
    }
    if (/\.h5$/i.test(input.name)) {   // a 10x Cell Ranger .h5 feature-barcode matrix (falls through to .h5ad if it's actually AnnData)
      const { openTenxH5 } = await import("./tenxh5.ts");
      const store = await openTenxH5(input, progress, opts?.force);
      return { store, label: input.name, notes: (store as any).__notes };
    }
    if (!/\.zip$/i.test(input.name)) throw new Error("Drop a .lstar.zarr.zip/folder, a .h5ad, or a 10x .h5 file.");
    progress?.stage("Reading file…");
    const bytes = new Uint8Array(await input.arrayBuffer());
    progress?.stage("Unpacking archive…");
    const files = unzipSync(bytes);
    const tri = await tripletResult(entriesFromZip(files), progress, opts);   // a zip of a 10x triplet, not a zarr
    if (tri) return tri;
    return { store: new ZipStore(bytes), label: input.name };
  }
  // a FileList / File[] from <input webkitdirectory> (or loose dropped files)
  const arr = Array.from(input as any) as File[];
  if (arr.length) {
    const tri = await tripletResult(entriesFromFileList(arr), progress, opts);
    if (tri) return tri;
    return { store: new FileListStore(arr), label: (arr[0] as any).webkitRelativePath?.split("/")[0] || "folder" };
  }
  throw new Error("Nothing to open.");
}
