// Unit tests for the EMBEDDING panel's OWN style descriptor (pure — no deck.gl). Run: `node --test src/render/embedding.style.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { defaultEmbeddingStyle, EMBEDDING_RANGES, EMBEDDING_STYLE } from "./embedding.style.ts";
import { getStyle } from "./style.ts";

test("defaults are theme-aware; values === the former inline literals (byte-identical at rest)", () => {
  const dark = defaultEmbeddingStyle(true), light = defaultEmbeddingStyle(false);
  assert.equal(dark.point.radius, 2.4);
  assert.equal(dark.point.opacity, 0.7);
  assert.equal(dark.label.fontSize, 12.5);
  assert.equal(dark.label.weight, 700);
  assert.equal(dark.fit.pad, 0.86);
  assert.deepEqual(dark.label.textColor, [240, 244, 250, 255]);
  assert.deepEqual(light.label.textColor, [38, 50, 58, 255]);   // theme split
});

test("ranges cover the numeric knobs", () => {
  assert.deepEqual(EMBEDDING_RANGES["point.radius"], [0.3, 20]);
  assert.deepEqual(EMBEDDING_RANGES["label.weight"], [100, 900]);
  assert.deepEqual(EMBEDDING_RANGES["fit.pad"], [0.3, 1]);
});

test("fromDisplay maps the legacy display knobs into the panel's own style vocabulary", () => {
  assert.deepEqual(EMBEDDING_STYLE.fromDisplay!({ alpha: 0.4 }), { point: { opacity: 0.4 } });
  assert.deepEqual(EMBEDDING_STYLE.fromDisplay!({ labels: false }), { label: { show: false } });
  assert.deepEqual(EMBEDDING_STYLE.fromDisplay!({ legend: true }), { legend: { show: true } });
  assert.deepEqual(EMBEDDING_STYLE.fromDisplay!({ winsor: 0.05 }), { color: { winsor: 0.05 } });
  assert.deepEqual(EMBEDDING_STYLE.fromDisplay!({}), {});   // nothing set → empty
});

test("self-registers with the core on import (the plug point — no central edit)", () => {
  assert.equal(getStyle("Embedding"), EMBEDDING_STYLE);   // importing this module registered it
});
