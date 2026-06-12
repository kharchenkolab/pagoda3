# pagoda3

**An agent-driven, browser-native viewer for single-cell data.** Point it at any
[L\* / lstar](../lstar) store — or hand it an AnnData / Seurat / SingleCellExperiment object and let
lstar convert it — and explore it through a shared *coordination space* driven by an Anthropic (Opus)
copilot. Designed in [`docs/design.md`](docs/design.md), mocked in [`docs/mockup.html`](docs/mockup.html).

pagoda3 views **any** single-cell object (via lstar's converters); it is not tied to pagoda
analysis output. Think "cellxgene for L\*", but agent-driven and generative.

## How it's layered

- **[lstar](../lstar)** — the substrate. Converts external formats (AnnData/Seurat/SCE/Conos/pagoda2)
  to the uniform L\* Zarr model and provides the compute kernels (`col_sum_by_group`, mean/var,
  csc↔csr). Format- and viewer-agnostic.
- **pagoda3** — the viewer. The browser app (`web/`) plus thin R/Python launchers (`r/`, `py/`) that
  own the *viewer policy*: which navigators to precompute (`write_viewer`) and how to launch locally.

**Precompute is optional.** A plain or freshly-converted L\* store opens directly — markers, cluster
stats, all-genes selection DE, and scope-aware overdispersion are computed **on the fly in-browser**
(WASM kernels). `write_viewer` only precomputes the global *navigators* (per-annotation markers, a
whole-dataset `od_score`, the cell-major counts orientation) so a large/remote store opens instantly.

## Use it

```r
# R: view a Seurat/SCE object, or an existing store
library(pagoda3)
view(seurat_obj, repo = "~/pagoda/pagoda3", prepare = TRUE)   # convert -> prepare -> open browser
```
```python
# Python: view an AnnData, an lstar.Dataset, or a store path
import pagoda3
pagoda3.view(adata, prepare=True)
pagoda3.view("sample.lstar.zarr")
```

Or run the dev server directly and pass a store via `?store=`:

```bash
../.venv/bin/python examples/make_dev_store.py     # -> web/public/sample.lstar.zarr (synthetic demo)
cd web && npm install && npm run dev               # -> http://localhost:8787  (agent proxy auto-spawns)
```

Open <http://localhost:8787/?store=/sample.lstar.zarr>. The agent is live when `~/.aba/oauth.json`
holds a valid token (else a faithful keyword mock runs). Ask "markers of the CD8 T cells", select a
blob and ask "what's different here?", or "what genes vary most within these cells?".

## What's inside

- **Coordination space + generative viewer** — colour/focus the shared scope, a disposable answer
  rail + pinning, workspaces, the timeline-as-transcript, command palette, handle-borne provenance
  with **cacoa caveats** (sample-is-replicate, compositional, pseudobulk, refuse/caveat 1-vs-1).
- **Scope-correct compute** — selection DE ranks **all genes** for the selected cells; overdispersion
  is the pagoda2-style residual above a smoothed mean-variance trend, **recomputed for the scope**
  (never a global gene shortlist). Both subsample cells, read cell-major rows, reduce over all genes.
- **The agent** — an Opus tool-use loop with a **data-driven** system prompt (read from the loaded
  store), driving the coordination space at the lowest sufficient rung.

## Layout

```
web/             the browser viewer (Vite + TS): src/{data,render,ui,agent}, public/ (dev stores + /wasm)
py/              python package "pagoda3": write_viewer (prep) + view() launcher
r/               R package "pagoda3": write_viewer + view()
server/          proxy.mjs — local agent proxy (Anthropic Messages API relay)
examples/        demo data-prep scripts (make_dev_store.py, real-data pipelines)
docs/            design.md (the viewer design), roadmap.md, mockup.html, design-brief.md
```

## Status

Working locally on real data: a Seurat integration of two GSE192391 PBMC samples
(`examples/02_process_seurat_integrated.R` → 12,221 cells, 21 cell types). Remote zarr-over-HTTP
(cell_order + cell-block sharding + a shard-aware stratified sampler) and browser OAuth sign-in are
the next steps — see [`docs/roadmap.md`](docs/roadmap.md).
