// storecheck: the remote-store sibling of h5adcheck. Every fixture here is HOSTILE by design — the bug
// that motivated this file survived a 72-test suite on the serving side because that suite's fake set
// its flags more cooperatively than the real substrate did, and my own first pass at these checks was
// blessed twice by stubs that answered every question the same way. Run:
//   node --test src/data/storecheck.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { findBasis, checkViewerContract, expectedChunkBytes, shortReadIssue, nnzMismatch, summarize } from "./storecheck.ts";

const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

// A store shaped exactly like a healthy viewer@0.1 one.
const healthy = () => ({
  axes: ["cells", "genes", "groups_leiden"],
  fields: {
    counts: { encoding: "csc", span: ["cells", "genes"], role: "measure", provenance: { viewer: "basis" } },
    counts_cellmajor: { encoding: "csr", span: ["cells", "genes"], role: "measure" },
    stats_leiden_sum: { span: ["groups_leiden", "genes"] },
    stats_leiden_sumsq: { span: ["groups_leiden", "genes"] },
    stats_leiden_nexpr: { span: ["groups_leiden", "genes"] },
    markers_leiden_lfc: { span: ["genes", "groups_leiden"] },
    markers_leiden_padj: { span: ["genes", "groups_leiden"] },
  } as any,
});

test("contract: a healthy viewer store raises nothing", () => {
  assert.deepEqual(checkViewerContract(healthy()), []);
});

test("basis: the stamp wins over a field merely NAMED counts", () => {
  const spec = {
    axes: [],
    fields: {
      counts: { encoding: "csr", span: ["cells", "genes"] },
      logcounts: { encoding: "csc", span: ["cells", "genes"], provenance: { viewer: "basis" } },
    } as any,
  };
  assert.equal(findBasis(spec)!.name, "logcounts");
  assert.deepEqual(checkViewerContract(spec, false), [], "the stamped basis is gene-major, so nothing to report");
});

test("basis: falls back to `counts` on a store prepped before the stamp existed", () => {
  const spec = { axes: [], fields: { counts: { encoding: "csc", span: ["cells", "genes"] } } as any };
  assert.equal(findBasis(spec)!.name, "counts");
});

test("contract: a cell-major basis is a WARNING, not an error — the viewer still works", () => {
  const s = healthy(); s.fields.counts.encoding = "csr";
  const issues = checkViewerContract(s);
  assert.deepEqual(codes(issues), ["basis-not-gene-major"]);
  assert.equal(issues[0].level, "warn", "degraded, not broken: gene columns come from the cell-major copy");
  assert.match(issues[0].message, /Re-run the viewer prep/);
});

test("contract: no basis at all is an error and short-circuits", () => {
  const issues = checkViewerContract({ axes: [], fields: { umap: { span: ["cells", "umap"] } } as any });
  assert.deepEqual(codes(issues), ["no-basis"]);
});

test("contract: a TRANSPOSED stats table is caught (it would read as plausible numbers)", () => {
  const s = healthy(); s.fields.stats_leiden_sum.span = ["genes", "groups_leiden"];
  assert.deepEqual(codes(checkViewerContract(s)), ["stats-orientation"]);
});

test("contract: a TRANSPOSED markers table is caught", () => {
  const s = healthy(); s.fields.markers_leiden_lfc.span = ["groups_leiden", "genes"];
  assert.deepEqual(codes(checkViewerContract(s)), ["markers-orientation"]);
});

test("contract: cell-major copy with the wrong encoding or span", () => {
  const a = healthy(); a.fields.counts_cellmajor.encoding = "csc";
  assert.deepEqual(codes(checkViewerContract(a)), ["cellmajor-orientation"]);
  const b = healthy(); b.fields.counts_cellmajor.span = ["genes", "cells"];
  assert.deepEqual(codes(checkViewerContract(b)), ["cellmajor-orientation"]);
});

test("contract: a half-written grouping is caught", () => {
  const a = healthy(); delete (a.fields as any).stats_leiden_nexpr;
  assert.deepEqual(codes(checkViewerContract(a)), ["stats-incomplete"]);
  const b = healthy(); b.axes = ["cells", "genes"];
  assert.deepEqual(codes(checkViewerContract(b)), ["stats-no-axis"]);
});

test("contract: a non-standard basis axis name is respected, not assumed", () => {
  // a store whose axes aren't literally cells/genes must not be reported as transposed
  const spec = {
    axes: ["obs", "var", "groups_ct"],
    fields: {
      counts: { encoding: "csc", span: ["obs", "var"], provenance: { viewer: "basis" } },
      counts_cellmajor: { encoding: "csr", span: ["obs", "var"] },
      stats_ct_sum: { span: ["groups_ct", "var"] }, stats_ct_sumsq: { span: ["groups_ct", "var"] },
      stats_ct_nexpr: { span: ["groups_ct", "var"] },
      markers_ct_lfc: { span: ["var", "groups_ct"] }, markers_ct_padj: { span: ["var", "groups_ct"] },
    } as any,
  };
  assert.deepEqual(checkViewerContract(spec), []);
});

// --- reachability ------------------------------------------------------------------------------------
test("expectedChunkBytes: computable only for an uncompressed single-chunk 1-D array", () => {
  const base = { dataType: "int32", shape: [1000], chunkShape: [1000], codecs: ["bytes"] };
  assert.equal(expectedChunkBytes(base), 4000);
  assert.equal(expectedChunkBytes({ ...base, dataType: "int64" }), 8000);
  assert.equal(expectedChunkBytes({ ...base, codecs: ["bytes", "zstd"] }), null, "compressed: size unpredictable");
  assert.equal(expectedChunkBytes({ ...base, codecs: ["sharding_indexed"] }), null, "sharded: many objects");
  assert.equal(expectedChunkBytes({ ...base, chunkShape: [128] }), null, "multi-chunk: no single object");
  assert.equal(expectedChunkBytes({ ...base, dataType: "weird" }), null);
  assert.equal(expectedChunkBytes({ ...base, shape: [10, 10] }), null);
  assert.equal(expectedChunkBytes({}), null);
});

test("shortReadIssue: the real numbers from the incident", () => {
  const i = shortReadIssue("fields/counts/indices/c/0", 87822584, 16777216)!;
  assert.equal(i.level, "error");
  assert.equal(i.code, "short-object");
  assert.match(i.message, /16,777,216 bytes of 87,822,584/);
  assert.match(i.message, /19\.1%/);
  assert.match(i.message, /cache or proxy/, "must point at the transport, not accuse the file");
});

test("shortReadIssue: silent when the server declares nothing (cross-origin, no exposed headers)", () => {
  assert.equal(shortReadIssue("p", 100, null), null);
  assert.equal(shortReadIssue("p", 100, undefined), null);
  assert.equal(shortReadIssue("p", 100, NaN), null);
});

test("shortReadIssue: exact match is silent; oversized is only a warning", () => {
  assert.equal(shortReadIssue("p", 4000, 4000), null);
  assert.equal(shortReadIssue("p", 4000, 4096)!.level, "warn");
});

test("nnzMismatch: indptr end must agree with the declared nnz", () => {
  assert.equal(nnzMismatch("counts", 12000, 12000), null);
  assert.equal(nnzMismatch("counts", 12000, 9000)!.code, "nnz-mismatch");
  assert.equal(nnzMismatch("counts", NaN, 9000), null, "unknown -> no claim");
});

test("summarize: errors before warnings", () => {
  const s = summarize([
    { level: "warn", code: "w", message: "second" },
    { level: "error", code: "e", message: "first" },
  ]);
  assert.equal(s, "✕ first\n⚠ second");
});
