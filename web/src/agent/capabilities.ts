// The single registry of analytic PRIMITIVES — the fix for the two-surfaces drift (see misc/enabling_custom_widgets.md).
// Each primitive is defined ONCE here and projected everywhere: the widget surface (pagoda.compute), the
// `list_widget_capabilities` introspection tool, the docs, and the host's compute data-kinds (apphost delegates to it).
// Adding a primitive lights it up for the analyst AND widgets AND the docs at once — no more hand-maintained subset, no
// more "overdispersion was a tool the whole time but a widget couldn't reach it."
//
// PURE: run(ctx, args) takes a minimal CapCtx (a structural subset of the real Ctx) and calls the kernel-backed
// ctx.view.* methods. No DOM, no app import → node --test exercises it directly with a mock ctx.

// The minimal data surface a primitive needs. The real Ctx (data/ctx.ts) satisfies this structurally.
export interface CapCtx {
  n: number;
  selectedCells(): ArrayLike<number>;
  metaOf(field: string): Promise<any>;
  cellsOfCategory(field: string, value: string): ArrayLike<number>;
  view: {
    subsampleDE(A: number[], B: number[]): Promise<{ ranked: { symbol: string; lfc: number; meanA: number; meanB: number }[]; nA: number; approx?: boolean }>;
    overdispersedGenes(cells: number[], topN?: number): Promise<any[]>;
    geneExpression(gene: string): Promise<{ values: Float32Array }>;
  };
}

export interface Capability {
  name: string;
  summary: string;                       // one line: what it returns
  whenToUse: string;                     // guidance (esp. "don't loop expr")
  params: Record<string, string>;        // param → description
  example: string;                       // a pagoda.compute(...) call
  heavy?: boolean;                        // hint: route through the compute worker (item D) when available
  run(ctx: CapCtx, args: any): Promise<any>;
}

// Resolve a cell-set argument: {cells:[…]} | {field,value} | (default) the current selection. The one place this
// algebra lives, so every primitive accepts the same shapes.
export async function resolveCells(ctx: CapCtx, a: any): Promise<number[]> {
  if (Array.isArray(a?.cells)) return a.cells.map(Number).filter((i: number) => i >= 0 && i < ctx.n);
  if (a?.field != null && a?.value != null) { await ctx.metaOf(String(a.field)); return Array.from(ctx.cellsOfCategory(String(a.field), String(a.value))); }
  return Array.from(ctx.selectedCells());
}
function complement(ctx: CapCtx, cells: number[]): number[] {
  const inA = new Uint8Array(ctx.n); for (const i of cells) inA[i] = 1;
  const B: number[] = []; for (let i = 0; i < ctx.n; i++) if (!inA[i]) B.push(i); return B;
}
const clampN = (v: any, def: number, hi: number) => Math.min(Math.max(1, Number(v) || def), hi);

export const CAPABILITIES: Capability[] = [
  {
    name: "overdispersion",
    summary: "top over-dispersed (highly variable) genes for a cell set — kernel F-test residuals, genome-wide, fast",
    whenToUse: "'variable / overdispersed / most-variable genes' (HVG) for a population. Pass a cell set, or omit to use the current selection. NEVER loop expr to compute variance yourself — this is the kernel, in one call.",
    params: { cells: "number[] cell indices (optional)", "field+value": "a category instead of cells (optional)", n: "how many genes (default 50)" },
    example: "await pagoda.compute('overdispersion', {field:'cell_type', value:'CD4 T', n:30})",
    async run(ctx, a) {
      const cells = await resolveCells(ctx, a);
      if (!cells.length) return { genes: [], nA: 0, note: "no cells in the set (nothing selected?)" };
      const n = clampN(a.n, 50, 500);
      const hv = await ctx.view.overdispersedGenes(cells, n);
      const genes = (hv || []).slice(0, n).map((g: any) => ({ symbol: g.symbol ?? g.gene ?? String(g), score: +(+(g.resid ?? g.score ?? g.overdispersion ?? 0)).toFixed(3), mean: g.mean != null ? +(+g.mean).toFixed(3) : undefined }));
      return { genes, nA: cells.length };
    },
  },
  {
    name: "de",
    summary: "differential expression between two cell sets A vs B (direct test) — whole transcriptome, subsampled, fast",
    whenToUse: "contrast TWO groups (naive vs memory, day0 vs day7). Pass A and B cell sets; B defaults to the complement of A. NEVER answer a contrast with two separate marker lists — only the direct A-vs-B test shows what differs.",
    params: { A: "{cells}|{field,value} for group A (or omit → current selection)", B: "{cells}|{field,value} for group B (default = the rest)", n: "top genes (default 30)", dir: "'up' (higher in A) | 'down' (higher in B) | 'abs' (default, by |logFC|)" },
    example: "await pagoda.compute('de', {A:{field:'cell_type',value:'CD4 T'}, B:{field:'cell_type',value:'CD8 T'}})",
    async run(ctx, a) {
      const A = await resolveCells(ctx, a.A ?? a);
      if (!A.length) return { genes: [], nA: 0, note: "no cells in group A" };
      const B = a.B ? await resolveCells(ctx, a.B) : complement(ctx, A);
      const de = await ctx.view.subsampleDE(A, B);
      const n = clampN(a.n, 30, 500);
      const dir = a.dir === "up" ? "up" : a.dir === "down" ? "down" : "abs";
      let ranked = de.ranked;
      if (dir === "up") ranked = ranked.filter((r) => r.lfc > 0).sort((x, y) => y.lfc - x.lfc);
      else if (dir === "down") ranked = ranked.filter((r) => r.lfc < 0).sort((x, y) => x.lfc - y.lfc);
      const genes = ranked.slice(0, n).map((r) => ({ symbol: r.symbol, lfc: +r.lfc.toFixed(3), meanA: +r.meanA.toFixed(3), meanB: +r.meanB.toFixed(3) }));
      return { genes, nA: de.nA, approx: de.approx };
    },
  },
  {
    name: "markers",
    summary: "top MARKER genes for a cell set vs the rest — DE over the whole transcriptome in one call (what's special about these cells)",
    whenToUse: "'top/marker genes for the selection / this cluster'. Pass a cell set, or omit for the current selection. Do NOT loop expr over a hand-picked gene list (slow; raw-mean ranking just surfaces housekeeping genes).",
    params: { cells: "number[] (optional)", "field+value": "a category (optional)", n: "top genes (default 20)", dir: "'up'|'down'|'abs'" },
    example: "await pagoda.compute('markers', {field:'cell_type', value:'NK', n:15})",
    async run(ctx, a) {
      const cells = await resolveCells(ctx, a);
      if (!cells.length) return { genes: [], nA: 0, note: "no cells in the set (nothing selected?)" };
      const de = await ctx.view.subsampleDE(cells, complement(ctx, cells));
      const n = clampN(a.n, 20, 200);
      const dir = a.dir === "abs" ? "abs" : a.dir === "down" ? "down" : "up";
      let ranked = de.ranked;
      if (dir === "up") ranked = ranked.filter((r) => r.lfc > 0).sort((x, y) => y.lfc - x.lfc);
      else if (dir === "down") ranked = ranked.filter((r) => r.lfc < 0).sort((x, y) => x.lfc - y.lfc);
      const genes = ranked.slice(0, n).map((r) => ({ symbol: r.symbol, lfc: +r.lfc.toFixed(3), meanA: +r.meanA.toFixed(3), meanB: +r.meanB.toFixed(3) }));
      return { genes, nA: de.nA, approx: de.approx };
    },
  },
  {
    name: "groupStats",
    summary: "per-group MEAN expression + FRACTION expressing for a set of genes (the dot-plot / heatmap primitive)",
    whenToUse: "dot-plots, heatmaps, violins across the categories of a field. Pass the field + the genes. Do NOT loop raw expr per gene and bin it yourself.",
    params: { field: "the categorical field whose groups are the columns", genes: "string[] gene symbols (the rows)" },
    example: "await pagoda.compute('groupStats', {field:'cell_type', genes:['CD3D','MS4A1','NKG7']})",
    async run(ctx, a) {
      const m = await ctx.metaOf(String(a.field));
      if (m.kind !== "categorical") throw new Error(`'${a.field}' is not categorical`);
      const G = m.categories.length, codes = m.codes as Int32Array, genes: string[] = Array.isArray(a.genes) ? a.genes.map(String) : [];
      const mean: number[][] = [], frac: number[][] = [];
      for (const g of genes) {
        let vals: Float32Array | null = null;
        try { vals = (await ctx.view.geneExpression(g)).values; } catch { mean.push(new Array(G).fill(0)); frac.push(new Array(G).fill(0)); continue; }
        const sum = new Array(G).fill(0), pos = new Array(G).fill(0), cnt = new Array(G).fill(0);
        for (let i = 0; i < codes.length; i++) { const c = codes[i]; if (c >= 0) { const v = vals[i]; sum[c] += v; if (v > 0) pos[c]++; cnt[c]++; } }
        mean.push(sum.map((s, j) => cnt[j] ? s / cnt[j] : 0));
        frac.push(pos.map((p, j) => cnt[j] ? p / cnt[j] : 0));
      }
      return { groups: m.categories, genes, mean, frac };
    },
  },
];

export function capability(name: string): Capability | undefined { return CAPABILITIES.find((c) => c.name === name); }

export async function runCapability(ctx: CapCtx, name: string, args: any): Promise<any> {
  const c = capability(name);
  if (!c) throw new Error(`unknown compute '${name}' — available: ${CAPABILITIES.map((c) => c.name).join(", ")}`);
  return c.run(ctx, args || {});
}

// The introspection payload (everything but run) — for list_widget_capabilities + generated docs. Never stale.
export function capabilityMenu(): Omit<Capability, "run">[] {
  return CAPABILITIES.map(({ run, ...rest }) => rest);
}
