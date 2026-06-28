# Note from the lstar side — what changed on the `lstar` branch of this repo

This branch (`lstar`) reconciles pagoda3's store-prep onto **lstar's shared kernels + the `viewer@0.1`
contract**, eliminating the per-language prep drift and fixing a shipping bug in the cell ordering. It
**depends on the matching lstar work**, which currently lives on the lstar repo's **`viewer` branch**
(not yet merged to lstar `main`). Please review/test from your side; flagging everything that affects
the web app and the setup you'll need.

## TL;DR of behavioral changes (these affect the viewer)

1. **`od_score` is now pagoda2-style (lowess + F-test), not a raw lowess residual.** The old `prep.ts`
   wrote `residual = log(var) − lowess_trend`. It now writes `−log P(F > exp(residual); nobs, nobs)` —
   i.e. what your **live** `web/src/compute/odcore.ts` already computes. So **prepped `od_score` now
   equals the live value** (it didn't before). Any UI thresholds tuned against the old residual scale
   need re-checking.
2. **Cell ordering: the prep now matches what the reader/app already expected — this was a real bug.**
   - Old prep wrote a field named **`cell_order`** (a *listing* permutation, cluster-only) and did
     **not** physically reorder `counts_cellmajor`.
   - The reader (`lstar/js/core/reader.ts` `_rowMap`) and `web/src/data/view.ts` key on
     **`counts_cellmajor_order`** (a `pos_of` map: cell → physical row) and assume `counts_cellmajor`
     is **physically row-reordered** cluster-contiguous. So the locality fast path was silently dead
     (no `<name>_order` sibling found → stride-sampling fallback).
   - The prep now writes **`counts_cellmajor_order`** (`pos_of`) and **physically reorders**
     `counts_cellmajor` rows cluster-contiguous. The reader's `sampleRows`/`csrRows` locality path now
     actually engages. **No app code change needed** — the app already consumed this convention.
3. **`stats_*` / `markers_*` are computed via the shared WASM kernels** (`colSumByGroup`, the new
   `markersOneVsRest`), byte-identical to the live compute. Markers stay gene-major `ng×K`; stats
   group-major `K×ng` (unchanged orientation).
4. **The navigators carry a `cache` tag** (`provenance.cache = "viewer@0.1"`) — see "cache contract"
   below. **This does not change how the viewer reads them** (advisory metadata); it lets lstar's
   format-converters drop them on non-viewer export.

## File-by-file (the 4 commits on `lstar` vs `main`)

- **`prep/prep.ts`** — rewritten to compute everything via lstar's WASM kernels
  (`cscToCsr`, `colSumByGroup`, `markersOneVsRest`, `overdispersion`), fix the cell-order convention
  (above), and tag outputs `provenance.cache="viewer@0.1"`. Same field set as before, plus the order
  fix. Imports `lstar-js` (`../../lstar/js/core/{reader,writer,node-store}.ts`) and the WASM at
  `../../lstar/js/dist/lstar_kernels.mjs`.
- **`py/src/pagoda3/viewer.py`** — `write_viewer` is now a **thin wrapper** over
  `lstar.extend_for_viewer(ds, groupings=...)`. No prep math in pagoda3 anymore (the boundary decision:
  lstar owns the recipe; pagoda3 owns the policy = which groupings).
- **`r/R/write_viewer.R`** — same: thin wrapper over `lstar::extend_for_viewer(ds, ...)`.
- **`prep/reorder.mjs`, `prep/recompute_od.mjs`** — **deleted** (superseded by `prep.ts` on the shared
  kernels). Check you have no external references to them (I found none in-repo).
- **`py/tests/test_write_viewer.py`, `r/tests/testthat/test-write_viewer.R`** — updated to the corrected
  convention (`counts_cellmajor_order` + physical reorder); the R test adds a viewer-extended
  `fromLstar` cache-skip check.

## The `cache` contract (new, in lstar `docs/format.md`)

Each navigator field (`counts_cellmajor`, `counts_cellmajor_order`, `stats_<g>_*`, `markers_<g>_*`,
`od_score`) carries `provenance.cache = "viewer@0.1"`. Meaning: *regenerable cache of `counts` (+ the
grouping); carries no user decision.* It is **advisory** — read-by-name (the viewer, byte-range reads,
`lstar.read`) reads cache fields normally. Only lstar's **format-mapping converters** (`write_anndata`,
`write_seurat`, `write_sce`, pagoda2 `fromLstar`) act on it: they **drop cache fields and record them in
`dropped`** when exporting to a non-viewer object (so e.g. a re-exported AnnData doesn't get a redundant,
row-scrambled `counts_cellmajor` layer). The viewer is unaffected.

## What you need to build/test on your side

1. **Check out lstar's `viewer` branch as the sibling `../lstar`** (the prep + web imports resolve there).
   The required lstar work is on `viewer`, not `main` yet.
2. **Rebuild the lstar WASM kernels** so `dist/` exports the new `markersOneVsRest` + `overdispersion`
   (and `prep.ts` can import them):
   `cd ../lstar && LSTAR_EMCC_PYTHON=/path/to/python3.10 bash js/build.sh` (then the vite copy picks up
   `dist/lstar_kernels.mjs`). Note: `js/core/writer.ts` was fixed to **persist per-field `provenance`**
   (it previously hardcoded `{}`), which is what carries the `cache` tag into the store.
3. **py/r `write_viewer` now require the `lstar` package** (the `viewer`-branch version with
   `extend_for_viewer`): `lstar` Python on the path / `lstar` R installed.
4. **Suggested checks:**
   - A prepped store opens in the web app and the **live-vs-prepped** values agree (esp. `od_score`,
     now F-test on both sides).
   - The locality path: a cluster/lasso selection now coalesces into a few byte-range reads (the
     `counts_cellmajor_order` sibling is found and used) — previously it fell back to stride sampling.
   - Cross-check: `bash ../lstar/conformance/viewer.sh` with `PAGODA3=$(pwd)` runs leg (c)
     (lstar-prep == pagoda3 `prep.ts`) — it should be green.

## Coordination
The lstar-side changes are on lstar branch **`viewer`** (kernels, `read_pagoda2`, the `cache` spec, the
`writer.ts` provenance fix, `extend_for_viewer` in py/R, the `lstar viewer` CLI). They should land in
lstar before/with this branch. Questions → ping the lstar side.
