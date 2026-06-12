# pagoda2 browser — the agent-driven generative viewer (working build)

An implementation of the agent-driven generative scRNA-seq viewer designed in
[`plan1.md`](plan1.md) (and mocked in [`pagoda2-production.html`](pagoda2-production.html)),
running on a real [lstar](../lstar) Zarr store with a **live Anthropic (Opus) agent**.
Build plan: [`plan1.0.md`](plan1.0.md).

## What works

- **Data layer** — a faithful TypeScript reader for the lstar Zarr format (consolidated
  metadata, sparse CSC gene-column reads, dense embeddings, label codes) over `zarrita`'s
  `FetchStore`. Scales: verified at **50,000 cells** in deck.gl.
- **Rendering** — deck.gl GPU `ScatterplotLayer` (binary attributes; colour = a buffer swap),
  colour by cluster / cell type / condition / sample / QC / **gene** / gene-program; legend,
  Shift-drag rectangle select.
- **The generative viewer** (ported from the mock onto real data) — coordination space,
  workbench panels (Embedding, Composition, DE/marker table, Volcano, Box-by-sample,
  Overdispersion, Heatmap, Note), the disposable **answer rail** + pinning, **workspaces**,
  the **timeline = transcript**, the **status pip**, ⌘K **command palette**, selection
  popover, context menu, panel drag/resize/remove + FLIP, docked conversation, the
  **validation/refusal** placeholder, and **handle-borne provenance + cacoa caveats**.
- **The agent** — a real **Anthropic Opus** tool-use loop (`agent/live.ts` → the proxy):
  the model drives the coordination space at the lowest sufficient rung via tools
  (`set_color`, `set_focus`, `get_markers`, `run_de_on_selection`, `get_composition`,
  `get_overdispersion`, `propose_workspace`, `add_note`). The system prompt encodes the
  ladder of restraint + the cacoa methodology (sample-is-replicate, pseudobulk,
  compositional, refuse/caveat). The five presence modes render in the timeline thread.
  A faithful **keyword-matcher mock** runs if the agent is unreachable.
- **Auth proxy** (`server/proxy.mjs`) — keeps the credential server-side, relays the
  Messages API SSE. Currently borrows the local Claude Code OAuth token
  (`~/.aba/oauth.json`, refreshed near expiry) per project directive; an `ANTHROPIC_API_KEY`
  mode and a browser PKCE/UI-forwarding sign-in are stubbed for later.

## Run it

Prereqs: Node ≥ 20 and a Python with numpy/scipy/zarr2 (a venv at `../.venv` is assumed by
the make-store command below).

```bash
# 1. generate the synthetic demo store (8k cells, the canonical schema)
../.venv/bin/python data-pipeline/make_dev_store.py            # -> web/public/sample.lstar.zarr
#    optional larger store for perf:  make_dev_store.py web/public/big.lstar.zarr 50000 1500

# 2. install + run (the agent proxy auto-spawns from the dev server)
cd web && npm install && npm run dev                           # -> http://localhost:8787
```

Open <http://localhost:8787>. Append `?store=/big.lstar.zarr` to load the 50k store.
The agent is live if `~/.aba/oauth.json` holds a valid token (a "Live agent connected"
toast appears); otherwise the local mock planner runs. Try ⌘K → "colour by IL6", or ask
"is cluster c0 enriched in disease, or a confound?".

## Layout

```
data-pipeline/   make_dev_store.py (synthetic, canonical schema) · real-data scripts
web/             Vite + TS app
  src/data/      store.ts (lstar reader) · view.ts (pure-TS kernels) · ctx.ts · coord.ts
  src/render/    embedding.ts (deck.gl) · colors.ts
  src/ui/        shell.ts · panels.ts · app.css · dom.ts
  src/agent/     agent.ts (dispatch + mock + presence) · live.ts (Opus tool-use loop)
server/proxy.mjs OAuth/API-key proxy + Messages API SSE relay
```

## Honest status (real vs. to-build)

- **Real:** the whole app + data layer + live Opus agent, on a synthetic store with the
  *canonical schema* (so the real GSE192391 store slots in unchanged).
- **Approximate by design:** DE on arbitrary selections is subsampled / ranking-grade (labelled).
- **To build:** real GSE192391 sample 1 via pagoda2.1 (`lstar write_pagoda2` — see plan1.0
  Part B); the lstar `viewer@0.1` profile + WASM kernels (currently pure-TS); the cell-major
  DE panel + `csrRow` path so subsample DE reads O(rows) at 10⁶ cells; browser OAuth sign-in;
  Zarr v3/sharding for remote scale.
