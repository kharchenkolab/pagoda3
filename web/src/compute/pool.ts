// The compute POOL (main-thread side) — owns a small set of workers that run kernels over SharedArrayBuffer-backed counts
// (the SAB is read-only + shared, so every worker maps the SAME bytes — no duplication), a job queue, and per-job
// terminability. `isolated` reports whether SAB is usable here (cross-origin isolation on); callers fall back to the
// main-thread core when it's false, so the app is correct with or without isolation.
//
// Concurrency: lazy-grown to poolSize() workers — sequential work uses ONE worker; concurrent computes (several panels,
// or a widget computing while the app runs DE) fan out across workers. Terminability: a job with timeoutMs/signal that
// runs long is killed by TERMINATING its worker (the only way to stop a busy loop); the worker is respawned and the
// shared SAB persists, so the rest of the pool stays responsive. This is the safety the unbounded widget compute (S5) needs.

export function isolationAvailable(): boolean {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
}

// Worker count: hardwareConcurrency-1 (leave the main thread a core), clamped to 1..4. Pure → unit-tested.
export function poolSize(hardwareConcurrency: number): number {
  return Math.max(1, Math.min(4, (hardwareConcurrency || 4) - 1));
}

export interface RunOpts { timeoutMs?: number; signal?: AbortSignal; }

interface Job { id: number; op: string; args: any; resolve: (v: any) => void; reject: (e: any) => void; done?: boolean; timer?: any; signal?: AbortSignal; onAbort?: () => void; }
interface Slot { w: Worker; job: Job | null; }

export class ComputePool {
  readonly isolated = isolationAvailable();
  readonly size = poolSize(typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0);
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private reqId = 0;

  private spawn(): Slot {
    // Vite bundles this worker (module type) from the URL form; same-origin so it inherits cross-origin isolation and
    // can map SharedArrayBuffers posted to it.
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const slot: Slot = { w, job: null };
    w.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data || {};
      const j = slot.job;
      if (!j || j.id !== id || j.done) return;   // stale (e.g. a reply from a since-terminated job) → ignore
      j.done = true; this.clearJob(j); slot.job = null;
      error ? j.reject(new Error(error)) : j.resolve(result);
      this.pump();
    };
    w.onerror = (e: ErrorEvent) => {
      const j = slot.job;
      this.replace(slot);                          // the worker crashed → terminate + respawn it
      if (j && !j.done) { j.done = true; this.clearJob(j); j.reject(new Error(e.message || "compute worker error")); }
      this.pump();
    };
    return slot;
  }

  private clearJob(j: Job) { clearTimeout(j.timer); if (j.signal && j.onAbort) j.signal.removeEventListener("abort", j.onAbort); }

  private replace(slot: Slot) {   // kill + respawn a slot's worker (after a terminate or crash), keeping pool capacity
    try { slot.w.terminate(); } catch { /* */ }
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots[i] = this.spawn();
  }

  private pump() {
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.job);
      if (!slot && this.slots.length < this.size) { slot = this.spawn(); this.slots.push(slot); }   // lazy grow
      if (!slot) break;   // all busy + at max → wait for one to free
      const job = this.queue.shift()!;
      slot.job = job;
      slot.w.postMessage({ id: job.id, op: job.op, args: job.args });
    }
  }

  // Terminate (or dequeue) a specific job — the timeout/abort path. If it's running, TERMINATE its worker (the only way
  // to stop a busy loop) and respawn; the shared SAB persists and the other workers are untouched.
  private kill(job: Job, reason: string) {
    if (job.done) return;
    job.done = true; this.clearJob(job);
    const slot = this.slots.find((s) => s.job === job);
    if (slot) { slot.job = null; this.replace(slot); }
    else { const i = this.queue.indexOf(job); if (i >= 0) this.queue.splice(i, 1); }
    job.reject(new Error("compute " + reason));
    this.pump();
  }

  run<T = any>(op: string, args: any, opts?: RunOpts): Promise<T> {
    const id = ++this.reqId;
    return new Promise<T>((resolve, reject) => {
      const job: Job = { id, op, args, resolve, reject };
      if (opts?.signal?.aborted) { reject(new Error("compute aborted")); return; }
      if (opts?.timeoutMs) job.timer = setTimeout(() => this.kill(job, `timed out after ${opts.timeoutMs}ms (terminated)`), opts.timeoutMs);
      if (opts?.signal) { job.signal = opts.signal; job.onAbort = () => this.kill(job, "aborted"); opts.signal.addEventListener("abort", job.onAbort, { once: true }); }
      this.queue.push(job);
      this.pump();
    });
  }

  ping(): Promise<{ pong: boolean; isolated: boolean | null; sab: boolean }> { return this.run("ping", {}); }
  stats() { return { size: this.size, workers: this.slots.length, busy: this.slots.filter((s) => s.job).length, queued: this.queue.length }; }
  dispose() { for (const s of this.slots) { try { s.w.terminate(); } catch { /* */ } } this.slots = []; this.queue = []; }
}
