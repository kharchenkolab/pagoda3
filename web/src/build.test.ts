// Guard: every source .ts must PARSE (esbuild transform). Catches syntax errors — e.g. an unescaped quote inside a
// big tool-description string in live.ts — that the unit tests miss because they don't import those modules.
// Run: `node --test src/build.test.ts`.
import { test } from "node:test";
import assert from "node:assert";
import { transformSync } from "esbuild";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("all src/*.ts parse (no syntax errors)", () => {
  const files = walk("src");
  const broken: string[] = [];
  for (const f of files) {
    try { transformSync(readFileSync(f, "utf8"), { loader: "ts" }); }
    catch (e) { broken.push(`${f}: ${String((e as any)?.message || e).split("\n")[0]}`); }
  }
  assert.deepEqual(broken, [], "files failed to parse:\n" + broken.join("\n"));
});
