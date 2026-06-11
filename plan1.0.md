# pagoda2 browser — implementation plan (plan1.0)

The build plan for a **real, running** pagoda2 browser that puts the agent-driven
generative viewer of [`plan1.md`](plan1.md) on top of an actual processed dataset, served
through lstar, with a real Anthropic agent in place of the mock's keyword matcher.

## 0. What this is, and the document map

| Document | Role | Status |
|---|---|---|
| [`plan1.md`](plan1.md) | **The canonical viewer design** — interaction model, coordination space, ladder of restraint, five presence modes, handle-borne provenance, component vocabulary | done (design) |
| [`pagoda2-production.html`](pagoda2-production.html) | The clickable mock embodying `plan1.md` — the thing we **port** to real data | done (mock) |
| **`plan1.0.md` (this)** | How we wire real pagoda2.1 data through lstar into that viewer, with a real agent | this doc |
| `../lstar/misc/views.md` | **Data-layer guidance only** — what the store must serve cheaply (profile, kernels, sparse reads) | reference |

> **Correction that shapes everything below.** `views.md` points at an older "reference
> viewer" (`app_prop2.md`) — a conventional linked-dashboard design. **We are not building
> that.** We are building the agent-driven viewer of `plan1.md`. From `views.md` we take only
> its *data primitives* (the viewer profile, the WASM kernels, the sparse access patterns);
> we ignore its app-shell / crossfilter-dashboard assumptions.

The thesis is unchanged from `plan1.md`: *stability is the default; the agent drives a shared
coordination space and earns bigger moves; provenance travels with the data.* plan1.0 makes
that real on **GSE192391 sample 1** (human PBMC scRNA-seq).

---

## 1. Target architecture

Four parts, one data flow:

```
 GSE192391 / GSM5746259 (10x triplet)
        │  R · pagoda2.1
        ▼
 [A] data pipeline ─────────────────────────────►  pagoda2_GSM5746259.rds
        │  R · lstar  (write_pagoda2 + write_viewer)
        ▼
 sample.lstar.zarr   (counts CSC, embedding, clusters, gene meta,
                      markers, cluster stats, cell-major DE panel, aspects)
        │  static HTTP (chunked + consolidated .zmetadata)
        ▼
 [C] web app (Vite + TS)
        ├── data layer:  lstar-js (zarrita FetchStore) + WASM kernels  ◄── [B] lstar extensions
        ├── coordination space (coord) ── reads lstar, drives all views
        ├── render: deck.gl embedding + DOM/SVG panels (ported from the mock)
        └── agent:  Anthropic Opus, tool-use loop over coord + lstar queries
                         │  Authorization: Bearer + oauth beta header
                         ▼
 [D] auth/api proxy (Node)  ── OAuth PKCE token exchange + Messages API proxy
```

- **[A] Data pipeline** (offline, R): process the sample, export a `.lstar.zarr`.
- **[B] lstar extensions** (the shared library work — committed to the `lstar` repo, not the
  app): a `write_pagoda2` exporter, the `viewer@0.1` profile, the two missing WASM kernels,
  `csrRow`, and a browser `FetchStore` adapter. These are the `views.md` "Phase D" gaps.
- **[C] Web app** (the bulk of the work): the `plan1.md` viewer, ported from the mock to TS,
  backed by real lstar data, with the real agent.
- **[D] Auth/api proxy** (small Node service): OAuth (UI-forwarded PKCE) + a Messages-API
  passthrough so the browser never holds a long-lived secret and CORS is clean.

---

## 2. Stack decisions (and why)

| Decision | Choice | Rationale |
|---|---|---|
| App build | **Vite + TypeScript** | fast HMR; consumes lstar-js's raw `.ts` + the WASM ESM module cleanly |
| UI substrate | **Vanilla TS + DOM/SVG, ported from the mock** | the mock is already DOM; the design is bespoke, not form-heavy — a framework adds weight without benefit. A tiny reactive `coord` store gives us the data-binding we need. (Revisit if the team prefers React/Svelte.) |
| Embedding render | **deck.gl `ScatterplotLayer`** | the one panel that must scale to 10⁴–10⁶ points; WebGL, GPU-colored from a typed-array attribute (`scalarToRGBA`). Everything else stays SVG/DOM from the mock. |
| Data layer | **lstar-js** (`openLstar`, `LstarView`) over **zarrita `FetchStore`** | the seam is already built (Phases A–C of views.md); we add the browser store adapter + the missing view methods |
| Compute | **lstar WASM kernels** (`createLstarKernels`) | "one kernel, every runtime" — browser numbers match R/Python. DE by **subsampling** (below) |
| Agent | **`@anthropic-ai/sdk`**, model **`claude-opus-4-8`**, adaptive thinking, streaming, tool-use loop | replaces the mock's `agent()` regex with a real planner |
| Auth | **OAuth PKCE** (UI-forwarded redirect) + thin **Node proxy** (`Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`); API-key mode stubbed for later | keeps secrets server-side; handles CORS + token refresh |
| lstar dependency | the app references the **sibling `../lstar` repo** (js by path, R for the pipeline). lstar changes are committed to `lstar`, not the app | keeps the data layer reusable; conformance stays in lstar |
| Store transport | **static HTTP**, chunked + consolidated `.zmetadata` (Zarr v2 now; v3+sharding later) | one sample streams fine over plain HTTP; v3 sharding is the remote-scale lever (Phase 8) |

---

## 3. What we extend in lstar / pagoda2 (the gaps)

Confirmed by source analysis. Most work is in **lstar** (the data layer); pagoda2 needs at
most small accessor hardening.

**lstar — R (pipeline side):**
- `write_pagoda2(p2)` — **does not exist.** A single-sample exporter modeled on
  `profile_conos.R` + `profile_sce.R` (≈30 lines + a DE reshape). Reads `getRawCounts()`,
  `reductions$PCA`, `embeddings$PCA$UMAP`, `cellMeta` groupings (`leiden`/`cell_type`),
  `diffgenes`/marker results, `misc$varinfo` (overdispersion), `misc$pathwayOD/ODInfo`. Maps
  to L★ per `Lstar_proposal.md` B.4. **Must use `getRawCounts()` — `$counts` is a hard error
  in 2.1.**
- `write_viewer(ds, …)` — the **`viewer@0.1` profile**, the biggest new piece. Precompute, as
  ordinary L★ fields (no schema slot):
  - **cluster sufficient stats** — `measure (grouping, genes)` holding sum/sumsq/n_expr →
    instant grouped heatmaps + cluster markers, no matrix read.
  - **marker tables** — `markers.<grouping>.lfc` / `.padj` : `measure (genes, group)` (+
    `uncertainty`) → default ranked tables; populated from pagoda2's DE.
  - **cell order** — a permutation `measure (cells)` (embedding/dendrogram-coherent) so a
    selection maps to near-contiguous chunks.
  - **cell-major DE panel** — `measure (cells, od_genes)` (CSR or dense uint8), OD genes only,
    in cell order → **subsample DE on arbitrary selections at constant cost.**
  - **normalization recipe** — store raw counts + the lognorm recipe (or provenance on `data`).

**lstar — C++ core + WASM (`lstar.hpp`, `lstar_wasm.cpp`):**
- `csc_col_sum_by_group(...)` → sum/sumsq/n_expr per (group, gene) — **gap.** Powers cluster
  stats + heatmaps.
- `subsample_de_rank(...)` — AUC/Wilcoxon-or-fold-change ranker over a small cell-major
  submatrix — **gap.** Promote the JS `view.subsampleDE` full-pass to this kernel.
- Each gets a cross-language conformance row (WASM == Python).

**lstar — js (`reader.ts` / `view.ts`):**
- `csrRow(field, row)` mirroring `cscColumn` — **gap** (one cell's genes; reads the DE panel).
- `view.groupStats()`, `view.markers()` — use the precomputed fields when present.
- A browser **`FetchStore` adapter** (zarrita provides it; wire it next to `NodeFSStore`).
- `dequantize` for quantized embeddings (later).

**pagoda2 — devel:** no structural change expected. Only harden the accessors the exporter
touches (`getRawCounts`, marker result accessor, `misc$pathwayOD*`), routing anything absent
to `ds$dropped` rather than erroring — the version-detect-and-fallback pattern from
`profile_conos.R`.

---

## 4. The real coordination space & handle catalog (for this dataset)

The mock's `coord` and `HANDLES` become **real**, bound to lstar fields.

```ts
coord = {
  colorBy:   Handle,            // meta:leiden | meta:cell_type | gene:<SYMBOL> | geneset:<id> | qc:<metric>
  focus:     {dim, value}|null, // e.g. condition/sample subsetting
  selection: {ids:Int32Array, handle, composition},
  geneFocus: Handle|null,       // cross-view highlight of one gene
  contrast:  Handle|null,       // active DE contrast (cluster k vs rest, or A vs B)
  thresholds:{lfc, padj},
}
```

Handles resolve against the lstar manifest + the viewer profile:

| Handle | lstar source | Used by |
|---|---|---|
| `embedding:main` | `embedding "umap"` field | the deck.gl scatter |
| `gene:<SYMBOL>` | `cscColumn(counts, geneIdx)` → `geneExpression` (lognorm) | colorBy, box-by-sample |
| `meta:leiden` / `meta:cell_type` | `metadata(field)` (label codes) | colorBy, grouping |
| `geneset:<id>` | precomputed aspect score field (viewer profile) | overdispersion view, colorBy |
| `de:<grouping>:<group>` | `markers.<grouping>` table + on-the-fly `subsampleDE` | DE table, volcano |
| `cluster:<grouping>` | cluster sufficient stats | heatmap, composition |
| `qc:<metric>` | `metadata(metric)` (mito%, nGene…) | QC coloring |

**Provenance travels with the handle (the keystone).** Each handle's `prov` + `caveat` come
from the lstar field's `provenance`/`state` plus the cacoa rule set (§5). A DE handle carries
"pseudobulk vs cell-level; n donors; underpowered?" so any panel binding it inherits the
caveat — exactly the mock's V.6, now sourced from real field metadata.

---

## 5. The agent (replacing the regex matcher)

The single biggest stand-in in the mock (`plan1.md` VI.2) becomes a real planner.

**Loop.** Manual tool-use loop against `claude-opus-4-8` (adaptive thinking, streaming):
user/selection/nudge input → messages with the tool set + system prompt + a compact snapshot
of current `coord`/layout state → stream → execute tool calls against app state → `tool_result`
back → loop until `end_turn` → route the final text to a surface.

**Tools (the agent's action vocabulary, mapped to the ladder of restraint):**

| Rung | Tools | Surface |
|---|---|---|
| 0 · coordinate | `set_color(handle)`, `set_focus(dim,value)`, `clear_focus()`, `select_cells(ids|predicate)`, `highlight_gene(symbol)` | canvas, in place |
| 1 · answer | `run_de(groupA, groupB, opts)`, `get_markers(grouping, group)`, `get_composition(groupBy)`, `get_overdispersion()`, `expression_by_sample(gene, celltype)` | rail (disposable) |
| 2 · workspace | `propose_workspace(name)` | proposal card |
| 3 · reconfigure | `add_panel(spec)`, `reconfigure(diff)` | proposal card |
| meta | `explain(actionId)` (the "why?"), `flag_caveat(handle, text)` | toast / inherited banner |

The **surface routing** (toast / rail / proposal / thread) is decided by the rung of the tool
called — restraint is *experienced, not displayed* (`plan1.md` II.2). Big-rung tools always
land as proposals; the human disposes.

**The five presence modes, mapped to real API mechanics:**
- **1 Instrument / 2 Quick-ask** — single-turn tool calls; the pip shows idle/working.
- **3 Dialogue** — the agent returns text (a clarifying question) with no terminal tool call;
  the thread stays open for the user's reply. The cacoa rules make these *meaningful*
  ("population-level or subpopulation?" before it will run/claim a DE).
- **4 Autopilot** — a multi-tool-call turn; each `tool_use`/`tool_result`/thinking delta is
  streamed into the timeline-tip trace, interruptible (the loop checks an abort flag between
  iterations). Big moves inside it are still `propose_*` calls.
- **5 Nudge** — a **separate lightweight agent call** triggered by a typed event
  (`selection.created`, `contrast.changed`): "given this, is there a confound worth flagging?"
  → a quiet badge. This is where the agent earns its keep (a 1-vs-1 contrast, a donor-driven
  shift).

**Methodological layer (cacoa) is encoded, not hoped for.** The system prompt carries the rule
set — *the sample is the replicate*; compositional constraints; pseudobulk over pooled-cell
Wilcoxon; refuse/caveat 1-vs-1 — and the matching tools are **code-guarded**: `run_de` on an
underpowered contrast returns a refusal/asterisk, not a clean table. The handle then carries
the caveat so it's inescapable downstream. (This is the join `plan1.md` §I.7/II.5 calls the
thing that makes the system trustworthy rather than tidy.)

**DE by subsampling (the cheap-but-honest path).** Per the user's directive and `views.md`
§3–§5: `run_de` does **not** read all cells. It samples up to `maxPerGroup` cells per side,
reads their rows from the **cell-major DE panel** (near-contiguous thanks to cell order), runs
the WASM ranker, and returns **ranking-grade** genes labeled *approximate (n=…, sampled)* —
silent approximation is forbidden (`views.md` principle 5).

---

## 6. Auth — OAuth with UI forwarding (+ proxy)

Requirement: OAuth now (UI-forwarded), API-key mode later.

- **Flow:** OAuth **authorization-code + PKCE**. The app forwards the user to Anthropic's
  authorize page (UI forwarding), which redirects back to the app's callback with a code; the
  **proxy** exchanges code→token (holding the verifier + refresh token server-side).
- **Calls:** the browser talks only to the **proxy**, which forwards to the Messages API with
  `Authorization: Bearer <access_token>` + `anthropic-beta: oauth-2025-04-20` (OAuth tokens use
  Bearer, not `x-api-key`). Proxy handles refresh and streams SSE back to the browser.
- **Why a proxy:** keeps the long-lived secret off the client, solves CORS, and gives one
  place to add rate-limiting/observability. It also serves the static app + the `.lstar.zarr`.
- **API-key mode (later):** a settings toggle that swaps the proxy's auth header for
  `x-api-key`; same surface, so it's a small addition.

---

## 7. Phased plan

Phases **0/3/4** (app shell + viewer on a *test* store) can proceed in **parallel** with
**1/2** (pipeline + lstar extensions); they meet at Phase 3's "open the real store." Critical
path to a usable demo: **0 → 1 → 3 → 4 → 6**; 2/5 deepen compute; 7 adds auth; 8 scales.

### Phase 0 — Scaffold & decisions
- `git init` in `app/`; create `web/` (Vite+TS), `server/` (proxy), `data-pipeline/` (R).
- Wire lstar-js by path to `../lstar/js`; build WASM (`emsdk` + `bash ../lstar/js/build.sh`).
- Boot the app against the **lstar test store** (`js/test/make_store.py`) → deck.gl scatter of
  its embedding, colored by a gene via `geneExpression` + `scalarToRGBA`.
- **Accept:** app boots; reads a store; renders a colored WebGL scatter; WASM `colStats` runs.

### Phase 1 — Data pipeline (sample → pagoda2 → lstar)  *[lstar + pipeline]*
- **1a (R):** download GSM5746259 triplet; `Pagoda2$from10x(..., files=...)` → `runQC` →
  `run(plots="none")` → markers → `testPathwayOverdispersion` (org.Hs.eg.db GO). Save RDS.
- **1b (lstar R):** write `write_pagoda2()` → `lstar_write()` a `sample.lstar.zarr` (counts CSC,
  UMAP embedding, leiden/cell_type labels, gene OD metadata, marker tables).
- Validate: `lstar.validate` (Python) clean; `openLstar` (node) reads embedding/labels/one gene.
- **Accept:** a real `.lstar.zarr` of the PBMC sample that lstar-js opens; embedding + clusters
  + a gene column read in node.

### Phase 2 — Viewer profile + WASM kernels (the "Phase D" gaps)  *[lstar]*
- C++/WASM: add `csc_col_sum_by_group` + `subsample_de_rank`; bind to WASM; conformance rows.
- R: `write_viewer()` emits cluster sufficient stats, marker tables, cell order, cell-major DE
  panel, normalization recipe; mark `viewer@0.1` in `ds.profiles`.
- js: `csrRow`, `view.groupStats`, `view.markers`; promote `subsampleDE` to the kernel; wire
  the browser `FetchStore` adapter.
- **Accept:** grouped heatmap + cluster markers with **no matrix read**; subsample DE on a
  selection reads ~hundreds of rows; kernels match Python.

### Phase 3 — App data layer + embedding  *[app]*
- Open the served `.lstar.zarr` (`FetchStore`); load manifest, embedding, labels, gene index,
  marker tables.
- Build the reactive `coord` store; bind colorBy (gene/meta/geneset/qc), focus, selection.
- deck.gl `ScatterplotLayer` colored from lstar values; drag/lasso select → cell ids → `coord`.
- **Accept:** the real PBMC embedding renders; color-by-gene and color-by-cluster work;
  drag-select returns ids and repaints in place.

### Phase 4 — Port the generative viewer (`plan1.md`) to real data  *[app]*
- Port from the mock, backed by lstar + the real handle catalog: Embedding (→deck.gl),
  **Heatmap** (cluster stats), DeTable, Volcano, CompositionBars, BoxBySample, Overdispersion;
  plus rail, workspaces, timeline/thread, pip, ⌘K palette, selection popover, context menu,
  handle-provenance (V.6), validation placeholder (V.8), drag/resize/remove (V.1), FLIP (V.2),
  thread input (V.3), workspace mgmt (V.4), docked conversation (V.5).
- **Accept:** every interaction from the mock works on real data; caveats are inherited from
  real field metadata.

### Phase 5 — Real compute wired to the UI  *[app + lstar]*
- `run_de`/markers/heatmap/composition/overdispersion all served by the WASM kernels + viewer
  profile; DE on a selection via subsample (labeled approximate).
- **Accept:** select cells → DE in interactive time; markers/heatmap instant; numbers sane vs
  pagoda2.

### Phase 6 — The agent (real planner)  *[app + proxy]*
- System prompt (rung policy + cacoa rules + component/handle vocabulary + current-state
  snapshot); the tool set of §5; manual tool-use loop with streaming; surface routing; the five
  modes incl. the event-triggered nudge call.
- **Accept:** "show CD3D" colors; "what changed in cluster 5 vs rest" runs WASM DE into the
  rail with an inherited caveat; "set me up to compare two clusters" autopilots with a proposal;
  a real nudge fires on an underpowered/1-vs-1 contrast.

### Phase 7 — Auth (OAuth + proxy)  *[proxy + app]*
- PKCE OAuth with UI forwarding; proxy does token exchange + Messages-API passthrough (Bearer +
  oauth beta header) + refresh + SSE relay; API-key mode stubbed.
- **Accept:** user signs in via OAuth; agent calls succeed through the proxy; no secret in the
  browser.

### Phase 8 — Scale, polish, deploy  *[lstar + app]*
- Zarr **v3 + sharding** on the store (the remote-scale lever); coarse-first subsample index +
  LOD for large N; chunk tuning; deploy (static app + proxy + store host).
- **Accept:** the sample loads over HTTP at interactive speed; deployed build works end-to-end.

---

## 8. Real vs approximate ledger (keep honest)

| Piece | State |
|---|---|
| Counts, embedding, clusters, markers, overdispersion | **real** (pagoda2.1 on GSM5746259) |
| Coordination space + in-place repaint | **real** |
| Handle-borne provenance/caveats | **real** (from lstar field metadata + cacoa rules) |
| Cluster stats / heatmap / composition | **real, precomputed** (viewer profile) |
| **DE on arbitrary selection** | **approximate by design** — subsampled, ranking-grade, labeled |
| The agent / rung policy | **real planner** (Opus tool-use), replaces the regex mock |
| `write_pagoda2`, `viewer@0.1`, the two WASM kernels, `csrRow`, FetchStore | **to build** (Phases 1–2) |
| Zarr v3/sharding, LOD | **to build** (Phase 8) |

---

## 9. Risks (and where they bite)

- **Subsample DE fidelity** — sampling must preserve gene *ranking*; validate against full
  pseudobulk on a few contrasts; always surface "approximate (n=…)". (Phase 5)
- **WASM single-thread** — large reductions block the main thread; keep blocks small, stream,
  consider a Web Worker; pthreads need COOP/COEP (Phase 8).
- **Store size over HTTP** — one sample is fine chunked; v3 sharding is the lever before
  multi-sample/atlas. (Phase 8)
- **Agent latency/cost in autopilot** — multi-tool turns are streamed and interruptible; cache
  the stable system prompt; keep the state snapshot compact. (Phase 6)
- **Nudge fatigue** — the event-triggered nudge call must be rate-limited and reserved for
  confounds that change what a result *means* (`plan1.md` VI.5). (Phase 6)
- **lstar drift across runtimes** — every new kernel gets a conformance row; UI numbers must
  match R/Python. (Phase 2)
- **pagoda2 version skew** — exporter detects-and-falls-back, routes the unrepresentable to
  `dropped`; never reads `$counts`. (Phase 1)

---

## 10. Repo layout

```
app/                         ← local git repo (this folder)
  plan1.md                   ← viewer design (canonical UX)
  plan1.0.md                 ← this plan
  pagoda2-production.html     ← the mock (port source)
  data-pipeline/
    01_process_GSM5746259.R   ← download + pagoda2.1
    02_export_lstar.R         ← write_pagoda2 + write_viewer → sample.lstar.zarr
  web/                        ← Vite + TS app
    src/{data,render,ui,agent,auth}/
    public/sample.lstar.zarr/ ← (dev) served store
    vite.config.ts
  server/
    proxy.ts                  ← OAuth + Messages API + static + zarr
../lstar/                     ← sibling repo (data layer); extensions land HERE
  R/R/profile_pagoda2.R, R/R/profile_viewer.R
  core/include/lstar/lstar.hpp (+ kernels), js/wasm/lstar_wasm.cpp
  js/core/{reader,view,fetch-store}.ts
```

lstar changes are committed to the **lstar** repo (with conformance); the **app** repo holds
the pipeline scripts, the web app, and the proxy.
