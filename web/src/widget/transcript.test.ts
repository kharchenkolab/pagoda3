// Unit tests for the transcript friction-analyzer. Run: `node --test src/widget/transcript.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { analyzeTranscript } from "./transcript.ts";

// a synthetic agent transcript (Anthropic message[]) exercising the signals the analyzer flags
const MSGS = [
  { role: "user", content: "build a scatter" },
  { role: "assistant", content: [{ type: "text", text: "Looking up snippets." }, { type: "tool_use", name: "find_widget_recipe", input: { query: "scatter hover" } }] },
  { role: "user", content: [{ type: "tool_result", content: JSON.stringify([{ name: "scatter", kind: "widget" }]) }] },
  { role: "assistant", content: [{ type: "tool_use", name: "get_widget_recipe", input: { name: "canvas-points" } }] },
  { role: "user", content: [{ type: "tool_result", content: "// SNIPPET canvas-points ..." }] },
  { role: "assistant", content: [{ type: "tool_use", name: "preview_widget", input: { source: "x".repeat(1200), probe: "await draw()" } }] },
  { role: "user", content: [{ type: "tool_result", content: JSON.stringify({ ok: true, error: null, logs: [{ args: ["probe error: foo is not a function"] }], renderedText: "[viz: canvas 460x260] gene A" }) }] },
  { role: "assistant", content: [{ type: "text", text: "The probe ran before the async draw completed, so it showed 0 points. Let me wait." }, { type: "tool_use", name: "preview_widget", input: { source: "y".repeat(1300) } }] },
  { role: "user", content: [{ type: "tool_result", content: JSON.stringify({ ok: false, error: "x is not defined", logs: [] }) }] },
  { role: "assistant", content: [{ type: "tool_use", name: "save_widget", input: { source: "z".repeat(1400), title: "Scatter" } }] },
  { role: "user", content: [{ type: "tool_result", content: "mounted widget panel #3" }] },
];

test("analyzeTranscript extracts metrics, previews, and the viz summary", () => {
  const r = analyzeTranscript(MSGS, 1234);
  assert.equal(r.durationMs, 1234);
  assert.equal(r.metrics.recipeLookups, 1);
  assert.deepEqual(r.metrics.recipesPulled, ["canvas-points"]);
  assert.equal(r.metrics.previews, 2);
  assert.equal(r.metrics.previewFails, 1);
  assert.equal(r.metrics.probeErrors, 1);
  assert.equal(r.metrics.saved, true);
  assert.equal(r.metrics.finalSrcLen, 1400);
  assert.equal(r.previews[0].viz, "[viz: canvas 460x260]");
  assert.equal(r.previews[0].probe, true);
});

test("analyzeTranscript auto-flags frictions: failed preview, probe error, agent self-report", () => {
  const r = analyzeTranscript(MSGS);
  const blob = r.frictions.join(" || ");
  assert.match(blob, /preview\(s\) failed: x is not defined/);
  assert.match(blob, /probe error\(s\)/);
  assert.match(blob, /agent noted:.*before the async draw completed/);
});

test("clean run flags nothing of note", () => {
  const clean = [
    { role: "user", content: "build" },
    { role: "assistant", content: [{ type: "tool_use", name: "preview_widget", input: { source: "s" } }] },
    { role: "user", content: [{ type: "tool_result", content: JSON.stringify({ ok: true, error: null, logs: [], renderedText: "[viz: svg 200x80 (6 circle)]" }) }] },
    { role: "assistant", content: [{ type: "tool_use", name: "save_widget", input: { source: "s" } }] },
    { role: "user", content: [{ type: "tool_result", content: "mounted" }] },
  ];
  const r = analyzeTranscript(clean);
  assert.equal(r.frictions.length, 0);
  assert.equal(r.metrics.saved, true);
});
