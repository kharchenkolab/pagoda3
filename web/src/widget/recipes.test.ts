// Recipes (full widgets) + snippets (inlinable building blocks) must be coherent, self-contained, themed, and PARSE.
// Run: `node --test src/widget/recipes.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { transformSync } from "esbuild";
import { RECIPES, SNIPPETS, listRecipes, findRecipes, getRecipe } from "./recipes.ts";

const themed = (s: string) => /var\(--/.test(s) || /['"]--\w/.test(s);
// self-contained = no DIRECT network/code loading. https:// URLs are fine — they're passed to pagoda.fetchExternal
// (host-mediated). What's forbidden is a raw fetch()/XHR, an import, or a CDN <script>.
const selfContained = (s: string) => !/\bfetch\s*\(|XMLHttpRequest|\bimport\s|\brequire\(|cdn\.|<script/i.test(s);
const sourcesData = (s: string) => /pagoda\.data\(/.test(s) || /pagoda\.fetchExternal\(/.test(s);

test("every WIDGET recipe parses, calls ready, themes, pulls data, and is self-contained", () => {
  for (const r of RECIPES) {
    try { transformSync(r.source, { loader: "js" }); } catch (e) { assert.fail(`recipe "${r.name}" does not parse: ${String((e as any)?.message).split("\n")[0]}`); }
    assert.match(r.source, /pagoda\.ready\(/, `${r.name}: must call pagoda.ready()`);
    assert.ok(themed(r.source), `${r.name}: must theme via CSS vars`);
    assert.ok(sourcesData(r.source), `${r.name}: should pull data (pagoda.data or pagoda.fetchExternal)`);
    assert.ok(selfContained(r.source), `${r.name}: must be self-contained (no raw fetch/import/CDN)`);
  }
});

test("every SNIPPET parses, is themed where relevant, and is self-contained (no ready/data required)", () => {
  assert.ok(SNIPPETS.length >= 5, "should ship a useful set of building blocks");
  for (const s of SNIPPETS) {
    try { transformSync(s.source, { loader: "js" }); } catch (e) { assert.fail(`snippet "${s.name}" does not parse: ${String((e as any)?.message).split("\n")[0]}`); }
    assert.ok(selfContained(s.source), `${s.name}: must be self-contained`);
    assert.equal(s.kind, "snippet");
    assert.ok(s.name && s.title && s.about && s.techniques.length);
  }
});

test("findRecipes ranks by need; empty query returns all; getRecipe delivers source for both kinds", () => {
  const all = findRecipes("");
  assert.equal(all.length, RECIPES.length + SNIPPETS.length);
  const hover = findRecipes("scatter hover click").map((r) => r.name);
  assert.ok(hover.includes("hit-test") || hover.includes("scatter"), "hover/click query should surface hit-test/scatter");
  const colour = findRecipes("colour scale heatmap").map((r) => r.name);
  assert.ok(colour.includes("color"), "colour query should surface the color snippet");
  assert.ok(getRecipe("hit-test")!.startsWith("// SNIPPET"), "snippet delivery is labelled");
  assert.ok(getRecipe("scatter")!.startsWith("// RECIPE"), "widget delivery is labelled");
  assert.equal(getRecipe("nope"), null);
  assert.ok(listRecipes().some((r) => r.kind === "snippet") && listRecipes().some((r) => r.kind === "widget"));
});
