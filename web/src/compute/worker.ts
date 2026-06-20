// The compute WORKER — runs kernels off the main thread over SharedArrayBuffer-backed data (so a heavy DE/HVG never
// janks the UI). Spawned by compute/pool.ts via `new Worker(new URL('./worker.ts', import.meta.url), {type:'module'})`.
// S0 proved the SAB→worker→result round-trip; S1 runs the first real kernel (overdispersion) here. The numeric cores
// live in pure modules (compute/odcore.ts) imported by BOTH this worker and node tests, so the math is unit-tested
// while the wiring is OODA'd live under cross-origin isolation.
import { overdispersedCore, deCore, groupStatsForCellsCore, type ODPanel } from "./odcore.ts";

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
    de: panel ? (A: number[], B: number[], topN = 30) => deCore(panel, A, B).slice(0, topN).map((r) => ({ symbol: symFor(r.g), lfc: r.lfc, meanA: r.meanA, meanB: r.meanB })) : undefined,
    overdispersion: panel ? (cells: number[], topN = 50) => overdispersedCore(panel, cells, topN, 2000).map((r) => ({ symbol: symFor(r.g), score: r.resid, mean: r.mean })) : undefined,
    // WASM KERNEL (native libstar, in the worker): genome-wide per-gene mean+variance over ALL cells — the heavy
    // computation behind a mean-variance / HVG plot. Async (loads the WASM lazily, then caches it).
    meanVar: counts ? async (lognorm = true) => {
      const M = await wasm();
      if (!M) throw new Error("WASM kernels unavailable in the worker");
      const r = M.colMeanVar(new Float32Array(counts.data), new Int32Array(counts.indptr), counts.nCells, 1, !!lognorm);
      const cs = counts.symbols; const out = [];
      for (let g = 0; g < r.mean.length; g++) out.push({ symbol: cs ? cs[g] : g, mean: r.mean[g], var: r.var[g], nnz: r.nnz[g] });
      return out;
    } : undefined,
  };
  const fn = new Function("api", "fetch", "XMLHttpRequest", "importScripts", "WebSocket", "self", "globalThis", "postMessage", "onmessage",
    '"use strict"; return (async function(){ ' + String(args.code) + "\n})();");
  return Promise.resolve(fn(api));
}
