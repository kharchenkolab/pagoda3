// Tests for the parallel cold-open path: ctx.init() must fire the embedding + label reads CONCURRENTLY
// (the fix for the ~N-serial-round-trips cold-open tax), metaOf() must dedupe concurrent reads of the
// same field, and categoricalFields() must stay in a DETERMINISTIC order despite parallel completion.
// Run: `node --test src/data/ctx.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ctx } from "./ctx.ts";

type FieldDef = { name: string; role: string; encoding?: string; span?: string[] };

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
    nCells: 100,   // ctx.n → view.nCells (metadataFields' per-cell shape check)
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

test("ctx.catalogCategoricals() enumerates from the catalog with NOTHING warmed (no reads)", async () => {
  // the keystone of the modular-provisioning refactor: "what categoricals EXIST" must come from the catalog
  // (field encodings/roles), not from what's been READ — so the boot recipe no longer has to warm a field
  // just to make it enumerable (for the agent world / pickers / existence checks).
  const fields: FieldDef[] = [
    { name: "umap", role: "embedding", span: ["cells", "d2"] },
    { name: "leiden", role: "label", encoding: "utf8", span: ["cells"] },
    { name: "cell_type", role: "label", encoding: "categorical", span: ["cells"] },   // pandas Categorical → encoding "categorical"
    { name: "sample", role: "label", encoding: "utf8", span: ["cells"] },
    { name: "mito", role: "measure", encoding: "dense", span: ["cells"] },             // numeric → NOT a categorical
    { name: "counts", role: "measure", encoding: "csc", span: ["cells", "genes"] },    // matrix → excluded
  ];
  const { view, stats } = makeFakeView(fields);
  const ctx = new Ctx(view, {} as any);
  // NOTHING warmed (init NOT called) — enumeration must still be complete
  assert.deepEqual(ctx.catalogCategoricals(), ["leiden", "cell_type", "sample"], "catalog lists all categoricals (incl. encoding 'categorical'), excludes numeric/matrix, ordered common-first");
  assert.equal(stats().metaCalls["leiden"], undefined, "catalog enumeration issues NO reads");
  assert.deepEqual(ctx.categoricalFields(), [], "warmed accessor is empty before anything is read");
  // ctx.init() warms the universal minimum: embeddings + the DEFAULT GROUPING (leiden here) — the other labels
  // stay LAZY (cell_type/sample are not warmed until a panel pulls them)
  await ctx.init();
  assert.deepEqual(ctx.categoricalFields(), ["leiden"], "ctx.init() warms only the default grouping, not every label");
  // materialize the rest on use (what a panel does when it renders) → the warmed accessor reflects it, catalog-ordered
  await Promise.all([ctx.metaOf("leiden"), ctx.metaOf("cell_type"), ctx.metaOf("sample")]);
  assert.deepEqual(ctx.categoricalFields(), ["leiden", "cell_type", "sample"], "warmed set == the materialized categoricals, catalog-ordered");
});

test("ctx.init() warms embeddings + the default grouping in parallel; other labels stay lazy", async () => {
  const fields: FieldDef[] = [
    { name: "umap", role: "embedding" },
    { name: "pca", role: "embedding" },
    { name: "tsne", role: "embedding" },
    { name: "leiden", role: "label", encoding: "utf8", span: ["cells"] },
    { name: "cell_type", role: "label", encoding: "utf8", span: ["cells"] },
  ];
  const { view, stats } = makeFakeView(fields);
  const ctx = new Ctx(view, {} as any);
  await ctx.init();
  const s = stats();
  // the 3 embeddings + the default grouping all warm at once (the universal minimum); old serial loop peaked at 1
  assert.ok(s.maxConcurrent >= 3, `embeddings should warm in parallel, got maxConcurrent=${s.maxConcurrent}`);
  assert.equal(s.embCalls["umap"], 1, "umap read once (not re-read by the default-embedding fallback)");
  assert.equal(s.metaCalls["leiden"], 1, "the default grouping (leiden) IS warmed — the embedding's colour on first paint");
  // every OTHER label is lazy — a panel materializes it when it renders
  assert.equal(s.metaCalls["cell_type"], undefined, "a non-default label is NOT warmed by init (lazy)");
});

test("ctx.provision() warms declared needs eagerly + deduped (the panel-derived prefetch)", async () => {
  // provision is the successor to the boot recipe: panels DECLARE what they read (Need[]) and provision warms
  // it, so the prefetch tracks the mounted layout instead of a hardcoded list. Here: an {allObs} need (the
  // facet browser) warms EVERY per-cell obs column; obs/grouping needs warm one field; all deduped.
  const fields: FieldDef[] = [
    { name: "umap", role: "embedding", span: ["cells", "d2"] },
    { name: "leiden", role: "label", encoding: "utf8", span: ["cells"] },
    { name: "cell_type", role: "label", encoding: "categorical", span: ["cells"] },
    { name: "sample", role: "label", encoding: "utf8", span: ["cells"] },
    { name: "counts", role: "measure", encoding: "csc", span: ["cells", "genes"] },   // matrix — NOT an obs column
  ];
  const { view, stats } = makeFakeView(fields);
  const ctx = new Ctx(view, { state: { colorBy: "meta:leiden" } } as any);
  // {allObs} (the MetadataFacets need) warms every obs column; a duplicate obs need for `leiden` must NOT re-read.
  ctx.provision([{ kind: "allObs" }, { kind: "obs", field: "leiden" }, { kind: "grouping", name: "cell_type" }]);
  await new Promise((r) => setTimeout(r, 40));   // provision is fire-and-forget — let the warms resolve
  const m = stats().metaCalls;
  assert.equal(m["leiden"], 1, "leiden warmed once despite allObs + an explicit obs need (deduped)");
  assert.equal(m["cell_type"], 1, "cell_type warmed (obs column)");
  assert.equal(m["sample"], 1, "sample warmed (obs column)");
  assert.equal(m["counts"], undefined, "the count matrix is not an obs column — never warmed");
  assert.deepEqual(ctx.categoricalFields().sort(), ["cell_type", "leiden", "sample"], "provisioned obs columns are now materialized");
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

test("categorical order is deterministic (common names first, then store order) — catalog + warmed", async () => {
  // store field order deliberately scrambled vs COMMON_LABELS; `louvain` is an extra store label.
  const fields: FieldDef[] = [
    { name: "umap", role: "embedding", span: ["cells", "d2"] },
    { name: "louvain", role: "label", encoding: "utf8", span: ["cells"] },
    { name: "condition", role: "label", encoding: "utf8", span: ["cells"] },
    { name: "leiden", role: "label", encoding: "utf8", span: ["cells"] },
    { name: "sample", role: "label", encoding: "utf8", span: ["cells"] },
  ];
  const { view } = makeFakeView(fields);
  const ctx = new Ctx(view, {} as any);
  // CATALOG order (no reads): COMMON_LABELS-present first (leiden, sample, condition), then store-order (louvain)
  assert.deepEqual(ctx.catalogCategoricals(), ["leiden", "sample", "condition", "louvain"]);
  // the WARMED accessor matches once materialized (in scrambled completion order → still catalog-ordered)
  await Promise.all([ctx.metaOf("louvain"), ctx.metaOf("condition"), ctx.metaOf("leiden"), ctx.metaOf("sample")]);
  assert.deepEqual(ctx.categoricalFields(), ["leiden", "sample", "condition", "louvain"]);
});
