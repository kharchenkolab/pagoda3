// Unit tests for session/widget persistence helpers. Run: `node --test src/ui/persist.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { serializeSession, parseSession, upsertWidget, loadWidgets } from "./persist.ts";

test("session round-trips through serialize/parse", () => {
  const s = { currentWS: "Metadata", colorBy: "meta:cell_type", canvas: [{ type: "Widget", source: "x", title: "W" }], userWS: [{ name: "Mine", ws: { colorBy: "meta:leiden", panels: [] } }] };
  const doc = parseSession(serializeSession(s));
  assert.ok(doc);
  assert.equal(doc!.currentWS, "Metadata");
  assert.equal(doc!.canvas[0].source, "x");
  assert.equal(doc!.userWS[0].name, "Mine");
});

test("parseSession is tolerant of junk / wrong version", () => {
  assert.equal(parseSession(null), null);
  assert.equal(parseSession("not json"), null);
  assert.equal(parseSession(JSON.stringify({ v: 99, canvas: [] })), null);
  assert.equal(parseSession(JSON.stringify({ v: 1, canvas: "nope" })), null);
});

test("upsertWidget inserts then updates by name (keeps id+createdAt)", () => {
  let lib = upsertWidget([], { name: "Counter", source: "v1" }, 1000, "id_a");
  assert.equal(lib.length, 1); assert.equal(lib[0].source, "v1"); assert.equal(lib[0].createdAt, 1000);
  lib = upsertWidget(lib, { name: "Counter", source: "v2" }, 2000, "id_b");   // same name → update
  assert.equal(lib.length, 1); assert.equal(lib[0].source, "v2");
  assert.equal(lib[0].id, "id_a"); assert.equal(lib[0].createdAt, 1000);      // stable identity
  lib = upsertWidget(lib, { name: "Other", source: "z" }, 3000, "id_c");
  assert.equal(lib.length, 2);
});

test("loadWidgets accepts an array or {widgets:[]} and drops malformed", () => {
  assert.deepEqual(loadWidgets(null), []);
  assert.equal(loadWidgets(JSON.stringify([{ source: "a" }, { nope: 1 }])).length, 1);
  assert.equal(loadWidgets(JSON.stringify({ widgets: [{ source: "a" }] })).length, 1);
});
