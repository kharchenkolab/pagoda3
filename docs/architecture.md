# pagoda3 architecture

This document explains how pagoda3 is built and, more importantly, *why*. It is written for
developers and contributors, and for technically-minded users deciding whether to build on the
project. It describes the software as it is today.

Two ideas run through everything below:

- **Generative UI.** The interface is not a fixed set of screens. Almost everything you can
  see is *state* — and that state is assembled on demand, driven equally by an AI agent, by
  your own clicks, and by custom panels.
- **Modularity.** The interface is a set of independent panels that register themselves and
  talk over a small, typed set of shared "verbs." Adding capability means adding a module, not
  editing the core.

---

## 1. What pagoda3 is

pagoda3 is a **browser workbench for exploring single-cell RNA-seq data** — the tables of gene
expression, one row per cell, that come out of a sequencing experiment. You point it at a
dataset and steer it in plain language.

What makes it unusual is that the UI is **generative**: it is *assembled on demand around the
question you're asking*, rather than being a fixed dashboard you navigate. Ask to "colour by
S100A9," "facet by day," or "build a panel that shows this gene's 3D protein structure," and the
workspace reshapes to answer. A built-in AI copilot (Anthropic's Claude) recolours the views,
runs the right analysis, rearranges panels, and can even author brand-new ones.

Two properties define the rest of the design:

- **It runs entirely in the browser.** All the compute happens client-side.
- **Data is never uploaded.** For a local file, the bytes never leave your machine.

Everything that follows is a consequence of taking those two properties seriously.

---

## 2. Local-first, serverless design

pagoda3 is a **static single-page app** (SPA) — a bundle of HTML, JS, and WASM with no backend
of its own. It reads its data from an **L★ store** (see §3), a folder or single `.zip` on disk
or on any plain web server.

The key technique is the **HTTP range request** — a normal web request that asks for only a
*byte range* of a file ("give me bytes 5000–8000") instead of the whole thing. An L★ store is
chunked, so to colour by one gene the viewer fetches only that gene's chunk — a few tens of
kilobytes — not the whole matrix. It reads the store's index once, then seeks straight to the
bytes it needs.

```
  browser (static SPA)                      a plain web directory / S3 / GitHub Pages
  ┌──────────────────┐   HTTP Range         ┌─────────────────────────────┐
  │  render + compute │  "bytes=5000-8000"  │   sample.lstar.zarr  (chunks)│
  │  (all client-side)│ ───────────────────▶│   ...only the needed chunk   │
  └──────────────────┘ ◀─────────────────── └─────────────────────────────┘
        no server-side compute · nothing uploaded
```

For a **local** file, the same reader runs against bytes the browser already holds — nothing is
sent anywhere at all. If a static host ignores range requests, the reader degrades to a
whole-file fetch rather than breaking.

Why this matters:

- **Privacy.** Patient or unpublished data can be explored without it ever leaving the laptop.
  There is no server that could see it.
- **Shareability.** To publish a dataset you drop the store and the built bundle on any static
  file host and share a `?store=…` link. Recipients explore it in their own browser, fetching
  only the bytes they scroll to. No service to run, host, or pay for.
- **Scale on a laptop.** Because panels pull only the slices they display, a dataset far larger
  than memory is still navigable — you never materialize the whole matrix.

The compute kernels (normalization, dimensionality reduction, clustering, marker finding,
differential expression) run **in the browser**, largely as **WebAssembly (WASM)** modules for
speed, off the main thread where they'd otherwise freeze the page.

---

## 3. The lstar ↔ pagoda3 relationship

pagoda3 sits on top of **lstar** (branded *L★*). Keeping the two cleanly separated is a
deliberate design decision, not an accident of history.

- **lstar is the engine.** It owns the **data model**, the **on-disk format** (`.lstar.zarr`),
  the **reader**, and the **compute "recipe"** — the kernels and the canonical way to prepare a
  dataset for viewing. Crucially, lstar is implemented consistently across **Python, R, C++, and
  JavaScript**, so the same math and the same files behave identically everywhere.
- **pagoda3 is the product.** It owns the **browser viewer**, the **policy** of which analyses
  to run and which groupings to show, and the **launchers** (`view()` in R and Python).

Think of it as: *lstar decides how the numbers are computed and stored; pagoda3 decides what to
show and how to let you steer it.*

### The dependency direction is fixed

```
   pagoda3  ──── hard dependency ────▶  lstar        (pagoda3 cannot exist without lstar)
   pagoda3  ◀──── soft dependency ────  lstar        (lstar.view() delegates IF pagoda3 is present)
```

- **pagoda3 → lstar is a hard dependency.** The viewer's reader *is* the `@lstar/core`
  package, imported directly, so it can never drift from the format.
- **lstar → pagoda3 is soft.** lstar merely *suggests* pagoda3: an `lstar.view()` call hands off
  to pagoda3 when it's installed and does nothing special otherwise. lstar remains fully useful
  with no viewer at all.

**Never flip that direction, and never fork the recipe.** The single most important rule of this
boundary is that pagoda3 does not reimplement lstar's compute or format. If a kernel needs to
change, it changes in lstar — once — and every language gets it. Forking the recipe into the
viewer would mean the browser slowly computing something subtly different from what R and Python
compute, which is exactly the drift the boundary exists to prevent.

The boundary sits where it does because **format and math are universal, but presentation is
not.** Everyone reading single-cell data wants the same overdispersion residual; only pagoda3
cares which panels to open. So the universal parts live in the shared engine, and the opinionated
parts live in the product.

---

## 4. Generative UI/UX — the core idea

The heart of pagoda3 is that **the view is data, not code paths.** Nearly everything you can
see is a field in a small shared object, and a small set of named verbs change those fields.

### The coordination space

The **coordination space** — a "shared view state that every panel reads and writes" — is a tiny
reactive store (`web/src/data/coord.ts`). It holds the *fast-changing* view state:

- `colorBy` — what colours the cells (a metadata field, a gene, or a QC metric).
- `focus` — a labeled subpopulation the whole workspace narrows to.
- `selection` and `hint` — a committed selection, and an ephemeral hover cue.
- `display` — labels on/off, legend, point opacity, outlier clipping, and an open `style`
  escape hatch reaching every rendering constant that used to be hardcoded.

The comments in that file state the principle directly: view options live here, "not hardcoded
in paint, so the agent AND direct manipulation both drive them." That is the whole game — a knob
is a *field*, reachable from anywhere, never a decision buried in the drawing code.

### Three drivers, one surface

The same coordination space is moved by three things, **and they are equal citizens**:

```
   AI agent  ─┐
   your clicks ├──▶  coordination space  ──▶  every panel repaints
   widgets    ─┘        (coord.ts)
```

- **The agent** sets fields to answer your question.
- **Direct manipulation** — clicking a cluster, dragging a lasso, toggling a legend — sets the
  same fields.
- **Custom widgets** (§6) read and write the same fields through a host API.

Because there is only one surface, *anything the agent does, you can do by hand*, and vice
versa. The agent is not running a private script; it is turning knobs that are all exposed in
the UI. **The agent just reaches them faster.**

### High inertia

A generative UI that rearranged itself completely on every request would be unusable. So the
agent works under a **principle of restraint**: prefer the **smallest change that answers the
question.** Its own instructions lay out a ladder of escalating moves —

1. recolour or focus *in place* (the default);
2. add a *disposable* answer or one panel, if a new view is genuinely needed;
3. change the whole layout only for a deliberate, reversible rearrangement.

The effect is **high inertia**: the workspace evolves in the minimum increments, so you are
never disoriented by a view that reshuffled underneath you. And because each move is real,
recorded state, every one is **reversible** — the human can step back through history.

### The disposable answer rail

Quick results have a home that keeps them from cluttering your workspace: the **Answers rail**,
labeled in the UI as `ANSWERS · DISPOSABLE`. A marker table, a composition breakdown, or an
ad-hoc computation lands there by default and is treated as throwaway. If a result is worth
keeping, you **pin** it and it becomes a committed panel in the workbench. This "disposable by
default, pin to commit" model lets the agent answer freely without permanently reshaping your
space for every question.

---

## 5. Modularity — self-registering panels

The workbench is not one monolith. It is a set of **independent panel modules**, each rendering
its own facet of the same data, coordinated through the shared state above.

### The panel type registry

Panel *types* register themselves into a small registry
(`web/src/ui/panel-registry.ts`) instead of being wired into a hardcoded switch statement. A
module calls `registerPanelType({ type, body, agent, needs })` and the core simply looks it up:

- `type` — the panel's name (`"Embedding"`, `"Heatmap"`, `"Widget"`, …).
- `body` — the renderer, called as `(panel, ctx, hooks) → DOM`.
- `agent` — whether the agent is allowed to add or reference this type.
- `needs` — an optional declaration of what data the panel reads (see below).

The built-in panels — Embedding, Heatmap/dotplot, differential-expression tables, metadata
facets, composition bars, variable-genes, and more — all register through this same call. So
does an **external example module** (`web/src/ui/example-panel.ts`) that defines a `DatasetInfo`
panel *entirely outside* the core file and is added with a single import in `main.ts`. Its
header comment states the goal plainly: a panel type "defined ENTIRELY OUTSIDE panels.ts that
self-registers … with ZERO edits to the core."

**This is the "add a panel without touching the core" story.** Ship a module that calls
`registerPanelType`, import it once, and the type is renderable, agent-addable, and
introspectable — no edits to a central list.

### The typed coordination model

Panels do not call each other. They communicate only through the coordination space, using a
**typed `EntityRef`** — a small tagged value that names *what* is being referred to:

```ts
type EntityRef =
  | { kind: "category"; grouping: string; value: string }   // "cell_type = NK"
  | { kind: "cells"; ids: Int32Array };                     // a raw set of cells
```

A panel that speaks a given type acts on it directly; one that doesn't can translate it through
cells, or ignore it. Hover cues travel on a *separate* channel from committed selections, so
hover churn never triggers the heavier repaints. The result is a **coordinated, multi-faceted
view**: click a cluster in the embedding and the dotplot, the facet browser, and any widget all
respond, each in its own vocabulary, because they all read the same typed events.

### Declared data needs

A panel can declare *what data it reads* as a pure function of its configuration
(`needs: (panel, ctx) => Need[]`). A `Need` is a small request — a metadata column, a grouping,
per-group statistics, marker genes. The core reads these declarations and **provisions the data
eagerly and concurrently** the moment the panel mounts, instead of each panel fetching lazily and
flashing a spinner. Because the needs are derived from the live layout, the prefetch always
tracks what is actually on screen and cannot go stale.

### The module manifest (for widgets)

Custom widgets carry this modularity further. Each declares a **manifest** — a self-describing
block of capabilities: its title, its typed **parameters** (value knobs the host renders and the
agent can set), its header **controls** (action buttons), and its **permissions** (which
external hosts it may fetch from, whether it runs off-thread compute). The manifest is what makes
a widget an *installable module* whose capabilities and requirements are visible before it runs.

---

## 6. Custom widgets & containment (the "fourth surface")

Beyond the three drivers of §4, there is a fourth surface: the agent (or the user) can **author a
brand-new panel on the fly.** A **widget** is a small, self-contained piece of author-written
code that runs live in the workbench — on the same event bus and the same compute kernels as the
built-in panels. This is how pagoda3 answers requests the built-ins simply don't cover, such as
the "Gene → 3D protein structure" panel: the agent writes the widget, it appears in the
workspace, and it stays in sync with every other panel.

Running author-written (and sometimes agent-written) code inside a data tool is only safe with
serious containment. That containment is the highlight of the widget design.

### Self-contained — no external network by default

A widget is **self-contained as code**: all of its logic is in one source string. It runs in an
iframe that **cannot** `fetch()`, `import`, or load a CDN `<script>` on its own. Everything
external is reached *by name, through the host*:

- **`pagoda.loadLib(name)`** loads a curated, **version-pinned** library the host injects — the
  allowlist lives in the widget host (`web/src/widget/`), e.g. `3dmol`, `d3`. The widget says
  `loadLib('3dmol')`; it does not *contain* 3Dmol.
- **`pagoda.fetchExternal(url)`** performs a **host-proxied, allowlisted** fetch of external
  reference data — and only from a fixed set of biodata hosts (RCSB/PDB, UniProt, Ensembl, NCBI,
  AlphaFold, STRING, Reactome).

A consequence worth stating: **even a heavy widget is a small file.** A 3-D molecular viewer is
just glue — `loadLib('3dmol')` + `fetchExternal(PDB)` + render. The library (and any WASM inside
it) lives on the host, not in the widget.

### Sandboxed iframe — the render/compute split

The **render** side of a widget runs in a **sandboxed iframe** with an opaque origin, so it is
genuinely isolated from the app; it talks to the host only through a typed `postMessage`
protocol (`web/src/widget/contract.ts`). The iframe never touches app state directly — it *asks*
the host, which then drives the real coordination space. That is why a widget's selection or
colour change behaves exactly like a built-in panel's.

Heavy or untrusted **compute** does not run in that iframe. It goes through
`pagoda.runCompute(code, …)`, which the host runs in a **host-spawned, terminable Web Worker**
(`web/src/agent/codeapi.ts`) — a background thread the host can *kill*:

```
   widget iframe            host              terminable worker
   (render only)   ──────▶  spawns  ──────▶   (heavy compute, off the main thread)
                            watchdog ──────▶   terminate() on timeout  → hang-safe
```

The worker gets a data snapshot and runs the author's code with network and ambient globals
shadowed out. If the code runs away — an infinite loop, say — a watchdog **terminates the
worker** after a timeout. The result: a misbehaving widget **cannot freeze or hang the UI**, and
a runaway one is simply killed. This render-vs-compute split is what lets pagoda3 run
agent-authored UI without risking the main thread.

### Data and analysis only through the host API

A widget reaches data and analysis through a defined host API, never directly. It can request
data slices (`pagoda.data(kind, …)`) and — importantly — call **the very same kernels the agent
uses** via `pagoda.compute(name, args)`:

- `overdispersion` — variable / highly-variable genes for a cell set;
- `de` — a direct A-vs-B differential test;
- `markers` — a cell set versus the rest;
- `groupStats` — per-group mean and fraction-expressing.

So a widget's analytical power is exactly the app's: it never hand-rolls statistics when a
correct kernel exists.

### Permission / consent model

Anything sensitive carries a **permission model**. A widget's manifest declares the external
hosts it intends to fetch and whether it runs off-thread compute. For an **imported** widget —
foreign code you accepted — these declarations are *enforced*: the host blocks a fetch to an
undeclared domain and denies compute the widget didn't ask for, all on top of the global
allowlist that bounds every widget regardless. An imported widget is shown a **consent gate**
listing its declared needs *before its code ever runs*, and trust is content-addressed so
re-importing code you already trusted stays trusted.

Together these make agent-authored UI **safe to run**: it can't reach the network except through
a narrow allowlist, can't freeze the page, can't silently exceed what it declared, and can't
touch app state except through the same coordinated channel every other panel uses.

Widgets are portable: a widget exports to a single self-describing `pagoda-widget` JSON file that
carries the source and a derived dependency contract, so it can be shared and re-imported
(see `docs/widget-format.md`).

---

## 7. The agent

The copilot is a **Claude tool-use loop** (`web/src/agent/live.ts`). Each turn, it calls the
model, receives any tool calls, runs them, feeds the results back, and continues — up to a small
bounded number of turns (enough headroom for multi-step flows like authoring a widget:
template → preview → fix → save). A stuck-detector stops it if it repeats an action that isn't
changing anything.

Several design choices matter:

**A data-driven system prompt.** The prompt is **built from the actually-loaded dataset** — its
fields and their roles, which groupings have precomputed markers, which embeddings exist — read
live from the store via `describeForAgent()`. The agent is told, in effect, "these are the real
fields; do not assume any other dataset." A field's *role* governs what the agent may do with it:
a partition (clustering) can be a grouping for markers; a sample or condition is a **covariate**
you facet or pseudobulk by, never a grouping. To keep the large, stable prompt cacheable, the
volatile per-turn state (current colour, selection, layout) is appended at the *tail* of the user
turn, not woven into the system prompt.

**Two surfaces, driven at the lowest sufficient rung.** The agent has exactly two kinds of move:
`update_view` changes *what is shown* (colour, focus, display, panels — one declarative tool
taking any subset of fields), and a small set of **compute** primitives *derive* data (markers,
DE, overdispersion, composition). It is instructed to prefer the smallest change that answers the
question (§4). It drives the coordination space through validated view patches
(`web/src/agent/viewpatch.ts`), so every move is the same reversible state a human could set.

**Provenance and statistical caveats.** The prompt encodes real single-cell methodology (drawn
from the *cacoa* approach) that the agent must respect:

- The **replicate is the sample/donor, not the cell** — cell-level p-values overstate effects.
- Population-level claims use **pseudobulk across donors**, not pooled-cell tests.
- Cluster proportions are **compositional** (they sum to one), so they need a compositional test.
- **Refuse or caveat** a design that can't support a claim — e.g. a 1-vs-1 comparison with no
  replication — and state the caveat plainly.
- Compute is **scope-correct**: DE and overdispersion rank over *all* genes for the exact cells
  in question, never a global gene shortlist, so they surface what distinguishes *that* scope.

This is why the agent will pick a grouping that actually has markers, use the correct test for a
cross-sample comparison, and decline a comparison the design can't support — the guidance is in
its instructions, not left to chance.

**The agent is optional.** The viewer works fully without it. Selections, DE, dotplots,
annotation, and every panel are all drivable by hand; the agent is a faster path to the same
knobs, and the UI says as much when no copilot is connected ("run the viewer without a copilot").
The agent provider is also pluggable — the default is Anthropic's Claude via a small local relay,
but the adapter layer allows other backends.

---

## 8. Map of the codebase

```
web/                the browser viewer (Vite + TypeScript)
  src/
    data/           the L* reader, the coordination space (coord.ts), the data
                    context (ctx.ts), field roles, and format intake (h5ad, 10x)
    compute/        in-browser kernels — normalization, embedding, clustering,
                    overdispersion, QC, enrichment; the compute worker
    render/         drawing — the embedding canvas, colour ramps, palettes, the
                    open style descriptor registry, theming
    ui/             the shell, the panel modules + the panel-type registry,
                    workspaces, the answer rail, persistence, the command palette
    agent/          the Claude tool-use loop (live.ts), view-patch validation
                    (viewpatch.ts), the compute capabilities/kernels
                    (capabilities.ts), the sandboxed code API + terminable worker
                    (codeapi.ts), provider adapters
    widget/         the custom-widget subsystem — the postMessage contract,
                    the iframe runtime, the real in-app host (apphost.ts),
                    recipes and templates
    main.ts         boot: open a store, build the context, register panels,
                    start the shell

py/                 Python package "pagoda3": write_viewer (prepare a store) + view()
r/                  R package "pagoda3": write_viewer + view() (serve.R, view.R)
server/             proxy.mjs — the local agent relay, and the external-fetch proxy
                    behind pagoda.fetchExternal (it blocks private / loopback hosts)
examples/           demo data-prep scripts and real-data pipelines
```

Where to start reading, by interest:

- **How the view works** → `web/src/data/coord.ts`, then `web/src/ui/panel-registry.ts`.
- **How to add a panel** → `web/src/ui/example-panel.ts` (a complete external module).
- **How the agent drives it** → `web/src/agent/live.ts` (the loop and the system prompt).
- **How custom widgets stay contained** → `web/src/widget/contract.ts` and `runtime.ts`, plus
  the terminable worker in `web/src/agent/codeapi.ts`.
- **The engine underneath** → the sibling **lstar** repository (`../lstar`).

---

<sub>Built on the open **L★ / lstar** single-cell data model and compute kernels. pagoda3 is
the product; lstar is the engine.</sub>
