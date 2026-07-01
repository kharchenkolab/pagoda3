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
}

/** Build a local store from a dropped/picked thing: a .zip File, a FileSystemDirectoryHandle, or a
 *  webkitdirectory FileList. Returns the store + a short label for the UI. `onStage` reports progress
 *  for the slow in-browser paths (h5ad parse, zip unpack). */
export async function localStore(input: File | FileList | File[] | any, onStage?: (msg: string) => void): Promise<{ store: LstarStore; label: string; notes?: string }> {
  if (input && typeof input.getFile !== "function" && (input.kind === "directory" || typeof input.getDirectoryHandle === "function")) {
    return { store: await DirHandleStore.open(input), label: (input.name || "folder") };
  }
  if (input instanceof File) {
    if (/\.h5ad$/i.test(input.name)) {
      const { openH5ad } = await import("./h5ad.ts");   // lazy — code-splits the h5wasm WASM out of the main bundle
      const store = await openH5ad(input, onStage);
      return { store, label: input.name, notes: (store as any).__notes };
    }
    if (!/\.zip$/i.test(input.name)) throw new Error("Drop a .lstar.zarr.zip, a .lstar.zarr folder, or a .h5ad file.");
    onStage?.("Reading file…");
    const bytes = new Uint8Array(await input.arrayBuffer());
    onStage?.("Unpacking archive…");
    return { store: new ZipStore(bytes), label: input.name };
  }
  // a FileList / File[] from <input webkitdirectory>
  const arr = Array.from(input as any) as File[];
  if (arr.length) return { store: new FileListStore(arr), label: (arr[0] as any).webkitRelativePath?.split("/")[0] || "folder" };
  throw new Error("Nothing to open.");
}
