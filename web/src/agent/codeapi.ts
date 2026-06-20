// Arc 3 — the gated CODE escape hatch. When neither update_view (config) nor compute (de/overdispersion over
// cell sets) can express what's needed, the agent writes a short async function body that runs in a sandboxed
// Web Worker against a small data api, and returns a TYPED result that binds to a panel. One tool, unbounded
// reach; the context cost is this api surface documented once, not a tool per computation.
//
// Gating: (1) runs in a Worker (no DOM/app state; terminated on timeout → hang-safe); network/self/globalThis
// shadowed; (2) genes must be DECLARED up front (so the worker gets a complete data snapshot); (3) the result
// lands in the DISPOSABLE rail by default — the user pins to commit. This module is pure-loadable (browser
// globals are only touched inside runInWorker's body), so node --test can unit-test the validator directly.

export type CodeResult =
  | { kind: "genes"; rows: { symbol: string; score?: number; lfc?: number }[]; title?: string }
  | { kind: "values"; values: number[]; label: string }
  | { kind: "note"; text: string; title?: string }
  | { kind: "cells"; ids: number[]; label?: string };

// Validate + normalize whatever the code returned. Pure. n = cell count (for length / range checks).
export function validateComputeResult(r: any, n: number): { error?: string; result?: CodeResult } {
  if (!r || typeof r !== "object") return { error: "code must return an object like {kind:'genes'|'values'|'note'|'cells', …}" };
  const k = r.kind;
  if (k === "genes") {
    if (!Array.isArray(r.rows)) return { error: "genes result needs rows: array of {symbol, score?}" };
    const rows = r.rows.filter((x: any) => x && typeof x.symbol === "string")
      .map((x: any) => ({ symbol: x.symbol, score: typeof x.score === "number" ? x.score : undefined, lfc: typeof x.lfc === "number" ? x.lfc : undefined }));
    if (!rows.length) return { error: "genes result has no valid rows (each row needs a string `symbol`)" };
    return { result: { kind: "genes", rows, title: typeof r.title === "string" ? r.title : undefined } };
  }
  if (k === "values") {
    if (!r.values || typeof r.values.length !== "number") return { error: "values result needs values: number[]" };
    if (r.values.length !== n) return { error: `values length ${r.values.length} != number of cells ${n}` };
    if (typeof r.label !== "string" || !r.label) return { error: "values result needs a non-empty label" };
    return { result: { kind: "values", values: Array.from(r.values, (v: any) => (Number.isFinite(+v) ? +v : 0)), label: r.label } };
  }
  if (k === "note") {
    if (typeof r.text !== "string" || !r.text) return { error: "note result needs non-empty text" };
    return { result: { kind: "note", text: r.text, title: typeof r.title === "string" ? r.title : undefined } };
  }
  if (k === "cells") {
    if (!r.ids || typeof r.ids.length !== "number") return { error: "cells result needs ids: number[]" };
    const ids = [...new Set(Array.from(r.ids, (v: any) => v | 0).filter((i: number) => i >= 0 && i < n))];
    if (!ids.length) return { error: "cells result has no valid in-range ids" };
    return { result: { kind: "cells", ids, label: typeof r.label === "string" ? r.label : undefined } };
  }
  return { error: `unknown result kind "${k}" — use genes | values | note | cells` };
}

// The api surface, documented for the tool description (kept next to the harness so they can't drift).
export const CODE_API_DOC =
  "Write the body of an async function that receives `api` and RETURNS a typed result. api: " +
  "`api.n` (cell count); `api.cat(field)` → {codes:Int[], categories:string[]} for a categorical (cell_type, leiden, sample, condition, patient, outcome); " +
  "`api.catOf(field, i)` → the category string of cell i; `api.expr(symbol)` → Float32Array of log-normalized expression (only for genes you DECLARE in `genes`); " +
  "`api.numeric(field)` → Float32Array of a NUMERIC field per cell (QC etc.: mito, n_umi, n_gene, …; `api.numericFields` lists them) — use it to threshold/score over QC; " +
  "`api.genesAvailable` (declared symbols); `api.embedding` (Float32Array, x,y interleaved per cell); `api.stats` → {groups, mean, frac, nGenes} if you pass `grouping`. " +
  "Return one of: {kind:'genes', rows:[{symbol, score?}], title?} (ranked table → rail); {kind:'values', values:number[len n], label} (per-cell score → colours the embedding); " +
  "{kind:'note', text, title?}; {kind:'cells', ids:number[], label?} (→ selection). Example — score cells by a signature: " +
  "\"const g=['CD8A','GZMB','PRF1']; const v=new Float32Array(api.n); for(const s of g){const e=api.expr(s); for(let i=0;i<api.n;i++) v[i]+=e[i];} return {kind:'values', values:Array.from(v), label:'cytotoxic'};\" (declare genes:['CD8A','GZMB','PRF1']).";

// Worker source (runs in an isolated thread). new Function is given network/ambient globals as undefined params
// so the agent's body can't reach them; the result is posted back. A runaway body is handled by terminate() on
// the main side. NOTE: a guard for a trusted local tool, not a hard jail.
export const WORKER_SRC = `
self.onmessage = async function (e) {
  var code = e.data.code, s = e.data.snapshot;
  try {
    var api = {
      n: s.n,
      cat: function (f) { return s.cats[f] || null; },
      catOf: function (f, i) { var c = s.cats[f]; return c ? c.categories[c.codes[i]] : null; },
      expr: function (sym) { var v = s.genes[sym]; if (!v) throw new Error('gene "' + sym + '" not in inputs.genes — declare it in the genes parameter'); return v; },
      numeric: function (f) { return (s.numerics && s.numerics[f]) || null; },
      numericFields: Object.keys(s.numerics || {}),
      genesAvailable: Object.keys(s.genes),
      embedding: s.embedding,
      stats: s.stats || null,
      args: s.args || null
    };
    var fn = new Function('api','fetch','XMLHttpRequest','importScripts','WebSocket','self','globalThis','postMessage','onmessage',
      '"use strict"; return (async function(){ ' + code + '\\n})();');
    var result = await fn(api);
    self.postMessage({ ok: true, result: result });
  } catch (err) { self.postMessage({ ok: false, error: String(err && err.message ? err.message : err) }); }
};
`;

// The minimal ctx surface the snapshot builder needs (the real Ctx satisfies it structurally) — keeps this module
// pure-loadable and unit-testable with a mock, like capabilities.CapCtx.
export interface SnapshotCtx {
  n: number;
  categoricalFields(): string[];
  metadataFields(): { name: string; kind: "categorical" | "numeric" }[];   // for the numeric fields (QC etc.)
  metaOf(field: string): Promise<any>;
  embedding: { data: Float32Array };
  groupings(): string[];
  groupStatsCached(grouping: string): Promise<{ groups: string[]; mean: any; frac: any; nGenes: number }>;
  view: { genes(): Promise<any>; geneCol(sym: string): Promise<number | null | undefined> | number | null | undefined; geneExpression(sym: string): Promise<{ values: Float32Array }>; };
}

// Build the worker data snapshot ONCE — used by BOTH the analyst code path (runComputeCode) and the widget render/compute
// split (pagoda.runCompute). All categoricals + the embedding always travel; declared genes are resolved to vectors
// (unknowns reported, not thrown); an optional grouping adds precomputed group stats; `args` passes widget params through.
// `maxGenes` bounds the snapshot for the less-trusted widget caller (the analyst caller leaves it Infinity).
export async function buildComputeSnapshot(
  ctx: SnapshotCtx,
  opts: { genes?: string[]; grouping?: string; args?: any; maxGenes?: number } = {},
): Promise<{ snapshot: any; unknown: string[] }> {
  await ctx.view.genes();   // warm the symbol table so geneCol resolves
  const cats: Record<string, { codes: any; categories: string[] }> = {};
  for (const f of ctx.categoricalFields()) { const m: any = await ctx.metaOf(f); cats[f] = { codes: m.codes, categories: m.categories }; }
  // NUMERIC fields (QC: mito/n_umi/n_gene, od_score, …) so the code can threshold/score over them — they were missing, so
  // "flag cells with high mito" couldn't be done in the sandbox.
  const numerics: Record<string, Float32Array> = {};
  for (const f of ctx.metadataFields()) { if (f.kind === "numeric") { try { const m: any = await ctx.metaOf(f.name); if (m && m.values) numerics[f.name] = m.values; } catch { /* skip */ } } }
  const want = (opts.genes || []).map((s) => String(s).trim()).filter(Boolean);
  if (opts.maxGenes != null && want.length > opts.maxGenes) throw new Error(`too many genes declared (${want.length} > ${opts.maxGenes}) — narrow the gene list`);
  const genes: Record<string, Float32Array> = {}; const unknown: string[] = [];
  for (const s of want) { const gi = await ctx.view.geneCol(s); if (gi == null) { unknown.push(s); continue; } genes[s] = (await ctx.view.geneExpression(s)).values; }
  let stats: any; if (opts.grouping && ctx.groupings().includes(opts.grouping)) { const gs = await ctx.groupStatsCached(opts.grouping); stats = { groups: gs.groups, mean: gs.mean, frac: gs.frac, nGenes: gs.nGenes }; }
  return { snapshot: { n: ctx.n, cats, genes, numerics, embedding: ctx.embedding.data, stats, args: opts.args ?? null }, unknown };
}

// Run agent code in a fresh worker; resolve with {ok,result}|{ok:false,error}; terminate (hang-safe) on timeout.
export function runInWorker(code: string, snapshot: any, timeoutMs = 5000): Promise<{ ok: boolean; result?: any; error?: string }> {
  return new Promise((resolve) => {
    let url = "", w: Worker;
    try {
      const blob = new Blob([WORKER_SRC], { type: "application/javascript" });
      url = URL.createObjectURL(blob);
      w = new Worker(url);
    } catch (err) { resolve({ ok: false, error: "worker init failed: " + String(err) }); return; }
    const done = (out: { ok: boolean; result?: any; error?: string }) => { clearTimeout(timer); try { w.terminate(); } catch {} if (url) URL.revokeObjectURL(url); resolve(out); };
    const timer = setTimeout(() => done({ ok: false, error: `timed out after ${timeoutMs}ms (terminated) — likely an infinite loop` }), timeoutMs);
    w.onmessage = (e: MessageEvent) => done(e.data);
    w.onerror = (e: ErrorEvent) => done({ ok: false, error: e.message || "worker error" });
    w.postMessage({ code, snapshot });
  });
}
