// Dense-value conversion. An int64/uint64 obs column arrives as a BigInt64Array, and the plain
// `Float32Array.from(bigIntArray)` this used to do THROWS ("Cannot convert a BigInt value to a number") —
// so metadata()/embedding() rejected instead of rendering. Found on a real Seurat-derived store whose
// `integrated_clusters` is int64: the throw was swallowed upstream, leaving the clustering invisible and an
// annotation elected as the reconcile base. Run: `node --test src/data/view.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toF32 } from "./view.ts";

test("toF32: int64 cluster ids convert (the BigInt trap)", () => {
  const big = BigInt64Array.from([11n, 1n, 6n, 3n, 0n]);
  assert.throws(() => Float32Array.from(big as any), TypeError, "precondition: the naive conversion really does throw");
  const out = toF32(big);
  assert.ok(out instanceof Float32Array);
  assert.deepEqual([...out], [11, 1, 6, 3, 0]);
});

test("toF32: uint64 converts too", () => {
  assert.deepEqual([...toF32(BigUint64Array.from([0n, 42n]))], [0, 42]);
});

test("toF32: a Float32Array passes through untouched (no copy)", () => {
  const f = Float32Array.from([1.5, 2.5]);
  assert.equal(toF32(f), f, "same reference — conversion must not copy the common case");
});

test("toF32: ordinary numeric arrays still convert", () => {
  assert.deepEqual([...toF32(Int32Array.from([3, 4]))], [3, 4]);
  assert.deepEqual([...toF32(Float64Array.from([1.25, -2]))], [1.25, -2]);
  assert.deepEqual([...toF32([7, 8])], [7, 8]);
});
