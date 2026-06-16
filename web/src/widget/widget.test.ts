// Unit tests for the widget contract (pure parts). Run: `node --test src/widget/widget.test.ts`.
// The iframe runtime is DOM-only (tested in the dev harness); here we cover the protocol + templates.
import { test } from "node:test";
import assert from "node:assert";
import { validateManifest, escapeForScript, widgetSrcdoc, WIDGET_BOOTSTRAP, WIDGET_API_DOC, WIDGET_BASE_CSS, DATA_KINDS } from "./contract.ts";
import { KITCHEN_SINK, BLANK_TEMPLATE, getWidgetTemplate } from "./template.ts";

test("validateManifest: keeps valid fields, drops junk, clamps height", () => {
  const m = validateManifest({ title: "X", height: 9999, controls: [{ id: "a", label: "A" }, { id: 7 }, { label: "no id" }, "junk"] });
  assert.equal(m.title, "X");
  assert.equal(m.height, 2000);                       // clamped
  assert.deepEqual(m.controls, [{ id: "a", label: "A" }]);   // only the well-formed control
  assert.deepEqual(validateManifest(null), {});
  assert.deepEqual(validateManifest({ height: -5 }), {});     // non-positive height dropped
});

test("escapeForScript neutralizes a </script> breakout", () => {
  const s = escapeForScript("a</script><script>evil()</script>b");
  assert.ok(!/<\/script>/i.test(s), "no literal </script> remains");
  assert.ok(s.includes("<\\/script>"));
});

test("widgetSrcdoc embeds base css, bootstrap and the (escaped) source", () => {
  const doc = widgetSrcdoc("pagoda.ready({title:'t'}); /* </script> */");
  assert.ok(doc.includes(WIDGET_BASE_CSS.trim().slice(0, 20)));
  assert.ok(doc.includes("window.pagoda"));            // bootstrap present
  assert.ok(doc.includes("pagoda.ready({title:'t'})")); // source present
  assert.ok(!/\/\* <\/script> \*\//.test(doc));         // source's </script> was escaped
});

test("bootstrap defines the documented pagoda surface", () => {
  for (const fn of ["on:", "ready:", "setSelection:", "setColor:", "setHint:", "updateView:", "data:", "cssVar:"]) {
    assert.ok(WIDGET_BOOTSTRAP.includes(fn), `bootstrap missing pagoda.${fn}`);
  }
  // every host→widget message the bootstrap must handle
  for (const t of ["init", "coord", "hint", "theme", "control", "snapshot", "data"]) {
    assert.ok(WIDGET_BOOTSTRAP.includes(`'${t}'`), `bootstrap missing handler for ${t}`);
  }
});

test("API doc mentions every data kind and the theme-vars rule", () => {
  for (const k of DATA_KINDS) assert.ok(WIDGET_API_DOC.includes(`'${k}'`), `doc missing data kind ${k}`);
  assert.match(WIDGET_API_DOC, /var\(--/);             // tells the agent to theme via CSS vars
  assert.match(WIDGET_API_DOC, /pagoda\.ready/);
});

test("templates are coherent starting points", () => {
  for (const src of [KITCHEN_SINK, BLANK_TEMPLATE]) {
    assert.match(src, /pagoda\.ready\(/, "a template must call pagoda.ready()");
    assert.match(src, /var\(--/, "a template must use theme vars");
  }
  // the kitchen-sink exercises the full surface
  for (const f of ["pagoda.setColor", "pagoda.setSelection", "pagoda.data", "pagoda.on('coord'", "pagoda.on('control'", "controls:"]) {
    assert.ok(KITCHEN_SINK.includes(f), `kitchen sink should demonstrate ${f}`);
  }
  assert.equal(getWidgetTemplate("blank"), BLANK_TEMPLATE);
  assert.equal(getWidgetTemplate(), KITCHEN_SINK);
});
