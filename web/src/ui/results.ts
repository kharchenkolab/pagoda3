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
  aLabel?: string; bLabel?: string;   // DE column headers (so a re-opened table is faithful)
  rows: any[];                  // the DeTable / GeneList rows (so a result re-opens without recompute)
}

// ----- the unified SESSION LEDGER row: categories, results, the annotation, and apps, normalized to one shape -----
export interface SessionEntity {
  id: string;                                       // ledger-unique (type-prefixed)
  type: "category" | "result" | "annotation" | "app";
  name: string;
  who: "user" | "agent";
  when: number;                                     // epoch ms (0 = unknown / not timestamped yet)
  summary: string;                                  // "3 values", "cell-level · 20,469 genes", "18 labels · 12 records", …
  detail?: string[];                                // richer facts for the click-through info card
  ref: { kind: string; id?: string; name?: string };   // what an action targets (a field name, a result id, …)
}

// Pure normalizer (no app state) so the row-building is node-testable. The shell gathers the live inputs and calls this.
export function buildSessionEntities(inp: {
  categories: { name: string; values: number; who: "user" | "agent"; when: number; derived?: boolean; valuesList?: string[] }[];
  annotation?: { labels: number; records: number } | null;
  results: SessionResult[];
  apps: { id: string; name: string; origin: string; when: number }[];
}): SessionEntity[] {
  const out: SessionEntity[] = [];
  const vals = (list?: string[], n?: number) => (list && list.length) ? [list.length <= 14 ? list.join(", ") : list.slice(0, 14).join(", ") + ` +${list.length - 14} more`] : [`${n} value${n === 1 ? "" : "s"}`];
  const resultMethod = (r: SessionResult) => r.kind === "hvg" ? "overdispersion (variable genes)" : r.kind === "markers" ? "1-vs-rest markers" : r.kind === "pseudobulk" ? (r.spec.paired ? "pseudobulk · paired" : "pseudobulk") : "cell-level (ranking)";
  if (inp.annotation) out.push({ id: "ann", type: "annotation", name: "working resolution", who: "user", when: 0, summary: `${inp.annotation.labels} labels` + (inp.annotation.records ? ` · ${inp.annotation.records} records` : ""), detail: [`${inp.annotation.labels} labels`].concat(inp.annotation.records ? [`${inp.annotation.records} with CAP records`] : []), ref: { kind: "annotation", name: "annotation" } });
  for (const c of inp.categories) out.push({ id: "cat:" + c.name, type: "category", name: c.name, who: c.who, when: c.when, summary: `${c.values} value${c.values === 1 ? "" : "s"}` + (c.derived ? " · derived" : ""), detail: vals(c.valuesList, c.values).concat(c.derived ? ["derived grouping"] : []), ref: { kind: "category", name: c.name } });
  for (const r of inp.results) out.push({ id: "res:" + r.id, type: "result", name: r.name, who: r.who, when: r.when, summary: r.summary, detail: (r.kind === "hvg" ? [] : [`${r.aLabel || "group A"}  vs  ${r.bLabel || "group B"}`]).concat([`${resultMethod(r)} · ${r.rows.length.toLocaleString()} genes`]).concat(r.kind === "pseudobulk" && r.spec.replicate ? [`replicate: ${r.spec.replicate}`] : []), ref: { kind: "result", id: r.id } });
  for (const a of inp.apps) out.push({ id: "app:" + a.id, type: "app", name: a.name, who: a.origin === "imported" ? "agent" : "user", when: a.when, summary: a.origin === "imported" ? "imported widget" : "authored widget", detail: [a.origin === "imported" ? "imported widget" : "authored widget"], ref: { kind: "app", id: a.id } });
  return out;
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
