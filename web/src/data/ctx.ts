// Cached derived-data context the panels + agent read from. Holds the view, the
// embedding positions, cached metadata, and the data-handle catalog (provenance +
// cacoa caveats that TRAVEL WITH THE HANDLE — plan1.md I.7).
import type { LstarView, Metadata } from "./view.ts";
import type { Coord } from "./coord.ts";

export interface HandleMeta { prov?: string; caveat?: string; }

export class Ctx {
  view: LstarView;
  coord: Coord;
  embedding!: { data: Float32Array; n: number };
  private meta = new Map<string, Metadata>();
  private markerCache?: Map<string, { gene: number; symbol: string; lfc: number; padj: number }[]>;

  constructor(view: LstarView, coord: Coord) { this.view = view; this.coord = coord; }

  async init() {
    this.embedding = await this.view.embedding("umap");
    // warm the common labels
    for (const f of ["leiden", "cell_type", "sample", "condition"]) if (this.view.ds.hasField(f)) await this.metaOf(f);
  }

  async metaOf(field: string): Promise<Metadata> {
    if (!this.meta.has(field)) this.meta.set(field, await this.view.metadata(field));
    return this.meta.get(field)!;
  }

  get n() { return this.view.nCells; }

  // sample -> condition map (a sample's condition is constant across its cells)
  async sampleConditions(): Promise<Map<string, string>> {
    const s = await this.metaOf("sample") as any, c = await this.metaOf("condition") as any;
    const out = new Map<string, string>();
    for (let i = 0; i < this.n && out.size < s.categories.length; i++) {
      const sm = s.categories[s.codes[i]]; if (!out.has(sm)) out.set(sm, c.categories[c.codes[i]]);
    }
    return out;
  }

  // per (sample x cluster) proportions, compositional
  async composition(stackBy = "leiden"): Promise<{ samples: string[]; conds: string[]; groups: string[]; props: number[][] }> {
    const s = await this.metaOf("sample") as any, g = await this.metaOf(stackBy) as any;
    const samples = s.categories as string[], groups = g.categories as string[];
    const sc = await this.sampleConditions();
    const counts = samples.map(() => new Array(groups.length).fill(0));
    const tot = new Array(samples.length).fill(0);
    for (let i = 0; i < this.n; i++) { counts[s.codes[i]][g.codes[i]]++; tot[s.codes[i]]++; }
    const props = counts.map((row, si) => row.map((v) => (tot[si] ? v / tot[si] : 0)));
    return { samples, conds: samples.map((sm) => sc.get(sm) || ""), groups, props };
  }

  async markers(grouping = "leiden") {
    if (!this.markerCache) this.markerCache = await this.view.markers(grouping, 40);
    return this.markerCache;
  }

  private gsCache = new Map<string, Awaited<ReturnType<LstarView["groupStats"]>>>();
  async groupStatsCached(grouping = "leiden") {
    if (!this.gsCache.has(grouping)) this.gsCache.set(grouping, await this.view.groupStats(grouping));
    return this.gsCache.get(grouping)!;
  }

  // per-sample distribution of a gene within an optional cluster (the replicate view)
  async exprBySample(gene: string, clusterName?: string): Promise<{ sample: string; cond: string; vals: number[]; mean: number }[]> {
    const { values } = await this.view.geneExpression(gene);
    const s = await this.metaOf("sample") as any, c = await this.metaOf("condition") as any;
    const lei = clusterName ? (await this.metaOf("leiden") as any) : null;
    const lcode = lei ? lei.categories.indexOf(clusterName) : -1;
    const bins = s.categories.map((sm: string, si: number) => ({ sample: sm, cond: c.categories[firstCondCode(c, s, si)], vals: [] as number[], mean: 0 }));
    for (let i = 0; i < this.n; i++) {
      if (lei && lei.codes[i] !== lcode) continue;
      bins[s.codes[i]].vals.push(values[i]);
    }
    for (const b of bins) b.mean = b.vals.length ? b.vals.reduce((a, x) => a + x, 0) / b.vals.length : 0;
    return bins;
  }

  // ----- handle catalog -----
  handleOf(bind?: string): HandleMeta | undefined {
    if (!bind) return undefined;
    if (bind === "embedding:main") return { prov: `UMAP · ${this.n.toLocaleString()} cells` };
    if (bind === "composition:bySample") return { prov: "per-sample cluster proportions", caveat: "Proportions sum to 1 — a rise in one cluster forces others down. Use a compositional test, not per-cluster comparisons." };
    if (bind === "aspect:overdispersion") return { prov: "per-cell program scores", caveat: "Program variance (overdispersion) is not differential expression between conditions." };
    if (bind?.startsWith("expr:")) return { prov: "per-donor aggregation", caveat: "This is the replicate view: each point is a donor mean. One donor can carry an apparent shift." };
    if (bind?.startsWith("de:selection")) return { prov: "subsample DE · ranking-grade", caveat: "Approximate (sampled cells), ranking-grade only. The donor is the replicate — verify per-sample before any population-level claim; the selection boundary is post-hoc." };
    if (bind?.startsWith("de:")) return { prov: "marker test · cluster vs rest", caveat: "Cell-level ranking. For a population-level claim use pseudobulk across donors; the cluster boundary is post-hoc." };
    return undefined;
  }
}

function firstCondCode(c: any, s: any, si: number): number {
  for (let i = 0; i < s.codes.length; i++) if (s.codes[i] === si) return c.codes[i];
  return 0;
}
