import { test } from "node:test";
import assert from "node:assert/strict";
import { ResultRegistry, type SessionResult } from "./results.ts";

const mk = (name: string, who: "user" | "agent" = "user"): Omit<SessionResult, "id"> => ({
  name, kind: "de", spec: { stat: "de", A: { category: { grouping: "cell_type", value: name } } }, who, when: 1, summary: "cell-level", bind: "de:between", rows: [{ symbol: "GENE", lfc: 1 }],
});

test("ResultRegistry: add is newest-first, stable ids, get/remove/rename", () => {
  const r = new ResultRegistry();
  const a = r.add(mk("A")); const b = r.add(mk("B"));
  assert.notEqual(a.id, b.id);
  assert.deepEqual(r.list().map((x) => x.name), ["B", "A"]);   // newest first
  assert.equal(r.get(a.id)!.name, "A");
  assert.equal(r.rename(a.id, " renamed "), true);
  assert.equal(r.get(a.id)!.name, "renamed");                  // trimmed
  assert.equal(r.rename(a.id, "  "), false);                   // empty rejected
  assert.equal(r.remove(b.id), true);
  assert.equal(r.remove(b.id), false);                         // already gone
  assert.deepEqual(r.list().map((x) => x.name), ["renamed"]);
});

test("ResultRegistry: serialize/restore round-trips and continues ids; spec is deep-copied", () => {
  const r = new ResultRegistry();
  r.add(mk("X")); const y = r.add(mk("Y"));
  const ser = r.serialize();
  assert.equal(ser.length, 2);
  (ser[0].spec as any).A = { all: true };                      // mutate the snapshot
  assert.notDeepEqual(r.get(y.id)!.spec, ser[0].spec);         // live record untouched (deep copy)

  const r2 = new ResultRegistry();
  r2.restore(ser);
  assert.deepEqual(r2.list().map((x) => x.name), ["Y", "X"]);
  const z = r2.add(mk("Z"));                                   // new id must not collide with restored ones
  assert.equal(r2.get(z.id)!.name, "Z");
  assert.equal(new Set(r2.list().map((x) => x.id)).size, 3);   // all ids distinct
  r2.restore(null as any);                                     // non-array → no-op
  assert.equal(r2.list().length, 3);
});
