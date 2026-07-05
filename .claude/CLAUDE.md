# pagoda3

A browser workbench for exploring single-cell RNA-seq data — and an experiment in **modular, generative
UX**: the surface where agent-driven analysis is steered and verified, not hand-coded.

## What it is
- Serverless static SPA that reads a `.lstar.zarr` store over HTTP range requests (`?store=<url>`). The
  viewer host never sees the data; for local paths it never leaves the machine (a trust headline).
- Consumes **lstar** as its substrate (see "lstar relationship").

## Generative-UX principles (the design)
- **The agent has near-complete control over the UI** — colour, focus, selection, which panels exist and
  how they're arranged, per-panel config. All view state is data driven by a small set of named verbs, so
  the agent, direct manipulation, and widgets all drive the same surface.
- **The UI is independent, self-registering panels that communicate over well-defined (typed) events**,
  together giving a coordinated, multi-faceted view of the same underlying data.
- **Custom widgets are first-class panels** — the agent or user can author a new panel on the fly
  (sandboxed, on the same event bus + kernels), not just pick from built-ins.
- **High inertia (separate concern):** the agent keeps the UI consistent and changes the minimum needed,
  so the user isn't disoriented as the view evolves.

## lstar relationship (fixed — see docs/architecture.md)
- pagoda3 → lstar is a HARD dependency; lstar → pagoda3 is SOFT (`Suggests` + `lstar.view()` delegating).
  Never flip the direction.
- lstar owns THE RECIPE — `extend_for_viewer` + kernels, systematic across Py/R/C++/JS. pagoda3 owns THE
  POLICY (which groupings), the `view()` launcher, and the browser view. Never fork the recipe into pagoda3.
- lstar is a separate, actively-developed repo (its own agent): don't make/push lstar changes from pagoda3
  work — coordinate, and pull its releases.

## Brand
pagoda3 = the product; lstar = the engine ("powered by L★").
