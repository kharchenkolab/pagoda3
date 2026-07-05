// tooltrust: a link-origin (?ask=) auto-run gets the SAFE tool subset — code-executing / external tools withheld,
// view+compute tools kept. Run: node --test src/agent/tooltrust.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterTools, CODE_TOOLS } from "./tooltrust.ts";

const TOOLS = [
  { name: "update_view" }, { name: "compute" }, { name: "get_markers" }, { name: "describe_data" },
  { name: "manage_category" }, { name: "annotate" }, { name: "get_composition" }, { name: "add_note" },
  { name: "compute_code" }, { name: "fetch_url" }, { name: "preview_widget" }, { name: "save_widget" },
  { name: "edit_widget" }, { name: "get_widget_recipe" }, { name: "read_widget_contract" },
];

test("filterTools(restrictCode=false) returns the full list unchanged", () => {
  assert.equal(filterTools(TOOLS, false), TOOLS);
  assert.equal(filterTools(TOOLS), TOOLS);   // default = not restricted
});

test("filterTools(restrictCode=true) withholds the code/external tools, keeps view+compute", () => {
  const safe = filterTools(TOOLS, true).map((t) => t.name);
  // withheld: every code-executing / external tool
  for (const gone of ["compute_code", "fetch_url", "preview_widget", "save_widget", "edit_widget", "get_widget_recipe", "read_widget_contract"])
    assert.ok(!safe.includes(gone), `${gone} must be withheld from a link-origin ask`);
  // kept: the reversible view + compute surface
  for (const kept of ["update_view", "compute", "get_markers", "describe_data", "manage_category", "annotate", "get_composition", "add_note"])
    assert.ok(safe.includes(kept), `${kept} must stay available to a link-origin ask`);
});

test("CODE_TOOLS lists the executing/external tools (the withheld set)", () => {
  assert.ok(CODE_TOOLS.has("compute_code") && CODE_TOOLS.has("fetch_url") && CODE_TOOLS.has("preview_widget"));
  assert.ok(!CODE_TOOLS.has("update_view") && !CODE_TOOLS.has("compute"));
});
