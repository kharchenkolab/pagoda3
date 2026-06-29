// The session RESULTS registry — DE / pseudobulk / marker / variable-gene outputs as first-class, named, re-runnable
// artifacts, not just transient panels. Each carries the runCompute SPEC (so it can be re-run), provenance (who/when),
// a human summary, and the rows. The session ledger lists these; the session document persists them. Pure (no DOM,
// no app imports beyond the CellSet type) → node-testable.
import type { CellSet } from "../agent/cellset.ts";

export interface ResultSpec { stat: string; A?: CellSet; B?: CellSet; replicate?: string; paired?: boolean; }
export interface SessionResult {
  id: string;
  name: string;                 // the contrast / list title, e.g. "CD4 T (naive) vs CD8 T (memory)"
  kind: "de" | "pseudobulk" | "markers" | "hvg";
  spec: ResultSpec;             // re-runnable via runCompute(spec)
  who: "user" | "agent";        // provenance — who produced it
  when: number;                 // epoch ms
  summary: string;              // "cell-level · 20,469 genes", "pseudobulk paired · sample · 6 reps", …
  bind: string;                 // the panel bind tag (de:between / pseudobulk:paired / de:markers / hvg:scope)
  rows: any[];                  // the DeTable / GeneList rows (so a result re-opens without recompute)
}

// Newest-first registry with stable string ids. add() returns the stored record (the caller keeps its id to link a panel).
export class ResultRegistry {
  private items: SessionResult[] = [];
  private seq = 0;
  add(r: Omit<SessionResult, "id">): SessionResult { const it: SessionResult = { ...r, id: "res" + (++this.seq) }; this.items.unshift(it); return it; }
  list(): SessionResult[] { return this.items.slice(); }
  get(id: string): SessionResult | undefined { return this.items.find((x) => x.id === id); }
  remove(id: string): boolean { const n = this.items.length; this.items = this.items.filter((x) => x.id !== id); return this.items.length < n; }
  rename(id: string, name: string): boolean { const it = this.get(id); if (!it || !name.trim()) return false; it.name = name.trim(); return true; }
  clear(): void { this.items = []; this.seq = 0; }
  // persistence — deep-copy the spec so a later edit can't mutate a serialized doc
  serialize(): SessionResult[] { return this.items.map((x) => ({ ...x, spec: JSON.parse(JSON.stringify(x.spec)) })); }
  restore(arr?: SessionResult[] | null): void {
    if (!Array.isArray(arr)) return;
    this.items = arr.slice();
    this.seq = arr.reduce((m, x) => Math.max(m, parseInt(String(x.id).replace(/\D/g, ""), 10) || 0), 0);   // continue ids past the restored max
  }
}
