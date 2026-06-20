import { test } from "node:test";
import assert from "node:assert/strict";
import { poolSize } from "./pool.ts";

// The pool itself needs a browser Worker (OODA'd live under isolation); poolSize is the pure, testable part.
test("poolSize: hardwareConcurrency-1, clamped to 1..4", () => {
  assert.equal(poolSize(8), 4);    // min(4, 7)
  assert.equal(poolSize(16), 4);
  assert.equal(poolSize(5), 4);
  assert.equal(poolSize(4), 3);
  assert.equal(poolSize(2), 1);
  assert.equal(poolSize(1), 1);    // max(1, 0)
  assert.equal(poolSize(0), 3);    // unknown (0) → treat as 4 → 3
});
