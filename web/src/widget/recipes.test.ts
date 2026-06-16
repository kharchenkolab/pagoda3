// Each recipe must be a coherent, self-contained, themed widget that PARSES as JS. Run: `node --test src/widget/recipes.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { transformSync } from "esbuild";
import { RECIPES, listRecipes, getRecipe } from "./recipes.ts";

test("every recipe parses as JS, calls ready, themes via vars, pulls data, and avoids CDNs", () => {
  for (const r of RECIPES) {
    try { transformSync(r.source, { loader: "js" }); } catch (e) { assert.fail(`recipe "${r.name}" does not parse: ${String((e as any)?.message).split("\n")[0]}`); }
    assert.match(r.source, /pagoda\.ready\(/, `${r.name}: must call pagoda.ready()`);
    assert.ok(/var\(--/.test(r.source) || /['"]--\w/.test(r.source), `${r.name}: must theme via CSS vars (var(--...) or a '--var' name read from the computed style)`);
    assert.match(r.source, /pagoda\.data\(/, `${r.name}: should pull data via pagoda.data()`);
    assert.ok(!/https?:\/\/|cdn\.|import\s|require\(/.test(r.source), `${r.name}: must be self-contained (no external/CDN/import)`);
    assert.ok(r.name && r.title && r.about && r.techniques.length, `${r.name}: metadata complete`);
  }
});

test("listRecipes summarizes without source; getRecipe returns adaptable source or null", () => {
  const list = listRecipes();
  assert.equal(list.length, RECIPES.length);
  assert.ok(!("source" in (list[0] as any)), "list entries omit the (large) source");
  const got = getRecipe("scatter");
  assert.ok(got && got.includes("pagoda.ready") && got.startsWith("// RECIPE"));
  assert.equal(getRecipe("nope"), null);
});
