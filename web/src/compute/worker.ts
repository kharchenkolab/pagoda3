// The compute WORKER — runs kernels off the main thread over SharedArrayBuffer-backed data (so a heavy DE/HVG never
// janks the UI). Spawned by compute/pool.ts via `new Worker(new URL('./worker.ts', import.meta.url), {type:'module'})`.
// S0 proved the SAB→worker→result round-trip; S1 runs the first real kernel (overdispersion) here. The numeric cores
// live in pure modules (compute/odcore.ts) imported by BOTH this worker and node tests, so the math is unit-tested
// while the wiring is OODA'd live under cross-origin isolation.
import { overdispersedCore, deCore, groupStatsForCellsCore, type ODPanel } from "./odcore.ts";

// Reconstruct a panel from SAB-backed buffers posted by the main thread (mapped ZERO-COPY — the buffers are shared).
function panelFrom(p: any): ODPanel {
  return { data: new Float64Array(p.data), indices: new Int32Array(p.indices), indptr: new Int32Array(p.indptr), nGenes: p.nGenes, lognorm: p.lognorm };
}

type Req = { id: number; op: string; args: any };

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, op, args } = e.data || ({} as Req);
  try {
    const result = run(op, args);
    (self as any).postMessage({ id, result });
  } catch (err: any) {
    (self as any).postMessage({ id, error: String(err?.message || err) });
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
    case "overdispersion": return overdispersedCore(panelFrom(args.panel), args.cellIds, args.topN, args.maxCells);
    case "de": return deCore(panelFrom(args.panel), args.A, args.B);
    case "groupStatsForCells": return groupStatsForCellsCore(panelFrom(args.panel), args.geneCol, args.ngGlobal, args.codes, args.G, args.cellIds);
    default:
      throw new Error("unknown compute op: " + op);
  }
}
