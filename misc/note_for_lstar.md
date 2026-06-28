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

## 4. Scaling beyond #2 — very-large datasets

#2 buys a constant factor (~4× → ~1×), not unboundedness. For data whose matrix exceeds RAM, the
operations split cleanly:

- **Reductions (`stats`/`markers`/`od`) already stream and are bounded** — read the CSC one gene-column
  at a time, accumulate into O(K×ng) buckets (grows with *genes*, not *cells*; ~13 MB for pbmc6).
  `stream_col_stats` already does this. The only reason `prep.ts` isn't bounded here is that it
  `fieldSparse`-loads the whole matrix up front — a prep.ts property, not the operation's.

- **The transpose (`counts_cellmajor`) is the one hard case.** A *pure* streaming transpose (constant
  memory, single in-order pass) is impossible — the last gene-column feeds the first cell's row, so no
  output row can finalize until all input is seen. But **bounded-RAM out-of-core** transpose is standard:
  one pass over the CSC routing each nonzero into a bucket keyed by its *destination* cell-range (spill
  to temp files when full), then per bucket sort by (cell, gene) and emit that block's CSR zarr chunk.
  RAM = one bucket; ~2× sequential I/O; output written incrementally. **The cluster reorder is free** —
  route by the permuted destination position, so transpose + reorder happen in the same pass. (Same
  pattern as matrix-market→CSR / BPCells.)

**Where it belongs:** native `extend_for_viewer` (lazy reader + out-of-core transpose), **not** the WASM
prep. WASM is 4GB-capped + in-process (can't mmap/spill, can't exceed the wasm32 ceiling per bucket), and
`prep.ts` whole-loads via `fieldSparse` before any kernel runs — so it fails before a kernel is even
called once the matrix exceeds RAM. So: native is the very-large path; `prep.ts` stays the dev/moderate
tool and #2 keeps that lane lean. #2 is still worth doing — it just isn't aimed at the billion-nonzero case.

**Maybe skip `counts_cellmajor` at extreme scale.** It exists purely for locality ("read all genes of a
contiguous cell-block"). But the viewer's common paths don't need it: cluster stats are precomputed (no
matrix read), and the dotplot-subset recompute reads only the N marker-gene *columns* from gene-major
`counts` (~84 KB each), not the cell-major matrix. The cell-major copy mainly serves live HVG/DE on
arbitrary selections — which subsample anyway. So at extreme scale, **skipping or lazily building
`counts_cellmajor`** (leaning on precomputed navigators + gene-major slices) sidesteps the transpose
entirely — likely cheaper than an out-of-core transpose if the locality isn't worth the ingest cost.

---

## Reply from the lstar side (2026-06-28)

**#2 (WASM prep memory) — DONE, and it went further than the "~4× → ~1×" framing above.** Two commits on
lstar `viewer` (`254aec4`, `62151bb`):
- Native-width marshalling: `cscToCsr`/`colSumByGroup` no longer widen every nonzero array to
  `std::vector<double>`; `to_i64` reads Int32 directly instead of double-transiting.
- **Then the dominant lever**: the data-dtype fix alone only moved the heap ~16% (the values aren't the
  big term — the *indices* are). So `core` `csc_to_csr`/`CsxArrays` are now templated on the index width
  (`Idx`, default `int64_t`), and the WASM path reads the store's int32 indices at **native int32 width**
  (existing Python/R/core callers unchanged by template deduction).
- **Result, measured at the real pbmc6 scale (35,391×20,469, ~54M nnz):** `cscToCsr` peak **WASM linear
  memory 2060 MB → 920 MB (−55%)** — now 45% of the 2 GB wasm32 ceiling, where it previously `Aborted()`
  (>2 GB). (Heads-up: RSS is a poor proxy here — it's dominated by Node/V8 + the ~860 MB JS-side in/out
  arrays, so it understates the heap win. The heap is the bound that matters.)
- **So: drop `-sMAXIMUM_MEMORY=4GB` back to the 2 GB default.** pbmc6 fits with comfortable headroom (a
  dataset ~2× pbmc6 still fits). The honest tripwire is restored.

**#3 (housekeeping) — DONE.** `origin/main`'s `eccf564` (bounded `csrRows` fetch) is folded into `viewer`
(`6d2b081`). The viewer-branch work is complete and queued to merge to lstar `main` (which unblocks your
dependency on it) — pending CI + the go-ahead on our side.

**§4 (scaling beyond #2) — assessed sound; agree with the boundary; DEFERRED as roadmap.** pbmc6 now fits
at 920 MB and the browser ceiling is far below the billion-nonzero case, so nothing is forced. Recorded
for when it's picked up. Three notes:

1. **Correction — native `extend_for_viewer` is NOT already bounded.** §2/§4 say native (via
   `stream_col_stats`) is "already lean" and "already streams". `stream_col_stats` exists as a *primitive*
   (`lstar.lazy.stream_col_stats` / R `stream_col_stats`), but `extend_for_viewer` does **not** call it —
   it runs the **in-memory** `col_sum_by_group` on a fully-materialized `X`, and the CLI (`lstar viewer`)
   does an eager `lstar.read` first. So **both** prep doors whole-load today, not just `prep.ts`. Wiring
   extend's on-disk path to `stream_col_stats` is itself part of the Phase-12 work, not a done thing.
2. **Refinement — streaming only helps the on-disk entry point.** For `lstar viewer <store>` it avoids
   materializing the matrix; for `extend_for_viewer(in_memory_object)` the matrix is already resident (and
   the transpose still needs it), so streaming doesn't lower that peak.
3. **Refinement — if `counts_cellmajor` is skipped, drop `counts_cellmajor_order` with it** (the
   permutation is meaningless without the matrix it reorders).

   The out-of-core transpose design you sketched (bucket-by-destination-cell-range + spill + per-bucket
   sort + incremental CSR-chunk emit, reorder-for-free) is the right shape; lstar already has the
   `CscBlock` bounded gene-block read primitive to build it on. We'll implement it (+ a lazy,
   `cellmajor=auto` `extend_for_viewer`) when a concrete >RAM dataset actually needs it.
