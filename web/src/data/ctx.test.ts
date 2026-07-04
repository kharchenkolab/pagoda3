// Tests for the parallel cold-open path: ctx.init() must fire the embedding + label reads CONCURRENTLY
// (the fix for the ~N-serial-round-trips cold-open tax), metaOf() must dedupe concurrent reads of the
// same field, and categoricalFields() must stay in a DETERMINISTIC order despite parallel completion.
// Run: `node --test src/data/ctx.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ctx } from "./ctx.ts";

type FieldDef = { name: string; role: string };

// A fake LstarView that records read concurrency + per-field call counts. Every read parks on a timer,
// so if init() awaited them serially the peak concurrency would be 1; in parallel it equals the number
// of independent reads.
function makeFakeView(fields: FieldDef[], latencyMs = 15) {
  let inFlight = 0, maxConcurrent = 0;
  const metaCalls: Record<string, number> = {};
  const embCalls: Record<string, number> = {};
  const delay = () => new Promise((r) => setTimeout(r, latencyMs));
  const track = async <T>(fn: () => Promise<T>): Promise<T> => {
    inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight);
    try { return await fn(); } finally { inFlight--; }
  };
  const ds = {
    fieldNames: () => fields.map((f) => f.name),
    field: (nm: string) => fields.find((f) => f.name === nm),
    hasField: (nm: string) => fields.some((f) => f.name === nm),
    axisNames: () => [] as string[],
  };
  const view: any = {
    ds,
    embedding(nm: string) {
      embCalls[nm] = (embCalls[nm] || 0) + 1;
      return track(async () => { await delay(); return { data: new Float32Array([0, 0]), n: 1, dim: 2 }; });
    },
    metadata(nm: string) {
      metaCalls[nm] = (metaCalls[nm] || 0) + 1;
      return track(async () => { await delay(); return { kind: "categorical", codes: new Int32Array([0]), categories: [nm + "_a"] }; });
    },
  };
  return { view, stats: () => ({ maxConcurrent, metaCalls, embCalls }) };
}

test("ctx.init() reads all embeddings + labels in PARALLEL (not serially)", async () => {
  const fields: FieldDef[] = [
    { name: "umap", role: "embedding" },
    { name: "leiden", role: "label" },
    { name: "cell_type", role: "label" },
    { name: "sample", role: "label" },
    { name: "condition", role: "label" },
    { name: "louvain", role: "label" },   // an extra label not in COMMON_LABELS — still warmed
  ];
  const { view, stats } = makeFakeView(fields);
  const ctx = new Ctx(view, {} as any);
  await ctx.init();
  const s = stats();
  // 1 embedding + 5 labels = 6 independent reads all in flight at once; the old serial loop peaked at 1.
  assert.ok(s.maxConcurrent >= 6, `expected parallel reads, got maxConcurrent=${s.maxConcurrent}`);
  // every label read EXACTLY once (no duplicate reads from the common-names + role-label loops overlapping)
  for (const f of ["leiden", "cell_type", "sample", "condition", "louvain"]) assert.equal(s.metaCalls[f], 1, `${f} read once`);
  assert.equal(s.embCalls["umap"], 1, "umap embedding read once (not re-read by the default-embedding fallback)");
});

test("ctx.metaOf() dedupes concurrent reads of the same field onto one underlying read", async () => {
  const { view, stats } = makeFakeView([{ name: "leiden", role: "label" }]);
  const ctx = new Ctx(view, {} as any);
  const [a, b] = await Promise.all([ctx.metaOf("leiden"), ctx.metaOf("leiden")]);
  assert.equal(stats().metaCalls["leiden"], 1, "two concurrent metaOf() → one view.metadata() read");
  assert.equal(a, b, "both callers get the same resolved metadata object");
  await ctx.metaOf("leiden");   // now cached — no new read
  assert.equal(stats().metaCalls["leiden"], 1, "a later metaOf() is served from cache");
});

test("ctx.categoricalFields() is deterministic (common names first, then store order) despite parallel completion", async () => {
  // store field order deliberately scrambled vs COMMON_LABELS; `louvain` is an extra store label.
  const fields: FieldDef[] = [
    { name: "umap", role: "embedding" },
    { name: "louvain", role: "label" },
    { name: "condition", role: "label" },
    { name: "leiden", role: "label" },
    { name: "sample", role: "label" },
  ];
  const { view } = makeFakeView(fields);
  const ctx = new Ctx(view, {} as any);
  await ctx.init();
  // COMMON_LABELS order for the ones present (leiden, sample, condition), then store-order extras (louvain).
  assert.deepEqual(ctx.categoricalFields(), ["leiden", "sample", "condition", "louvain"]);
});
