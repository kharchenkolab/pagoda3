// The compute POOL (main-thread side) — owns the worker(s) that run kernels over SharedArrayBuffer-backed counts, and a
// promise-returning run(op,args) dispatch. S0 is a single worker + trivial op; S1+ move the real kernels in and S4 grows
// it to a pool. `isolated` reports whether SAB is actually usable here (cross-origin isolation on) — callers fall back to
// the main-thread path when it's false, so the app is correct with or without isolation.

export function isolationAvailable(): boolean {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
}

export class ComputePool {
  readonly isolated = isolationAvailable();
  private worker: Worker | null = null;
  private reqId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    // Vite bundles this worker (module type) from the URL form; same-origin so it inherits cross-origin isolation and
    // can receive SharedArrayBuffers.
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data || {};
      const p = this.pending.get(id);
      if (p) { this.pending.delete(id); error ? p.reject(new Error(error)) : p.resolve(result); }
    };
    w.onerror = (e: ErrorEvent) => { for (const p of this.pending.values()) p.reject(new Error(e.message || "compute worker error")); this.pending.clear(); };
    this.worker = w;
    return w;
  }

  run<T = any>(op: string, args: any): Promise<T> {
    const w = this.ensure();
    const id = ++this.reqId;
    return new Promise<T>((resolve, reject) => { this.pending.set(id, { resolve, reject }); w.postMessage({ id, op, args }); });
  }

  // health/plumbing check
  ping(): Promise<{ pong: boolean; isolated: boolean | null; sab: boolean }> { return this.run("ping", {}); }

  // S0 demo: fill a SAB on the main thread, have the worker sum elements 1..n-1 and write the result back to index 0.
  async sumViaSAB(values: number[]): Promise<{ sum: number; backChannel: number }> {
    const sab = new SharedArrayBuffer((values.length + 1) * 8);
    const a = new Float64Array(sab);
    for (let i = 0; i < values.length; i++) a[i + 1] = values[i];
    const r = await this.run<{ sum: number }>("sum", { sab });
    return { sum: r.sum, backChannel: a[0] };   // a[0] = the worker's write, seen on the main thread iff truly shared
  }

  dispose() { try { this.worker?.terminate(); } catch { /* */ } this.worker = null; this.pending.clear(); }
}
