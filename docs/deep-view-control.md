# Deep view-control — the generative-UX frontier

The differentiator of this viewer is **not** linked-view Q&A (cellxgene/Vitessce + chat
already do that). It is the agent acting as a **visualization architect**: assembling a
bespoke, finely-tuned, multi-view *evidence display* for a specific scientific question,
configuring each view's individual properties to make the relevant signal legible,
arranging them so the **layout itself expresses the correspondence**, and directing
attention across them — while the user keeps a spatial anchor and full override.

> The view is the argument; the agent builds the argument.

This collapses the expensive expert loop ("construct exactly the right 4 configured panels,
scoped/scaled/aligned, to see this") from ~20 min of bespoke coding per question into a
spoken request, with cacoa methodology baked in (the agent knows what *constitutes*
evidence). See [`design-brief.md`](design-brief.md) §2.2–2.4 (layout vs. state, ladder of
restraint, pin-to-keep) and [`viewer-entity-translation.md`] (the typed event bus).

## Worked scenario (the spec driver): integration verification

Prompt: *"Is the CD8-T cluster a real merged population, or an integration artifact?"* on the
real store (a Seurat integration of **two PBMC donors**, GSM5746259 + GSM5746260). The agent
builds a 3-panel board, anchored on the embedding you're already reading:

| Panel | Shows | The tell |
|---|---|---|
| **1 · Mixing** | zoom to CD8-T cells; color **by donor** (`sample`); desaturate the rest | donors **interleaved** = good correction |
| **2 · Concordance** | same cells; marker heat `CD8A/GZMK/NKG7/CCL5…` **× donor** (split) | markers **agree across donors** = one real cell type, not two batches merged |
| **3 · Residual batch** | `subsampleDE(CD8T ∩ donorA, CD8T ∩ donorB)` | genes that **still split by donor** — flag `RPS/RPL/MT-` as batch, "don't interpret" |

Narration ties them (a guided tour): *"mixed here → markers agree there → these genes are batch."*

**Finding:** the **compute layer already serves this** — `subsampleDE(cellsA,cellsB)` (arbitrary
sets), `overdispersedGenes(ids)`, `groupStats`, `geneExpression`, `metadata("sample")`. The gap
is the agent's inability to **configure and compose panels at fine grain**.

## Primitives (reverse-engineered from the scenario) — ✓ exists · ◑ partial · ✗ gap

### 1 — Per-panel view spec — the keystone (✗)
Today `colorBy`/`focus`/`selection` are **global** (every embedding reads one `coord.colorBy`),
so Panel 1 (donor) can't coexist with the cell_type embedding you came from. Move to: each
panel carries its own `view`; the **bus** (`selection`/`hint`) stays shared.

```
coord (shared bus):   selection, hint                 ← cross-panel "what we point at"
panel.view (local):   colorBy, scope, scale, clip, splitBy, highlight, overlays, colormap
render:               panel.view.colorBy ?? coord.colorBy   ← per-panel override, global fallback
agent verb:           configure_panel(panelId, patch)       ← deep, fine-grained control
```
Per "user authority overrides agent": a panel's explicit override wins over the agent's global
`set_color`. This also makes the brief's "agent authors a declarative component spec" real.

### 2 — Deep panel properties (what `configure_panel` sets)
- `colorBy` per panel — ◑ (global only today)
- `scope`: restrict a panel to a cell set/ref (embedding zooms + desaturates outside) — ◑ (heatmap has `group`; embedding only *dims*)
- `splitBy`: small-multiples by a factor (donor) — ✗  *(makes Panel 2)*
- `scale`/`clip` (log, percentile), `colormap` (diverging vs sequential) — ✗
- `highlight` (static sub-ref), `overlays` (cluster contour; on-plot labels ✓ already) — ◑

### 3 — Viewport control (✗)
`focus_view(ref)` — pan/zoom an embedding to a cell set's bounds (vs the dim-others focus).
Embedding only fits-at-init today; extract `fitTo(ids?)`.

### 4 — Scoped & split compute (mostly ✓)
- scoped DE / overdispersion / markers on a cell set — ✓ (`subsampleDE`, `overdispersedGenes`, `groupStats`)
- **per-donor stats within a cluster** (Panel 2) — ◑ composable; cleaner as `groupStatsSplit(geneSet, cellSet, splitBy)`
- **residual-batch** (Panel 3) = `subsampleDE(cluster∩donorA, cluster∩donorB)` — ✓ today by composition
- marker **concordance** across donors — ✗ (small derived metric)

### 5 — Layout composition + alignment (◑)
- `compose(panels[])` as a **rung-3 proposal you confirm** — ◑ (`propose_workspace` = named presets only)
- **alignment**: shared color scale / linked zoom across panels so correspondence is readable — ✗
- inertia-preserving morph (keep the anchor, animate the rest) — ◑ (FLIP exists for reorder)

### 6 — Attention / correspondence tour (✗)
`guide(steps[])` — sequential cross-panel highlight + one-line captions, checkpointed/replayable.
Builds on the generalized `hint`/`selection` bus.

## Build order (the keystone unlocks the rest)

1. **Per-panel `view` + `configure_panel`** (colorBy + scope) — the unlock. *(in progress)*
2. `focus_view(ref)` / `EmbeddingView.fitTo(ids)` — zoom to a cell set.
3. `groupStatsSplit` + a per-donor marker-heat panel (Panel 2).
4. Wire `subsampleDE(A,B)` to a tool (compute already there) — Panel 3.
5. `compose([...])` as a confirmable proposal.
6. `guide()` tour — the "look here, look there."

Steps 1–4 render the full board; 5 lets the agent assemble it from one request; 6 narrates it.
