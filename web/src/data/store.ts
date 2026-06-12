// Faithful TypeScript reader for the L* Zarr format (mirrors lstar/js/core/reader.ts,
// extended with csrRow + sparse-row helpers). Uses zarrita directly so the app build
// stays self-contained. The on-disk contract: root .zattrs.lstar = {axes, fields, ...};
// axes/<a>/{labels,labels_offsets}; fields/<f>/.zattrs.lstar = {role,span,encoding,...}
// with values (dense/utf8) or data/indices/indptr (csc/csr).
import * as zarr from "zarrita";

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

  // One CSC column (gene): nonzero row indices + values. Reads only the needed chunks.
  async cscColumn(name: string, col: number): Promise<{ rows: Int32Array; vals: Float64Array }> {
    const ptr: any = await this._get(`fields/${name}/indptr`, [zarr.slice(col, col + 2)]);
    const a = Number(ptr.data[0]), b = Number(ptr.data[1]);
    if (b <= a) return { rows: new Int32Array(0), vals: new Float64Array(0) };
    const idx: any = await this._get(`fields/${name}/indices`, [zarr.slice(a, b)]);
    const val: any = await this._get(`fields/${name}/data`, [zarr.slice(a, b)]);
    return { rows: Int32Array.from(idx.data as any), vals: Float64Array.from(val.data as any) };
  }

  // One CSR row (cell): nonzero col indices + values.
  async csrRow(name: string, row: number): Promise<{ cols: Int32Array; vals: Float64Array }> {
    const ptr: any = await this._get(`fields/${name}/indptr`, [zarr.slice(row, row + 2)]);
    const a = Number(ptr.data[0]), b = Number(ptr.data[1]);
    if (b <= a) return { cols: new Int32Array(0), vals: new Float64Array(0) };
    const idx: any = await this._get(`fields/${name}/indices`, [zarr.slice(a, b)]);
    const val: any = await this._get(`fields/${name}/data`, [zarr.slice(a, b)]);
    return { cols: Int32Array.from(idx.data as any), vals: Float64Array.from(val.data as any) };
  }
}

export async function openLstar(store: any): Promise<LstarDataset> {
  return new LstarDataset(store).init();
}

export function fetchStore(url: string) { return new (zarr as any).FetchStore(url); }
