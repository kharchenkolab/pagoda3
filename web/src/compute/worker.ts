// The compute WORKER — runs kernels off the main thread over SharedArrayBuffer-backed data (so a heavy DE/HVG never
// janks the UI). Spawned by compute/pool.ts via `new Worker(new URL('./worker.ts', import.meta.url), {type:'module'})`.
// S0 proved the SAB→worker→result round-trip; S1 runs the first real kernel (overdispersion) here. The numeric cores
// live in pure modules (compute/odcore.ts) imported by BOTH this worker and node tests, so the math is unit-tested
// while the wiring is OODA'd live under cross-origin isolation.
import { overdispersedCore, deCore, groupStatsForCellsCore, meanVarCore, type ODPanel } from "./odcore.ts";

// Reconstruct a panel from SAB-backed buffers posted by the main thread (mapped ZERO-COPY — the buffers are shared).
function panelFrom(p: any): ODPanel {
  return { data: new Float32Array(p.data), indices: new Int32Array(p.indices), indptr: new Int32Array(p.indptr), nGenes: p.nGenes, lognorm: p.lognorm };
}

// Load the real libstar WASM kernels IN the worker (lazy, cached) — same module the main thread loads, so native C++
// numerical kernels (colMeanVar/colSumByGroup/...) run off the main thread. The emscripten module detects the WORKER
// environment + fetches the .wasm itself; it loads under COEP because the vite plugin serves /wasm with CORP.
let wasmP: Promise<any | null> | null = null;
function wasm(): Promise<any | null> {
  if (!wasmP) wasmP = (async () => {
    try { const url = new URL("/wasm/lstar_kernels.mjs", self.location.origin).href; const mod: any = await import(/* @vite-ignore */ url); return await mod.default(); }
    catch { return null; }
  })();
  return wasmP;
}

type Req = { id: number; op: string; args: any };
const post = (m: any) => (self as any).postMessage(m);
const errMsg = (e: any) => String((e && e.message) || e);

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, op, args } = e.data || ({} as Req);
  try {
    const r = run(op, args);
    if (r && typeof r.then === "function") r.then((result: any) => post({ id, result }), (err: any) => post({ id, error: errMsg(err) }));
    else post({ id, result: r });
  } catch (err: any) {
    post({ id, error: errMsg(err) });
  }
};

function run(op: string, args: any): any {
  switch (op) {
    case "ping":
      return { pong: true, isolated: typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : null, sab: typeof SharedArrayBuffer !== "undefined" };
    // S0 plumbing proof: read a SAB the main thread filled, reduce it (proves zero-copy shared read), and write the
    // result back INTO the SAB at index 0 (proves the main thread sees the worker's write — true shared memory).
    case "sum": {
      const a = new Float64Array(args.sab as SharedArrayBuffer);
      let s = 0; for (let i = 1; i < a.length; i++) s += a[i];   // sum elements 1..n-1
      a[0] = s;                                                   // write the result back into the shared buffer
      return { sum: s, n: a.length - 1 };
    }
    // overdispersion (HVG) + DE: map the SAB-backed panel ZERO-COPY (the buffers are shared, not cloned), run the kernel.
    // debug/test only: block the worker thread for args.ms (an uninterruptible busy loop) — proves the pool can KILL a
    // runaway job by terminating its worker (the rest of the pool keeps running).
    case "spin": { const end = Date.now() + (args.ms || 0); while (Date.now() < end) { /* busy */ } return { spun: args.ms || 0 }; }
    // de-risk: prove libstar WASM loads + runs in the worker.
    case "wasmVersion": return wasm().then((M: any) => ({ version: M ? M.version() : null }));
    case "overdispersion": return overdispersedCore(panelFrom(args.panel), args.cellIds, args.topN, args.maxCells);
    case "de": return deCore(panelFrom(args.panel), args.A, args.B);
    case "groupStatsForCells": return groupStatsForCellsCore(panelFrom(args.panel), args.geneCol, args.ngGlobal, args.codes, args.G, args.cellIds);
    // S5 — the widget render/compute split with KERNELS: run untrusted widget code (shadowed globals, like codeapi) with
    // an `api` that includes the kernels (api.de/api.overdispersion) backed by the shared SAB panel. Returns a promise.
    case "runCode": return runWidgetCode(args);
    default:
      throw new Error("unknown compute op: " + op);
  }
}

// Build the widget `api` (codeapi data surface + kernels over the shared panel) and run the widget's code with ambient/
// network globals shadowed (passed as undefined to the wrapped function) — the same containment as codeapi, plus the
// pool's terminability (a runaway is killed by terminating this worker). Returns the code's free-form result.
function runWidgetCode(args: any): Promise<any> {
  const s = args.snapshot || {};
  const panel = args.panel ? panelFrom(args.panel) : null;
  const symbols: string[] | null = args.panel ? args.panel.symbols : null;
  const counts = args.counts || null;   // SAB-backed gene-major counts (data + indptr) for the WASM colMeanVar kernel
  const symFor = (g: number) => (symbols ? symbols[g] : g);
  const api: any = {
    n: s.n,
    cat: (f: string) => s.cats?.[f] || null,
    catOf: (f: string, i: number) => { const c = s.cats?.[f]; return c ? c.categories[c.codes[i]] : null; },
    expr: (sym: string) => { const v = s.genes?.[sym]; if (!v) throw new Error('gene "' + sym + '" not in inputs.genes — declare it in the genes parameter'); return v; },
    genesAvailable: Object.keys(s.genes || {}),
    embedding: s.embedding,
    stats: s.stats || null,
    args: s.args || null,
    // KERNELS over the shared panel (whole-transcriptome; only present when cross-origin isolated → the panel was shared).
    // Each kernel takes an optional opts: { topN?, genes? } — genes is a SUBSET (symbol list) the result is filtered to.
    // (topN may also be passed positionally for back-compat.) Cell scoping is each kernel's natural arg (A/B, cells).
    de: panel ? (A: number[], B: number[], opt?: any) => {
      const o = optOf(opt, 30); let rk = deCore(panel, A, B);            // {g,lfc,meanA,meanB}[] all genes, |lfc|-sorted
      if (o.genes) rk = rk.filter((r) => o.genes.has(String(symFor(r.g))));   // gene-subset filter (g-level, before mapping)
      return rk.slice(0, o.topN).map((r) => ({ symbol: symFor(r.g), lfc: r.lfc, meanA: r.meanA, meanB: r.meanB }));
    } : undefined,
    overdispersion: panel ? (cells: number[], opt?: any) => {
      const o = optOf(opt, 50); let rk = overdispersedCore(panel, cells, o.genes ? 1e9 : o.topN, 2000);
      if (o.genes) rk = rk.filter((r) => o.genes.has(String(symFor(r.g))));
      return rk.slice(0, o.topN).map((r) => ({ symbol: symFor(r.g), score: r.resid, mean: r.mean }));
    } : undefined,
    // mean+variance per gene: over a CELL SUBSET (cell-major panel) when opts.cells given, else genome-wide over ALL
    // cells via the native libstar WASM colMeanVar (heavy → off-thread). Async (loads the WASM lazily). genes filters.
    meanVar: (panel || counts) ? async (opt?: any) => {
      const o = optOf(opt, 0);
      let rows: { symbol: any; mean: number; var: number; nnz: number }[];
      if (o.cells) {
        if (!panel) throw new Error("meanVar over a cell subset needs the panel");
        rows = meanVarCore(panel, o.cells).map((r) => ({ symbol: symFor(r.g), mean: r.mean, var: r.var, nnz: r.nnz }));
      } else {
        if (!counts) throw new Error("genome-wide meanVar needs cross-origin isolation (the shared counts)");
        const M = await wasm(); if (!M) throw new Error("WASM kernels unavailable in the worker");
        const r = M.colMeanVar(new Float32Array(counts.data), new Int32Array(counts.indptr), counts.nCells, 1, o.lognorm !== false);
        const cs = counts.symbols; rows = [];
        for (let g = 0; g < r.mean.length; g++) rows.push({ symbol: cs ? cs[g] : g, mean: r.mean[g], var: r.var[g], nnz: r.nnz[g] });
      }
      return pickGenes(rows, o.genes);
    } : undefined,
  };
  // normalize a kernel's opts arg: a bare number is topN (back-compat); else { topN?, genes?, cells?, lognorm? }.
  function optOf(opt: any, defTopN: number): any { const o = typeof opt === "number" ? { topN: opt } : (opt || {}); if (o.topN == null) o.topN = defTopN; if (Array.isArray(o.genes)) o.genes = new Set(o.genes.map(String)); return o; }
  function pickGenes<R extends { symbol: any }>(rows: R[], genes: Set<string> | undefined): R[] { return genes ? rows.filter((r) => genes.has(String(r.symbol))) : rows; }
  const fn = new Function("api", "fetch", "XMLHttpRequest", "importScripts", "WebSocket", "self", "globalThis", "postMessage", "onmessage",
    '"use strict"; return (async function(){ ' + String(args.code) + "\n})();");
  return Promise.resolve(fn(api));
}
