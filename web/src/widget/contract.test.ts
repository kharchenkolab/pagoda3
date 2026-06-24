// Unit tests for the widget manifest validator (pure). Run: `node --test src/widget/contract.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { validateManifest, widgetLint } from "./contract.ts";

test("validateManifest: title/height/controls + typed PARAMS; junk filtered", () => {
  const m = validateManifest({
    title: "W", height: 99999,
    controls: [{ id: "go", label: "Go" }, { id: "x" /* no label */ }],
    params: [
      { id: "thr", label: "Threshold", type: "number", value: 5, min: 0, max: 100, step: 1 },
      { id: "mode", label: "Mode", type: "select", value: "a", options: ["a", "b"] },
      { id: "on", label: "On", type: "bool", value: true },
      { id: "bad", label: "Bad", type: "matrix", value: 0 },   // unknown type → dropped
      { label: "noId", type: "number", value: 1 },             // no id → dropped
    ],
  });
  assert.equal(m.title, "W");
  assert.equal(m.height, 2000);   // clamped
  assert.deepEqual(m.controls, [{ id: "go", label: "Go" }]);   // junk control dropped
  assert.equal(m.params!.length, 3);   // bad type + no-id dropped
  assert.deepEqual(m.params![0], { id: "thr", label: "Threshold", type: "number", value: 5, min: 0, max: 100, step: 1 });
  assert.deepEqual(m.params![1], { id: "mode", label: "Mode", type: "select", value: "a", options: ["a", "b"] });
  assert.equal(m.params![2].type, "bool");
  // select options accept {value,label} objects (a labelled menu) AND plain strings — must NOT stringify to "[object Object]"
  const lm = validateManifest({ params: [{ id: "rep", label: "View", type: "select", value: "cartoon", options: [{ value: "cartoon", label: "Cartoon" }, "stick"] }] });
  assert.deepEqual(lm.params![0].options, [{ value: "cartoon", label: "Cartoon" }, "stick"]);
});

test("validateManifest: module metadata — version/description/permissions (P4)", () => {
  const m = validateManifest({ version: "1.2.0", description: "  protein viewer  ", permissions: { external: ["UniProt.org", "  ", "rcsb.org"], compute: true } });
  assert.equal(m.version, "1.2.0");
  assert.equal(m.description, "  protein viewer  ");
  assert.deepEqual(m.permissions, { external: ["uniprot.org", "rcsb.org"], compute: true });   // lower-cased, blanks dropped
  assert.equal(validateManifest({ permissions: { external: [], compute: false } }).permissions, undefined);   // empty perms → omitted
  assert.equal(validateManifest({ version: 5 }).version, undefined);   // non-string ignored
});

test("validateManifest: tolerant of empty / missing", () => {
  assert.deepEqual(validateManifest(null), {});
  assert.deepEqual(validateManifest({}), {});
  assert.equal(validateManifest({ params: "nope" }).params, undefined);
});

test("widgetLint: advises a param for an internal RANGE slider, but never flags a <select> (bespoke UI is fine)", () => {
  const slider = "const i=document.createElement('input'); i.type='range'; i.oninput=()=>render();";
  const w = widgetLint(slider, { title: "x" });   // no params declared
  assert.equal(w.length, 1);
  assert.match(w[0], /range slider/);
  // a <select> (e.g. a 3D viewer's representation picker) is LEGITIMATE internal layout — must NOT be flagged anymore
  assert.deepEqual(widgetLint("body.innerHTML='<select><option>a</option></select>'", {}), []);
  // nor a plain text/number input that's part of the widget's own UI
  assert.deepEqual(widgetLint("const i=document.createElement('input'); i.type='number';", {}), []);
});

test("widgetLint: a well-formed param widget is clean", () => {
  const src = "pagoda.on('param',(id,v)=>{N=v;render();}); pagoda.ready({params:[{id:'n',type:'number',value:7}]});";
  assert.deepEqual(widgetLint(src, { params: [{ id: "n", label: "N", type: "number", value: 7 }] }), []);   // declares param + wires on('param') + no internal knob
});

test("widgetLint: declared-but-unwired params/controls, and undeclared fetch/compute", () => {
  // declares a param but never subscribes to on('param')
  assert.match(widgetLint("render();", { params: [{ id: "n", label: "N", type: "number", value: 1 }] })[0], /never calls on\('param'/);
  // declares a control but never on('control')
  assert.match(widgetLint("render();", { controls: [{ id: "go", label: "Go" }] })[0], /never calls on\('control'/);
  // fetches without declaring the host
  assert.match(widgetLint("pagoda.fetchExternal('https://x.org')", {})[0], /declares no permissions\.external/);
  // computes without declaring it
  assert.match(widgetLint("pagoda.runCompute('return 1')", {})[0], /permissions\.compute/);
  // fetch WITH the host declared → no fetch warning
  assert.equal(widgetLint("pagoda.fetchExternal('https://x.org')", { permissions: { external: ["x.org"] } }).length, 0);
});
