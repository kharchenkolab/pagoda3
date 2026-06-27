// Faithful TypeScript reader for the L* Zarr format (mirrors lstar/js/core/reader.ts,
// extended with csrRow + sparse-row helpers). Uses zarrita directly so the app build
// stays self-contained. The on-disk contract: root .zattrs.lstar = {axes, fields, ...};
// axes/<a>/{labels,labels_offsets}; fields/<f>/.zattrs.lstar = {role,span,encoding,...}
// with values (dense/utf8) or data/indices/indptr (csc/csr).
import * as zarr from "zarrita";

// zarr v2 little-endian dtype → [typed-array ctor, item size]. Used to slice an UNCOMPRESSED array by a direct HTTP
// byte range: the L* sparse data/indices/indptr are stored raw + single-chunk precisely so a contiguous slice [a,b) is
// the contiguous byte range [a·size, b·size) — a few KB for one gene instead of the whole (228 MB) chunk.
const DT: Record<string, [any, number]> = {
  "<i1": [Int8Array, 1], "|i1": [Int8Array, 1], "<u1": [Uint8Array, 1], "|u1": [Uint8Array, 1],
  "<i2": [Int16Array, 2], "<u2": [Uint16Array, 2], "<i4": [Int32Array, 4], "<u4": [Uint32Array, 4],
  "<f4": [Float32Array, 4], "<f8": [Float64Array, 8], "<i8": [BigInt64Array, 8], "<u8": [BigUint64Array, 8],
};

export interface AxisMeta { name: string; origin: string; role?: string; length: number; }
export interface FieldMeta {
  name: string; role?: string; span: string[]; encoding: string;
  state?: string; subtype?: string; shape?: number[];
}

const td = new TextDecoder();
function decodeStrings(bytes: Uint8Array, offsets: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < offsets.length; i++) out.push(td.decode(bytes.subarray(Number(offsets[i]), Number(offsets[i + 1]))));
  return out;
}

export class LstarDataset {
  store: any; root: any;
  kind = "sample"; specVersion = "0.1";
  profiles: string[] = []; dropped: string[] = [];
  axes = new Map<string, AxisMeta>();
  fields = new Map<string, FieldMeta>();

  constructor(store: any) { this.store = store; }

  async init(): Promise<this> {
    // Prefer consolidated metadata (.zmetadata): one fetch for the whole manifest.
    let base: any = this.store;
    try { base = await (zarr as any).withConsolidated(this.store); } catch { base = this.store; }
    this.root = zarr.root(base);
    const grp: any = await zarr.open(this.root, { kind: "group" });
    const meta = grp.attrs?.lstar as any;
    if (!meta) throw new Error("not an L* store (no 'lstar' root attribute)");
    this.kind = meta.kind ?? "sample";
    this.specVersion = meta.spec_version ?? "0.1";
    this.profiles = meta.profiles ?? [];
    this.dropped = meta.dropped ?? [];
    for (const name of meta.axes as string[]) {
      const ag: any = await zarr.open(this.root.resolve(`axes/${name}`), { kind: "group" });
      const am = ag.attrs?.lstar ?? {};
      const off: any = await zarr.open(this.root.resolve(`axes/${name}/labels_offsets`), { kind: "array" });
      this.axes.set(name, { name, origin: am.origin ?? "observed", role: am.role, length: off.shape[0] - 1 });
    }
    for (const name of meta.fields as string[]) {
      const fg: any = await zarr.open(this.root.resolve(`fields/${name}`), { kind: "group" });
      const fm = fg.attrs?.lstar ?? {};
      this.fields.set(name, {
        name, role: fm.role, span: fm.span ?? [], encoding: fm.encoding ?? "dense",
        state: fm.state, subtype: fm.subtype, shape: fm.shape,
      });
    }
    return this;
  }

  axisNames() { return [...this.axes.keys()]; }
  fieldNames() { return [...this.fields.keys()]; }
  hasField(n: string) { return this.fields.has(n); }
  field(n: string) { return this.fields.get(n); }
  axisLength(n: string) { return this.axes.get(n)?.length ?? 0; }

  private _open(p: string) { return zarr.open(this.root.resolve(p), { kind: "array" }); }
  private async _get(p: string, sel?: any) { return zarr.get(await this._open(p) as any, sel); }

  async axisLabels(name: string): Promise<string[]> {
    const bytes: any = await this._get(`axes/${name}/labels`);
    const off: any = await this._get(`axes/${name}/labels_offsets`);
    return decodeStrings(bytes.data as Uint8Array, off.data as ArrayLike<number>);
  }

  async fieldDense(name: string): Promise<{ data: any; shape: number[] }> {
    const v: any = await this._get(`fields/${name}/values`);
    return { data: v.data, shape: v.shape };
  }

  async fieldStrings(name: string): Promise<string[]> {
    const bytes: any = await this._get(`fields/${name}/values`);
    const off: any = await this._get(`fields/${name}/values_offsets`);
    return decodeStrings(bytes.data as Uint8Array, off.data as ArrayLike<number>);
  }

  async fieldSparse(name: string) {
    const m = this.fields.get(name)!;
    const data: any = await this._get(`fields/${name}/data`);
    const indices: any = await this._get(`fields/${name}/indices`);
    const indptr: any = await this._get(`fields/${name}/indptr`);
    return { data: data.data, indices: indices.data, indptr: indptr.data, shape: m.shape ?? [], fmt: m.encoding };
  }

  // ---- direct byte-range slicing (the gene/cell hot path) ----
  // zarrita fetches WHOLE chunks; for the L* sparse arrays that's the entire 228 MB array per gene. These arrays are
  // raw + single-chunk on purpose, so we read a column's slice with ONE byte-range request instead — ~KB per gene.
  private _zmeta = new Map<string, { itemsize: number; ctor: any; single: boolean }>();
  private _indptr = new Map<string, Int32Array>();
  private _rangeOK: boolean | null = null;   // null=unknown, set once: does the SERVER honour Range (206) or ignore it (200)?
  private baseUrl(): string { return String(this.store?.url || ""); }

  // Cache an array's layout: item size / ctor, and whether it's a single UNCOMPRESSED chunk (→ range-readable).
  private async zmeta(key: string) {
    let m = this._zmeta.get(key); if (m) return m;
    const za: any = await (await fetch(this.baseUrl() + key + "/.zarray")).json();
    const di = DT[za.dtype as string];
    const single = Array.isArray(za.chunks) && za.chunks.length === 1 && za.chunks[0] >= za.shape[0] && !za.compressor;
    m = { itemsize: di ? di[1] : 0, ctor: di ? di[0] : null, single: !!single };
    this._zmeta.set(key, m); return m;
  }

  // A contiguous slice [a,b) of a single uncompressed chunk via ONE HTTP byte-range request. Returns null when the
  // array isn't range-eligible (compressed / multi-chunk) OR the server ignored Range (status ≠ 206) — caller falls
  // back to zarrita's whole-chunk fetch, so correctness never depends on Range support.
  private async rangeSlice(key: string, a: number, b: number): Promise<any | null> {
    if (this._rangeOK === false) return null;   // server already known to ignore Range → go straight to zarrita
    const m = await this.zmeta(key);
    if (!m.single || !m.ctor || b <= a) return null;
    const resp = await fetch(this.baseUrl() + key + "/0", { headers: { Range: `bytes=${a * m.itemsize}-${b * m.itemsize - 1}` } });
    if (resp.status === 206) { this._rangeOK = true; return new m.ctor(await resp.arrayBuffer()); }
    // server ignored Range and sent the whole chunk: USE it (slice in memory — no second fetch) and stop probing.
    this._rangeOK = false;
    return new m.ctor(await resp.arrayBuffer()).subarray(a, b);
  }

  // indptr is tiny and needed for EVERY column — fetch once, cache.
  private async indptrOf(name: string): Promise<Int32Array> {
    const hit = this._indptr.get(name); if (hit) return hit;
    const v: any = await this._get(`fields/${name}/indptr`);
    const ip: Int32Array = v.data instanceof Int32Array ? v.data : Int32Array.from(v.data as any);
    this._indptr.set(name, ip); return ip;
  }

  // One CSC column (gene): nonzero row indices + values. Range-reads the slice; whole-chunk fetch only as fallback.
  async cscColumn(name: string, col: number): Promise<{ rows: Int32Array; vals: Float64Array }> {
    const ip = await this.indptrOf(name);
    const a = Number(ip[col]), b = Number(ip[col + 1]);
    if (b <= a) return { rows: new Int32Array(0), vals: new Float64Array(0) };
    let idx: any = await this.rangeSlice(`fields/${name}/indices`, a, b);
    let val: any = await this.rangeSlice(`fields/${name}/data`, a, b);
    if (idx == null) idx = (await this._get(`fields/${name}/indices`, [zarr.slice(a, b)]) as any).data;
    if (val == null) val = (await this._get(`fields/${name}/data`, [zarr.slice(a, b)]) as any).data;
    return { rows: Int32Array.from(idx as any), vals: Float64Array.from(val as any) };
  }

  // One CSR row (cell): nonzero col indices + values.
  async csrRow(name: string, row: number): Promise<{ cols: Int32Array; vals: Float64Array }> {
    const ip = await this.indptrOf(name);
    const a = Number(ip[row]), b = Number(ip[row + 1]);
    if (b <= a) return { cols: new Int32Array(0), vals: new Float64Array(0) };
    let idx: any = await this.rangeSlice(`fields/${name}/indices`, a, b);
    let val: any = await this.rangeSlice(`fields/${name}/data`, a, b);
    if (idx == null) idx = (await this._get(`fields/${name}/indices`, [zarr.slice(a, b)]) as any).data;
    if (val == null) val = (await this._get(`fields/${name}/data`, [zarr.slice(a, b)]) as any).data;
    return { cols: Int32Array.from(idx as any), vals: Float64Array.from(val as any) };
  }
}

export async function openLstar(store: any): Promise<LstarDataset> {
  return new LstarDataset(store).init();
}

export function fetchStore(url: string) { return new (zarr as any).FetchStore(url); }
