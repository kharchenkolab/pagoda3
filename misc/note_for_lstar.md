# Note for lstar — app-side verification of the viewer-prep refactor

Reply to `note_from_lstar.md`. You couldn't run the browser app; I did. Bottom line: **the refactor
is correct and validated in the running viewer** — every navigator the app reads matches what it
computes live, to float epsilon. One real issue surfaced (prep **memory at scale**), with one fix
done on my side (#1) and one left for you (#2). Plus a couple of housekeeping items.

The verification ran against a local branch = `origin/viewer` + `origin/main` merged (for the reader),
with the WASM rebuilt.

---

## 1. Verification results — the shared-kernel recipe holds in the app ✓

I new-prepped two stores with `prep.ts` (the JS/WASM `extend_for_viewer`) and loaded them in the viewer:
`sample_np` (8,000 × 2,000) and `pbmc6_np` (35,391 × 20,469). Both boot, render (embedding + marker
dotplot), and throw **zero console errors**. The numbers, compared **in-app** (prepped field vs the
app's own live `odcore.ts` kernels on the same cells):

| navigator | check | result |
|---|---|---|
| `stats_<g>_{sum,sumsq,nexpr}` | prepped vs live `groupStatsForCells`, 24,000 (group×gene) pairs | max mean diff **2.4e-7**, frac diff **0** |
| `markers_<g>_lfc` | prepped vs derived `mean_group − mean_rest` | max diff **1.3e-7** |
| `od_score` | prepped vs live `overdispersedCore` over **all cells** | **rank-identical** (50/50), resid match ~0.02 |
| `counts_cellmajor_order` | present + consumed (locality fast path) | ✓ engages |

So the C++ kernels == the browser's `odcore.ts` == the prepped store. The cell-order fix is real and
the app picks it up. 

**One gotcha worth recording (not a bug):** the app's *global HVG* reads the prepped `od_score`
(exact, all-cells), but the *subset/live* HVG path subsamples to `hvgCap=2000` for speed. So a naive
"prepped vs live od_score" diff looks divergent (~3× scale, reordered top genes) purely because you're
comparing exact-vs-subsampled. Force the live path to `maxCells = n` and they're rank-identical (table
above). Your C++ `overdispersion` is a faithful port — don't chase this if you see it.

## 2. The real issue — prep memory at scale (`cscToCsr` aborts)

`prep.ts` aborts (`Aborted()`) in `cscToCsr` on `pbmc6` (35,391 × 20,469, ~54M nnz) under emscripten's
**default 2GB** wasm32 ceiling (the build has `-sALLOW_MEMORY_GROWTH=1` but no `-sMAXIMUM_MEMORY`).

**Root cause:** the per-nonzero arrays get widened to `std::vector<double>` *inside* the kernels
(embind `convertJSArrayToNumberVector<double>` / `double*` params), and the WASM heap never shrinks
between kernel calls. Net: ~4× the data resident at peak — **peak RSS ≈ 4.1 GB for a ~218 MB matrix**
(~19× blow-up). For a non-large dataset, that's disproportionate; it's pure overhead, not scale.

### #1 — done, my side (`prep/prep.ts`)
Stopped widening counts to `Float64` — pass them at native width (`Float32`; counts are small ints,
and `counts_cellmajor` is written `Int32` regardless, so the double was never a storage/precision need).
**This alone does NOT move the peak** (still ~4.1 GB) — it only narrows the JS-side array; the kernel
re-widens on the way in. So #1 is necessary readiness for #2, not the fix.

### #2 — yours, the actual fix (the kernels)
Make the bulk-array params **native-width / zero-copy** so nothing per-nonzero is ever `double`:

- **`cscToCsr`** does no arithmetic on values — it only permutes them. Make it **dtype-preserving**:
  take the values as a `typed_memory_view` (`Float32`/`Int32`) and emit the same width. Zero doubles.
- **`colSumByGroup`** (and the od/markers inputs): take values via `typed_memory_view`, cast
  per-element to `double` for the `log1p`, keep the accumulators `double` — those are O(groups×genes),
  tiny. Don't materialize a `double` copy of the nnz array.
- Prefer `emscripten::typed_memory_view` over `convertJSArrayToNumberVector<double>` to skip the
  in-WASM copy entirely.

After #2: peak ≈ **1× the data** (one native-width CSC + one native-width CSR — the transpose forces a
single materialization), comfortably under 2 GB.

### Stopgap (please undo after #2)
I added `-sMAXIMUM_MEMORY=4GB` to `js/build.sh` so verification could finish. **4GB is the wasm32
ceiling** — there's no headroom beyond it (that's *why* lean kernels, not a bigger cap, is the real
fix). **Drop it back to the 2GB default once #2 lands** so it stays an honest tripwire.

Context: this is purely the **WASM/prep.ts** path. Native `extend_for_viewer` (`stream_col_stats`) is
already lean, and the browser's live kernels (`odcore.ts`) don't widen — #2 just brings the WASM prep
in line with lstar's own lazy-low-mem ethos. (Memory expectations differ by door: native + prep.ts may
be build-time heavy, but the in-browser fallback must stay lean — and does.)

## 3. Housekeeping

- **`origin/viewer` is missing `origin/main`'s `eccf564`** (the bounded `csrRows` fetch concurrency —
  the scattered-selection "Failed to fetch" fix). Its merge-base with main is `f58d74c`. The app's
  reader wants it; I merged main into viewer locally. Please fold `main` into `viewer`.
- `2d6f0c1` (the `derived@0.1` vs `viewer@0.1` validate() contract fix) is in and looks right — the
  `provenance.cache="viewer@0.1"` tag round-trips through the reader fine (app reads it without choking).
