// pagoda3 prep — the offline "write_viewer" CLI. It DELEGATES to lstar's canonical `extendForViewer`
// (js/core/extend.ts) — the same recipe the browser (intake.ts) and lstar's own `extend-viewer.ts` use,
// bound to the shared C++/WASM kernels — so a pagoda3-prepped store is byte-identical to one prepped by
// Python / R / C++ / JS. pagoda3 does NOT keep its own copy of the recipe (see lstar docs/parity.md:
// "one recipe, N thin bindings"). This used to hand-roll the kernel sequence and diverged (assumed CSC,
// stubbed the reorder, truncated a lognorm basis to int); delegating removes that whole class of drift.
//
//   node --experimental-strip-types prep/prep.ts <store.lstar.zarr> [grouping] [also...] [counts=<field>] [basis=lognorm]
//
// Adds the viewer@0.1 navigators in place (counts_cellmajor + _order, per-grouping stats/markers, od_score).
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import { openLstar } from "../../lstar/js/core/reader.ts";
import { NodeFSStore } from "../../lstar/js/core/node-store.ts";
import { extendForViewer } from "../../lstar/js/core/extend.ts";

/** Prep a store for the viewer via lstar's shared recipe. Returns the navigator field names added. */
export async function prepStore(storePath: string, opts: { grouping?: string; also?: string[]; counts?: string; basis?: string } = {}): Promise<string[]> {
  const store = new NodeFSStore(storePath);
  const groupings = [opts.grouping, ...(opts.also ?? [])].filter(Boolean) as string[];   // explicit list wins; empty → lstar auto-detects via its policy
  await extendForViewer(store, { groupings: groupings.length ? groupings : undefined, counts: opts.counts, basis: opts.basis });
  const ds = await openLstar(new NodeFSStore(storePath));
  return ds.fieldNames().filter((n) => /^(counts_cellmajor|stats_|markers_|od_score)/.test(n));
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [storePath, grouping, ...rest] = process.argv.slice(2);
  if (!storePath) { console.error("usage: prep.ts <store.lstar.zarr> [grouping] [also...] [counts=<field>] [basis=lognorm]"); process.exit(1); }
  const kv: Record<string, string> = {};   // key=value tokens (counts=, basis=) are options; bare tokens are extra groupings
  const also = rest.filter((t) => { const i = t.indexOf("="); if (i > 0) { kv[t.slice(0, i)] = t.slice(i + 1); return false; } return true; });
  prepStore(storePath, { grouping, also, counts: kv.counts, basis: kv.basis }).then((f) => console.log("pagoda3 prep (via lstar extendForViewer): wrote", f.length, "navigators ->", storePath))
    .catch((e) => { console.error(e); process.exit(1); });
}
