// Unit tests for session/widget persistence helpers. Run: `node --test src/ui/persist.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { serializeSession, parseSession, upsertWidget, loadWidgets, serializeBundle, parseBundle, fingerprintMismatch, widgetHash } from "./persist.ts";

test("session carries the dataset fingerprint + annotation layers through serialize/parse", () => {
  const s = { store: "/pbmc6.lstar.zarr", fingerprint: { n: 35391, fields: ["cell_type", "leiden"] }, currentWS: "Annotate", colorBy: "meta:annotation", canvas: [], userWS: [],
    annotation: [{ name: "annotation", source: "derived", categories: ["T", "B"], codes: [0, 1, 0, -1], records: { T: { name: "T cell" } } }] };
  const doc = parseSession(serializeSession(s))!;
  assert.equal(doc.fingerprint!.n, 35391);
  assert.deepEqual(doc.annotation![0].codes, [0, 1, 0, -1]);
  assert.equal(doc.annotation![0].records.T.name, "T cell");
});

test("session carries the conversation (chat log) — messages + history", () => {
  const s = { store: "/d.zarr", currentWS: "Metadata", colorBy: "meta:ct", canvas: [], userWS: [],
    conversation: { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "hello" }] }], history: [{ i: 0, q: "hi", why: "hello" }] } };
  const doc = parseSession(serializeSession(s))!;
  assert.equal(doc.conversation!.messages.length, 2);
  assert.equal(doc.conversation!.history[0].q, "hi");
  // tolerant: a doc with no conversation parses to undefined (not a crash)
  assert.equal(parseSession(serializeSession({ store: "x", currentWS: "", colorBy: "", canvas: [], userWS: [] }))!.conversation, undefined);
});

test("serializeBundle/parseBundle round-trips a self-contained document (session + widgets)", () => {
  const session = { store: "/d.zarr", fingerprint: { n: 100, fields: ["ct"] }, currentWS: "Metadata", colorBy: "meta:ct", canvas: [{ type: "Embedding" }], userWS: [] };
  const bundle = serializeBundle({ session: parseSession(serializeSession(session))!, widgets: [{ id: "w1", name: "W", source: "x", createdAt: 1 }], savedAt: 42 });
  const got = parseBundle(bundle)!;
  assert.ok(got); assert.equal(got.savedAt, 42);
  assert.equal(got.session.store, "/d.zarr"); assert.equal(got.session.canvas[0].type, "Embedding");
  assert.equal(got.widgets.length, 1); assert.equal(got.widgets[0].name, "W");
  assert.equal(parseBundle('{"kind":"not-ours"}'), null); assert.equal(parseBundle("junk"), null);
});

test("fingerprintMismatch flags a cell-count difference (decisive) and missing fields (informational)", () => {
  assert.equal(fingerprintMismatch({ n: 100, fields: ["a"] }, { n: 100, fields: ["a", "b"] }), null);   // subset of live fields → ok
  assert.match(fingerprintMismatch({ n: 100, fields: [] }, { n: 200, fields: [] })!, /different dataset/);
  assert.match(fingerprintMismatch({ n: 100, fields: ["x"] }, { n: 100, fields: ["a"] })!, /aren't in this dataset/);
  assert.equal(fingerprintMismatch(undefined, { n: 1, fields: [] }), null);   // older doc w/o fingerprint → can't compare → allow
});

test("session round-trips through serialize/parse, incl. the store key", () => {
  const s = { store: "/pbmc6.lstar.zarr", currentWS: "Metadata", colorBy: "meta:cell_type", canvas: [{ type: "Widget", source: "x", title: "W" }], userWS: [{ name: "Mine", ws: { colorBy: "meta:leiden", panels: [] } }] };
  const doc = parseSession(serializeSession(s));
  assert.ok(doc);
  assert.equal(doc!.store, "/pbmc6.lstar.zarr");   // scopes restore to the dataset
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

test("widgetHash (Item 2/C): stable per source, differs on any edit — the trust key follows the code", () => {
  const a = widgetHash("pagoda.ready({title:'x'})");
  assert.equal(a, widgetHash("pagoda.ready({title:'x'})"));   // deterministic
  assert.notEqual(a, widgetHash("pagoda.ready({title:'y'})"));   // an edit re-gates
  assert.match(a, /^[0-9a-f]{8}$/);                              // 8-hex
  assert.equal(widgetHash(""), widgetHash(""));
});

test("upsertWidget carries origin (authored vs imported) and preserves it on update", () => {
  let lib = upsertWidget([], { name: "W", source: "v1", origin: "imported" }, 1, "id1");
  assert.equal(lib[0].origin, "imported");
  lib = upsertWidget(lib, { name: "W", source: "v2" }, 2, "id2");   // update without origin keeps the prior one
  assert.equal(lib[0].origin, "imported");
  const authored = upsertWidget([], { name: "A", source: "s", origin: "authored" }, 1, "ida");
  assert.equal(authored[0].origin, "authored");
});
