# Enabling custom widgets: capability, compute, and trust

*Design discussion, 2026-06-17. How to make agent-authored custom widgets (the "fourth surface" / generative UI) maximally capable — analytically as powerful as the app itself — without letting them wreck the app or the user's data.*

---

## 1. What triggered this

A live session: the user asked the agent to **build a widget showing the top overdispersed genes for the current cell selection**. The agent:

- found no overdispersion data kind, so it adapted the `selection-markers` recipe and **hand-rolled** overdispersion: pull a candidate gene pool, then loop `pagoda.data('expr', {gene})` per gene and compute variance/mean client-side;
- burned ~6 preview/edit iterations (a preview-simulation bug made `rankGenes` return empty, which it misread as "`dir:'abs'` unsupported");
- shipped a widget that took **>1 minute** to compute and was also **less correct** (variance/mean over a ~40-gene DE-prefiltered pool, not genome-wide).

Then, the **next turn**, the user asked the agent (not as a widget — just do it) to compute top overdispersed genes for CD4 T cells. It called `compute(stat:'overdispersion', A={union of CD4 T labels})` → returned **instantly**, genome-wide over 10,374 cells.

So a fast, correct method already existed — `ctx.view.overdispersedGenes(cells, n)`, the kernel-backed F-test behind the `compute` tool — but **the widget couldn't reach it and the agent didn't know it could be reached.** That is the whole problem in one example.

## 2. The two failure modes

- **Knowledge gap (oversight):** the agent doesn't reliably know what the system can already do. Capability is scattered across a prose contract doc, recipe search, tool descriptions, and the system prompt; there is no single legible "menu."
- **Capability gap (worse):** even a perfectly-informed agent often *cannot* use a capability from inside a widget, because the widget surface is a strict subset of what the app can do. It must reimplement — usually slowly and less correctly.

## 3. Root cause: two capability surfaces that drifted

The app has **two parallel surfaces**, built separately:

1. **Analyst surface** — the agent's tools (`update_view`, `compute` with `de`/`overdispersion` over cell-set algebra, `get_markers`, `compute_code`, …). Rich, kernel-backed.
2. **Widget surface** — `pagoda.data(kind)` over a hand-maintained list (`n, fields, categories, category, cellsOf, expr, numeric, selectedCells, groupStats, rankGenes`). What a widget can pull.

The widget surface is a **subset grown reactively** — a kind added each time some widget happened to need one (`groupStats`, then `rankGenes`). Nothing asserted "the widget surface must equal the analyst's primitives," so `overdispersion` — a tool the whole time — was never bridged.

Two design decisions produced this:

- **The sandbox forces a narrow waist (correct), but it was hand-maintained (the mistake).** Widgets run in an isolated iframe, so they cannot call `ctx.view.*` directly — every capability must cross `postMessage` as an enumerated message. That boundary is right; its being *manual and incomplete* is the bug. The waist lags the real capabilities.
- **The agent wears two hats but was never told they share a brain.** As the analyst it knows `compute(overdispersion)`; when it switches to widget-author the prompt hands it a *separate little world* (recipes + data kinds) and never says "your analytic powers are still here — this is how they project in." So its own knowledge didn't transfer.

## 4. Runtime topology (correcting the "host" confusion)

There is **no server-side compute or data.** Everything runs in the browser tab; the proxy is slim (relays the Anthropic API with the OAuth credential, allowlisted external fetch, the pinned-library registry, and per-turn logs). Three JS contexts, all in-browser:

1. **Main app page (main thread)** — the **`WidgetHost`**. Owns `ctx` (the data: typed arrays in the page heap, fetched on demand from the lstar zarr by zarrita) and runs the **WASM kernels** (`/wasm/lstar_kernels.mjs`; `overdispersedGenes`/`subsampleDE` call `M.colSumByGroup(...)` on the main thread). This is what "host" / "where the data and kernels live" means — **this page, not a server.**
2. **Web Workers (browser)** — `compute_code` does `new Worker(...)`, hands it a data *snapshot*, runs sandboxed JS, posts back a result.
3. **Widget iframes (sandboxed, `allow-scripts`, origin null)** — reach the main page only via `postMessage`; no direct access to `ctx`.

The boundary that matters for a widget is therefore **iframe ↔ main page**, and the only thing crossing it is a structured **clone** of typed arrays. Cloning many 35k-element vectors is the marshalling cost behind the "slow widget" — entirely within the tab, between two JS contexts. "Run it host-side" = "run it in the main page (or a page-spawned worker) where the arrays already are," **never** on a server.

## 5. The key reframe: compute is orthogonal to the sandbox

Because the kernels (WASM) and the data (typed arrays) and a widget's own code all sit **side by side in one tab**, a widget is **not analytically weaker by nature.** A WASM module a widget loads runs at the same speed, on the same data, as the kernels in the main page. A sufficiently advanced widget should be able to pull raw data, load its own WASM, run its own fast algorithm, and render the result — and the design should *allow* that.

The only thing making widgets weaker is the iframe boundary, which we added to **contain damage**, not to limit math. The crippling of compute was *collateral* from using a blunt instrument (an iframe that bundles many protections and, as a side effect, withholds data + kernel access).

**Retraction:** an earlier framing in this discussion — "compute belongs in the host; the widget should render results; never recompute from raw" — was a moat. It's wrong for an escape hatch whose value is generality. The kernel set is finite; the space of useful computations isn't. **Hardened primitives should be gravity, not gates:** the easy, fast, correct default when one fits, with the fully-general path (raw data + bring-your-own compute) always open underneath.

## 6. What the sandbox actually protects — and what's safe to share

A widget could: (1) wreck the page DOM / hijack layout & focus / overlay phishing UI; (2) corrupt app state / coordination / session / other panels; (3) exfiltrate data or pull arbitrary code; (4) abuse resources (hang the main thread, memory-bomb); (5) steal origin secrets (cookies, localStorage, the OAuth-bearing proxy session).

**None of these require withholding *compute* or *read* access to the data.** Reading the expression matrix and crunching it harms nothing — it's the user's own data in the user's own browser, and exfiltration is already blocked by (3). The dangerous axes are **writes** (DOM, app state), **network**, **resources**, and **secrets** — exactly what should stay mediated. We bundled "withhold data + compute" with "withhold dangerous ops" only because the iframe is all-or-nothing.

**Principle: separate the axes we ISOLATE (DOM writes, state writes, network, resources, secrets) from the axes we SHARE (data reads, compute).** Stop withholding the harmless-but-crippling part.

## 7. The generative-UI/UX reframe: trust by provenance + consent

The conventional assumption — "a widget is an untrusted third-party guest; cage it" — is too conservative when the widget is co-authored by the *same agent that drives the app*, under the user's eye, to do real analysis. With generative UI, the widget is increasingly **the app extending itself**, not a stranger. So trust should be **graduated by provenance and consent**, not a fixed cage:

- **Untrusted** (imported/shared from elsewhere, or unreviewed) → full sandbox.
- **Trusted** (agent-authored this session, or user-promoted/reviewed) → more privilege, by explicit user grant, revocable.

Provenance maps to threat model: an imported widget is a potential adversary (origin isolation matters); a self-authored-this-session widget's risk is mostly *accidental bugs*, where lighter containment + error boundaries may suffice.

## 8. Options

**A — Fix the moat inside the sandbox (lowest risk, trust model unchanged).** Keep the iframe; make data reads direct and cheap — a `SharedArrayBuffer`/transferable read-only view of columns the widget reads at native speed, plus bring-your-own-WASM. The widget becomes compute-equal via its own algorithms over a fast data view.
*Trade-offs:* SAB needs cross-origin isolation (COOP/COEP), fiddly with a null-origin iframe; the widget reimplements or `loadLib`s its own kernels rather than calling ours (acceptable — it can be just as capable). Reads expose the full local matrix to the widget, which is fine given network is mediated.

**B — Capability-based boundary (principled generalization of A).** Redefine the waist by *what it protects*: grant every widget first-class **data-read + compute** capabilities (direct/shared), and mediate *only* the dangerous ops (writes via the typed protocol, network via the allowlist). The "narrow waist" stops being "a short menu of data kinds" and becomes "everything readable + full compute; only side-effects are brokered." Optionally expose the existing kernels as a callable capability (they're pure compute — cheap and safe to offer).
*Trade-offs:* a coherent capability API to design; removes the whole class of capability gaps by construction.

**C — Tiered trust by provenance + consent (for the genuinely unbounded case).** Default *untrusted* → sandbox as today. A user-granted *trusted* tier runs in the **main/privileged context** with direct `ctx` + kernels + no marshalling — like browser-extension permissions or VS Code workspace trust; revocable per widget, tied to a content hash + review.
*Trade-offs:* blast radius — a trusted widget can crash the app or corrupt state. Needs a real consent gate, error boundaries, and a kill/disable switch. The honest "sometimes the widget IS the app" path.

**D — Split render from compute.** A widget = a sandboxed *render* surface (iframe/shadow root) + an associated *compute* context (a Worker the host runs on the widget's behalf, next to the data, with direct access + kernels, and **terminable**). Rendering stays caged; computation runs privileged-but-killable where the data is.
*Trade-offs:* two-part widget model is more machinery; but page↔worker transfer is far cheaper than iframe clone, SAB works cleanly there, and resource abuse is bounded (terminate the worker). This is the clean realization of "as capable as host" compute without exposing the main thread/DOM.

## 9. The legibility layer (the knowledge-gap half — orthogonal, still needed)

Capability without discoverability still fails. Regardless of which isolation option, also:

- **Single capability registry — define once, project everywhere.** Define each analytic primitive once (`{name, params schema, run(), summary}`) and generate from it: the agent's `compute`/tool schema, the widget capability, and the docs. Adding a primitive then lights it up for the analyst *and* widgets *and* the docs simultaneously — drift (overdispersion-style gaps) becomes structurally impossible.
- **Introspection at authoring time.** A `list_widget_capabilities` tool (generated from the registry, never stale): each capability's params, return shape, an example, and *when to use it* ("variable/overdispersed genes → … ; don't loop expr"). Plus one bridge sentence in the widget guidance: *"every analysis you can run as a `compute` tool is available inside a widget too."* That connects the agent's analyst knowledge to the widget surface — the missing wire.
- **Every capability ships a worked recipe**, so `find_widget_recipe` surfaces it as a *pattern*, not just a doc line.
- **Honest preview.** Preview simulation must faithfully reflect every capability — e.g. the bug where `rankGenes` returned empty in preview (the sim seeds `selectedCells` but not the selection that `rankGenes` defaults to) *lied* about a capability and cost the agent 3 iterations. Fix: when a preview sim provides a selection, every selection-defaulting data kind sees the simulated cells.
- **Soft lints, not blocks.** If a widget loops `expr` and a matching primitive exists, the preview *notes* "there's a kernel for this (faster), or carry on if you need custom logic" — informative, never refusing. Nudge, don't prohibit.

## 10. Recommendation

A **progression**, unified by *separate the axes*:

1. **Now:** make **data-read + compute first-class within the sandbox** (A→B) — fast shared/zero-copy reads, bring-your-own-WASM, optionally expose the kernels as a callable capability. This alone makes widgets analytically ~equal **without weakening safety**, because reads and compute were never the threat. Keep DOM containment + mediated writes/network always on. Land the legibility layer (§9) alongside — it's half the fix.
2. **Next, for the unbounded case:** a **consent-gated trusted tier** (C, ideally realized as D's render/compute split so even "trusted" keeps render containment + terminable compute), gated on provenance + explicit user grant, tied to the content-hash/review mechanism.

**Principles to carry forward:**
- Hardened primitives are **gravity, not gates** — make the fast/correct path the path of least resistance; keep every path open.
- **Separate what we isolate** (DOM writes, state writes, network, resources, secrets) **from what we share** (data reads, compute).
- **Define capability once, project everywhere** (no drift between analyst tools and widget surface).
- **Trust is graded by provenance + consent**, not a fixed cage.
- "Run it host-side" means **a different in-browser context**, never a server.

## 11. Immediate stopgap vs. the architectural direction

Distinct from the above: the immediate overdispersion case can be unblocked cheaply by **mirroring one more primitive** — give `rankGenes` a `mode:'variable'` that calls `ctx.view.overdispersedGenes` (parallel to how `rankGenes` already wraps `subsampleDE` for markers), plus the preview-selection-sim fix. That fixes *this* widget. It is **not** the architecture — it's another instance of the manual mirroring that caused the drift. The architecture is §6–§10: stop hand-maintaining a subset; share reads+compute behind a capability boundary defined once, with trust graded by provenance.

## 12. Current state (for grounding)

- Widgets: agent-authored code in a sandboxed iframe (`allow-scripts`, null origin) ↔ app via typed `postMessage` + a `pagoda` global. Host owns the panel chrome; iframe renders the body. See `web/src/widget/{contract,runtime,apphost,recipes}.ts`.
- Mediated writes: `setSelection / setColor / setHint / updateView`. Mediated network: `fetchExternal` (allowlist) + `loadLib` (pinned, SRI). Data kinds: `n, fields, categories, category, cellsOf, expr, numeric, selectedCells, groupStats, rankGenes`.
- Analyst tools incl. `compute` (de/overdispersion over cell-set algebra) and `compute_code` (sandboxed Web Worker). Kernels: libstar WASM in-browser, main thread.
- Proxy (`server/proxy.mjs`, :8786): no compute, no data.

*Related: `misc/annotation_panel.md`; memory `widget-authoring-substrate`, `persistence-design`, `generative-control-principle`.*
