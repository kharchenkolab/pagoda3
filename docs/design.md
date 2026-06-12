# pagoda2 generative viewer — detailed proposal (plan1)

Companion to `pagoda2-design-brief.md` (the *intent*) and `pagoda2-production.html`
(the *clickable embodiment*). This document **operationalizes** the brief: it turns
the principles into a concrete component spec, a comprehension/control model, a
pagoda2-specific application example, and a ranked list of mockup refinements. Where
the brief argues *why*, this argues *what exactly* and *how it behaves*. It does not
re-derive the brief; section references like (brief §2.2) point back rather than repeat.

**Thesis in one line.** Stability is the default and the user owns the layout; the
agent drives a shared coordination space and *earns* bigger moves; the agent's
**presence is proportional to its agency**; and **provenance travels with the data**,
so no view can show a result without surfacing how it was made and what it can't
establish.

**How to read this.** Parts I–III are the general approach (architecture →
comprehension → control). Part IV grounds all of it in pagoda2's actual analysis
elements. Part V is the actionable mockup work. Part VI sequences it and marks what
is real vs. illustrative.

---

## Part I — The generative-UI approach

### I.1 The reframe (compressed)
The proximal user is increasingly an *agent*; the human is the principal who steers
and verifies (brief §1.1). The viewer is the surface where steering and verification
happen. Two consequences drive every decision below: (a) the interface must present
cleanly to a non-deterministic caller without letting it corrupt the human's
instrument; (b) the scarce resource is *trust* — correctness a human can rely on and
an agent can't accidentally bypass.

### I.2 Two clocks
- **Layout** — slow-changing, *user-owned*, spatial. The inventory and arrangement of
  panels. Changes only by the user's hand or by an accepted proposal.
- **Coordination space** — fast-changing, *agent-driven*, declarative. What colours
  things, what's selected, what's in focus, which contrast/geneset/resolution is
  active. The agent drives this freely; every linked view re-reads it and repaints in
  place.

The single most important architectural commitment: **the agent's default verb writes
the coordination space, not the view inventory** (brief §2.2). "Show IL6 in
macrophages" sets `colorBy` + a selection and animates existing views; it does not
spawn a dashboard.

### I.3 The component vocabulary
The agent never emits markup. It authors a **declarative spec** (a node: `type`,
`props`, `bind`) validated against a fixed registry. Generativity lives at *authoring*
time — which components, how configured and bound — not at *render* time. Validation
rules (brief §2.1):
- `type` ∈ registry;
- `props` checked against a per-type schema (enums, ranges, allowed-lists);
- `bind` values resolve to a **data handle** in the catalog.

A node that fails validation becomes a **visible, inert placeholder** carrying the
reason — never silently dropped, never executed. More model freedom ⇒ more guardrails;
the surface stays finite. New capability arrives as a *new validated component*, never
as a drop to raw HTML (brief §5.4).

### I.4 Data-handle binding
Components carry **references, never raw data**. A handle is a stable, typed,
resolvable name:

```
embedding:main            de:macrophage.disease-v-control
gene:IL6                  geneset:GO:0006954
expr:IL6@Macrophage       aspect:7
qc:mito                   composition:byCondition
meta:cellType             tree:leiden@r1.0
```

Handles let the same product feed several views, let the validator confirm a view is
*possible* before rendering, and — critically (I.7) — carry provenance and caveats so
any binder inherits them. Specs stay small and auditable. A complete authored node and
its rejection counterpart:

```jsonc
// accepted — type ∈ registry, props in schema, binds resolve
{ "type": "Embedding",
  "props": { "pointSize": 3, "density": false },
  "bind":  { "cells": "embedding:main", "color": "gene:IL6" } }

// rejected — handle not in catalog → visible inert placeholder, never executed
{ "type": "Embedding", "bind": { "color": "gene:MADEUP" } }
//  ⇒ validation.rejected {type:"Embedding", reason:"unknown handle gene:MADEUP"}
```

### I.5 The ladder of restraint (internal)
The agent prefers the smallest change that answers the question:
- **Rung 0 — Coordinate.** Recolour / select / focus within the fixed layout.
- **Rung 1 — Add answer.** A disposable panel in the answer rail; pin to keep.
- **Rung 2 — Switch workspace.** A named, reversible layout change.
- **Rung 3 — Reconfigure.** A real relayout, shown as a diff to confirm.

The hard problem is the *policy of restraint* — teaching the agent when **not** to
touch the UI — not the rendering. The unit being protected is the user's spatial
memory; treat it as expensive. **Rungs are never shown to the user** (brief §2.6).
Rungs are one of two orthogonal axes; the other is *presence* (II.3), reconciled there.

### I.6 Surfaces & routing
Six surfaces receive agent output; the routing *is* the restraint policy made
concrete:

| Surface | Lifetime | Who owns it | Carries |
|---|---|---|---|
| **Canvas** (workbench) | durable | user | the pinned, load-bearing views |
| **Answer rail** | ephemeral | agent (liberal) | disposable answers; pin promotes |
| **Proposal card** | until decided | agent proposes | a diff for a Rung 2/3 move |
| **Caveat banner** | attached to a view | the handle | what a result can't establish |
| **Toast** | transient | agent | "what I did" + on-demand "why?" |
| **Timeline thread** | swells then recompacts | shared | live dialogue / autopilot trace |

Routing table (intent → surface): coordinate→canvas-in-place; one-off answer→rail;
workspace/relayout→proposal; methodological warning→caveat (inherited); acknowledgment
→toast; multi-turn or multi-step→thread (Part II.3). **Pinning is the only act that
promotes ephemeral → durable** (brief §2.4).

### I.7 Provenance & caveats travel with the handle
The keystone, and the brief's highest-value open item (brief §5.1). Provenance (method,
params, software version, n units) and caveats (what the result does *not* support)
are **properties of the handle**, not of the view. Any component that binds a handle
**inherits** them automatically and renders them (caveat banner + provenance footer).
The agent therefore *cannot* display a result without surfacing how it was made. This
is the join between the presentation layer and the cacoa methodological layer (Part
II.5) — the thing that makes the system trustworthy rather than merely tidy.

---

## Part II — Enabling user comprehension

The question this part answers: *how does the human understand what is on screen, what
the agent just did, and what is actually true?*

### II.1 Object permanence
Disorientation comes from change that is irreversible, unlabeled, and spatially
destructive (brief §2.2). Defenses: stability is the default; when a view *does* move,
use **FLIP / shared-element transitions** so the eye tracks it from old position to
new (brief §5.3). A panel that moves should appear to *travel*, not vanish-and-reappear.

### II.2 Restraint felt, not displayed
The agent's restraint is made legible three quiet ways (brief §2.6): (a) the change
itself is visible; (b) an on-demand **"why?"** explains, in plain language, that it
made the smallest edit it could; (c) big moves announce themselves as **proposals**.
No "RUNG 0/1/2/3" ever appears. Legibility is pull, not push.

### II.3 Presence proportional to agency
The agent is near-invisible when the human drives, and becomes more present *and more
inspectable* exactly in proportion to how much it is doing — then recedes the moment it
hands the wheel back. **Permanent footprint ≈ zero; presence is rented, not owned.**

Five modes along that axis (the spectrum we prototyped):

| Mode | Trigger | Presence | Recedes to |
|---|---|---|---|
| **1 · Instrument** | direct manipulation | status pip only | — |
| **2 · Quick ask** | ⌘K, single-turn | summoned palette → rail | nothing |
| **3 · Dialogue** | multi-turn reasoning | thread at timeline tip | one checkpoint |
| **4 · Autopilot** | agent runs many steps | live, interruptible trace | one checkpoint |
| **5 · Nudge** | agent speaks first | quiet badge on the pip | opened or ignored |

Two carriers make this work without a permanent panel:
- **The presence pip** — the single always-visible chat atom (the `Ask ⌘K` control as a
  status light: idle · listening · working · nudge). It conveys *the agent is here,
  here's its state, click to engage*.
- **The conversation is the live tip of the timeline.** The bottom strip is normally a
  thin row of resolved checkpoint chips; when something is in flight its leading edge
  **swells into a thread**, then recompacts to a chip when settled. One data structure,
  two renderings. No new column; no idle text box exerting gravity.

**Rungs × modes — two orthogonal axes (the reconciliation).** A *rung* (I.5) measures
**how much the layout changes**; a *mode* measures **how present the agent is**. They
compose, they don't collide:
- The **rung governs consent** — a big rung (2/3) needs a proposal, regardless of mode.
- The **mode governs presence** — a big mode (3/4) gets a thread, regardless of rung.

So a Mode-4 autopilot run may execute several Rung-0/1 changes *and* surface one Rung-3
proposal inside its trace; a Mode-2 quick ask is usually Rung 0 or 1; a Mode-3 dialogue
can conclude at any rung. Reading them as one ladder is the common mistake.

**Why real-estate and transparency don't fight.** The two needs peak at *different
times*. Pixels are scarcest in Modes 1–2 (hands on a dense embedding) — exactly when
presence is near-zero. Transparency matters most in Modes 4–5 (the agent is
reorganizing things, or making a claim you must trust) — exactly when you are *not*
also trying to read 200k cells. You never pay both costs at once.

### II.4 The timeline as transcript
Every state is a **named checkpoint** on a navigable spine (brief §2.5). The same
structure serves four jobs at once: undo/redo, conversation history, the reproducible
record, and the provenance trail. You don't need a separate chat log in a spatial
tool — each entry is *(utterance/action → resulting state → one-line why)*. A multi-turn
dialogue or an autopilot run is *one* checkpoint, not a scroll of micro-events: the
back-and-forth is working memory; only the conclusion is durable.

### II.5 Caveats as first-class UI
The cacoa methodological layer is encoded judgment that stops an agent doing the
plausible-but-wrong analysis (brief §1.3). These must be **UI the agent can't forget**,
not prose it might. Surfaced via inherited caveat banners (I.7). The core set:

| Caveat | What it prevents | Where it surfaces |
|---|---|---|
| The **sample is the replicate**, not the cell | cell-level p-values read as population effects | DE table/volcano banner; box-by-sample is the *remedy* view |
| **Compositional constraint** (proportions sum to 1) | "cluster X up" read without "something else down" | composition bars; per-cluster tests flagged |
| **Pseudobulk, not pooled-cell Wilcoxon** | inflated significance from pseudoreplication | DE handle provenance + contrast selector |
| **Magnitude confounded with cell count** | bigger clusters look like bigger effects | DE/expression-shift views; de-biased via permutation null |
| **Refuse/caveat underpowered designs** (e.g. 1-vs-1) | claims a design can't support | the contrast is offered with a refusal/asterisk, not a clean result |
| **Overdispersion ≠ DE** | aspect significance read as group difference | overdispersion view banner |

### II.6 Provenance display & threshold ownership
Each view shows *how it was made* (provenance footer) and, where relevant, *what it
doesn't establish* (caveat). Thresholds (e.g. volcano `lfc`/`padj`) can be agent-set,
human-set via a control, or fixed by provenance — probably all three, with provenance
recording **which**, so a result is never silently re-cut (brief §6).

---

## Part III — Enabling user control & input

The question this part answers: *how does the human steer?*

### III.1 Manipulation as the primary verb
Most steering is direct, not typed: drag-select on the embedding, per-panel colour
control, click a DE gene to coordinate, pin/dismiss in the rail, lock the layout,
switch workspace tabs, right-click for a context menu. Each emits a typed event
(III.7). The win: **specifying the referent is the hard part of talking to these
tools, and manipulation specifies it for free.**

### III.2 Language summonable & anchored
Language is for the long tail with no widget. Two forms (brief §2.7):
- **⌘K command palette** — zero permanent footprint, keyboard-navigable, suggestions
  that teach the vocabulary.
- **Selection-anchored asks** — select cells → a popover; "ask about these" pre-scopes
  the palette. *The selection carries the "what"; the words carry only the "verb."*

### III.3 The thread input model
Inside an active dialogue (Mode 3), the user can also **type**, not just tap reply
chips — but as a *per-turn, summoned* affordance, never a permanent box.
- **Chips are accelerators + vocabulary teachers**; the free-text row handles the long
  tail and the *pivot* (an answer that redirects the thread rather than advancing it).
- **The thread input is the ⌘K palette in its most-anchored posture** — same input
  model, pre-scoped to the open turn. Pressing ⌘K while a thread is live focuses *that*
  input rather than opening a fresh palette.
- **Open vs. closed turns.** Free-text when the response space is open; **chips-only**
  when it's genuinely closed (binary disambiguation, confirmations, gates) — a box
  there only invites fighting the parser. Even a closed turn may offer a small
  "actually…" escape that opens text to override.
- Reply-vs-pivot classification is a real-planner job, not a keyword-matcher one
  (Part VI.2).

### III.4 The five modes from the control side
Who initiates, and the **interruption budget** (when the agent may seize attention):
- Modes 1–3 are **human-initiated**; the agent only ever responds.
- Mode 4 (autopilot) is human-*authorized* — the agent takes the wheel on an explicit
  ask, the trace is live and **interruptible at any step** (Pause/Stop), and every big
  move inside the run is still a **proposal** (diff-to-confirm). Seizing the wheel
  returns control instantly and preserves the partial run as a checkpoint.
- Mode 5 (nudge) is the only **agent-initiated** surface; it spends from a budget — a
  quiet badge, never modal, rate-limited, and reserved for findings that change what a
  result *means* (a confound, a failed assumption), not for chatter.

### III.5 Layout as a direct-manipulation object
The canvas is the user's instrument and is edited *directly*:
- **Drag a panel** by its header to reorder; **resize** via an edge handle; **remove**
  via a close control; **pin** an ephemeral answer to promote it.
- A grid model (span 1 or full width) keeps arrangements legible; free placement is a
  later option.
- Manual layout edits **always win** over the agent (III.6). They are checkpoints like
  any other ("removed Composition panel").

### III.6 User authority overrides the agent
The human disposes (brief §2.8). Concrete: **lock the layout** and the agent
*downgrades* — a move that would have been a workspace switch is routed to a rail
answer instead, and it says so. Autopilot refuses to run against a locked layout.
Proposals never change anything until applied.

### III.7 The two-way event channel
Direct manipulation emits **typed events referencing shared handles**; the agent
consumes them to stay in sync with what the human is looking at and re-plan (brief
§4.2). Emitted today / reserved:

```
selection.created {n, handle, composition}   colorBy.changed {handle}
focus.changed {dim, value}                    deGene.selected {gene}
geneset.selected {handle}                     contrast.changed {handle}
threshold.changed {lfc, padj}                 resolution.changed {value}
validation.rejected {type, reason}            gate.applied · cluster.merged
                                              cell.flagged · annotation.edited
```

### III.8 Configurability of the conversational surface
Resist a permanent chat sidebar **as default** (it competes for space and starves
manipulation), but allow it: "pin the conversation open" docks the expanded-timeline
thread as a column for users/shops who want an always-on transcript (teaching,
onboarding, high-stakes review). Because the conversation *is* the timeline rendered as
a thread, this costs no new surface (brief §2.7, §7).

---

## Part IV — The pagoda2 application example

### IV.1 Analysis context
pagoda2 rapidly processes large, sparse scRNA-seq datasets (~1e6 cells): QC and
filtering, normalization, clustering, embedding, differential expression, and — its
differentiator — **geneset/pathway overdispersion and de-novo "aspect" analysis**
(which gene programs distinguish subpopulations, including GO categories). The old
Rook frontend let users click clusters, recolour by gene/geneset, and run DE in the
browser. The worked story used throughout: an **IL6 up-shift in disease macrophages
that is actually carried by a single donor (D5)** — the case that makes the
sample-is-replicate caveat bite.

### IV.2 The coordination space schema (pagoda2)
```
coord = {
  colorBy:   handle,        // meta:* | gene:* | geneset:* | qc:* | de:*
  focus:     {dim, value},  // e.g. {condition: "disease"} — dims everything else
  selection: {ids, handle, composition},
  geneFocus: handle,        // a single highlighted gene across views
  geneset:   handle,        // active aspect/pathway (heatmap + overdispersion + embedding)
  contrast:  handle,        // active DE contrast (table + volcano)
  thresholds:{lfc, padj},   // shared DE cutoffs
  resolution:number,        // clustering cut (re-derives cluster handles)
}
```
All linked views read this; `updateVisuals()` repaints in place. Layout (`WS`,
`canvas`) is the *other* clock and is untouched by coordination changes.

`colorBy` vs `geneFocus` are distinct levers and frequently confused, so fix it here:
`colorBy` is the **dominant encoding** — it repaints an entire embedding/heatmap by one
value (`gene:IL6`, `meta:condition`, …). `geneFocus` is a **lightweight cross-view
highlight** of a single gene — it labels that gene in the volcano, outlines its heatmap
row, marks it in lists — *without* changing any view's colour encoding. Clicking a DE
gene sets `geneFocus` (the cheapest, Rung-0 highlight); recolouring the embedding by it
is the additional, separately-decided act of also setting `colorBy=gene:<G>`.

### IV.3 Component catalogue
For each: *what it shows · handles · reads/writes coord · per-panel controls ·
provenance & caveat.* Caveats below are the per-view face of the canonical catalog in
II.5; the agent configures a component by writing the same coord/props a user control
would, so "how the agent configures it" is general, not per-component.

**Embedding** (2D scatter; UMAP/largeVis/tSNE).
Shows cells in 2D. Binds `embedding:<id>`. Reads `colorBy, focus, selection,
geneFocus`; writes `selection` (brush), `colorBy` (per-panel dropdown). Controls:
colour-by, point size, density toggle, box/lasso select, focus toggle. Provenance:
method + params + n cells. Caveat: embedding distances aren't metric — don't read
cluster separation as effect size.

**Expression / geneset heatmap** (the pagoda2 staple).
Rows = genes or genesets/aspects; columns = clusters/cells/samples ordered by the
dendrogram. Binds `expr:<geneset>@<grouping>` or `matrix:<aspect>`. Reads `geneset,
resolution, selection` (highlights columns), `geneFocus` (highlights a row); writes
`geneFocus` (click row), `selection` (brush columns). Controls: grouping, scaling
(z/raw), gene/geneset set, row clustering, transpose. Provenance: normalization, batch
correction, overdispersion model. Caveat: scaled values hide magnitude; an aspect is a
denoised meta-gene — interpret loadings, not single genes.

**Geneset / aspect overdispersion view** (the differentiator).
Ranks significantly overdispersed gene sets / de-novo aspects by adjusted variance;
selecting one loads it into the heatmap and colours the embedding. Binds `aspect:<id>`
/ `geneset:<go-id>`. Writes `geneset`, `colorBy=geneset:<id>`. Controls: ontology
filter (GO BP/MF/CC, custom), significance threshold, annotated-vs-novel toggle, sort.
Provenance: testGeneSets/pathwayOverdispersion params + correction. Caveat:
overdispersion ≠ DE; annotation overlap inflates apparent significance; aspects can be
technical.

**DE / gene list** (table).
Ranked genes for the active contrast. Binds `de:<contrast>`. Reads `thresholds,
geneFocus`; writes `geneFocus`/`colorBy` on click. Controls: contrast selector, sort,
threshold sliders (shared), search, export. Provenance: estimatePerCellTypeDE /
pseudobulk method + n donors. Caveat: cell-level Wilcoxon inflates significance —
prefer pseudobulk; underpowered contrasts are flagged or refused.

**Volcano.**
DE scatter (lfc × −log10 padj) for the active contrast. Binds `de:<contrast>`. Reads
`thresholds` (dragging the cut lines moves the table too); writes `geneFocus` on click.
Controls: threshold handles, label toggle. Same provenance/caveats as DE.

**Composition bars.**
Per-sample cluster proportions, stacked, grouped by condition. Binds
`composition:<grouping>`. Reads `focus`. Controls: normalize, group-by, stat-test
toggle. Provenance: compositional-aware test (cacoa/CODA). Caveat: proportions sum to 1
— one cluster up forces others down; use a compositional model, not per-cluster tests.

**Box / violin by sample** (the replicate-aware view).
Per-donor distribution of a gene/score within a cell type. Binds `expr:<gene>@<celltype>`
grouped by sample. Reads `geneFocus, focus`. Controls: gene picker, show-points,
donor-mean. Provenance: per-donor aggregation. Caveat: *this is the replicate view* —
the donor is the unit; one donor can drive an apparent shift (the D5 story). Often the
*remedy* a DE caveat points to.

**Dendrogram / cluster tree.**
Hierarchical structure; the cut sets resolution. Binds `tree:<id>`. Reads `resolution,
selection`; writes `resolution` (cut height), `selection` (click a node = subtree).
Controls: cut/resolution slider, collapse/expand. Provenance: clustering method,
distance, walktrap/leiden params. Caveat: the tree is one of many; the cut choice
changes downstream DE.

**Cell-metadata / annotation panel.**
Categorical/continuous metadata summary; editable annotations. Binds `meta:<field>`.
Reads `selection`; writes `annotation.edited`, `colorBy`. Controls: field picker, edit
labels, "create grouping from selection." Provenance: source (uploaded vs derived).
Caveat: derived annotations are model outputs; edits create new provenance.

**Note / caveat / provenance affordances.**
Not data views — carriers. The caveat banner and provenance footer render
*automatically from handle metadata* (I.7); the Note component holds free agent text.

### IV.4 Canonical workspaces
- **Overview** — Embedding + Composition. Orientation; `colorBy=meta:cellType`.
- **DE deep-dive** — Embedding (coordinated) + DE table + Volcano + Box-by-sample;
  carries the replicate caveat; `colorBy=gene:IL6`.
- **QC triage** — Embedding (mito) + QC metrics + doublet/ambient views.
- **Pathway / aspect exploration** — Embedding + overdispersion list + heatmap. The
  pagoda2-signature workspace, absent from the current mockup.

### IV.5 Worked walkthroughs (exercise all five modes)
1. **The donor-D5 story.** Ask "show IL6" (Mode 1/Rung 0 → recolour). Ask "is it driven
   by one donor?" (Rung 1 → box-by-sample in rail). Agent *nudges* (Mode 5) that the
   shift leans on D5. Open it → *dialogue* (Mode 3) on population-vs-subpopulation →
   pin the per-donor view. The DE table's inherited caveat was true the whole time.
2. **QC-cleanup autopilot.** "Set me up to triage QC" → *autopilot* (Mode 4): survey
   metrics → flag high-mito/doublets → **propose** the QC-triage relayout → recolour by
   mito. Interruptible; recompacts to one checkpoint.
3. **One-off comparison.** "Compare CD3D between conditions in T cells" → a rail answer
   (Rung 1); discarded or pinned. Nothing load-bearing moved.

---

## Part V — Mockup refinements (build or describe)

Scope rule: **build a load-bearing subset in the HTML; describe the rest in prose**
with explicit acceptance criteria, so the file stays a faithful embodiment without
pretending everything is wired.

| # | Refinement | Build / describe | Acceptance criterion |
|---|---|---|---|
| V.1 | **Panel drag-reorder, resize, remove** | build | a panel can be dragged by its header to a new grid slot, resized 1↔full, and closed; each is a checkpoint |
| V.2 | **FLIP transitions** | build (basic) | a relayout animates panels from old → new position, not fade-out/in |
| V.3 | **Thread input row** | build | an open dialogue turn shows chips *above* a "type your own…" row sharing the palette model; closed turns show chips only |
| V.4 | **Workspace management** | describe + minimal build | save / rename / duplicate / reorder tabs; new workspaces are user-named |
| V.5 | **Pin-open / resizable thread** | build (toggle) | a control docks the thread open as a column; default stays collapsed |
| V.6 | **Handle-level provenance** | build (data model) | caveat + provenance attach to a *handle*; any panel binding it renders them with no per-panel string |
| V.7 | **Discoverability** | build | thread flashes/auto-scrolls on open; palette shows contextual suggestions; empty rail coaches |
| V.8 | **Validation & refusal placeholder** | build | an invalid spec renders a visible inert placeholder with the reason, never executes |
| V.9 | **Geneset/aspect overdispersion component** | build (mock) | a ranked overdispersion list that, on click, sets `geneset` + recolours the embedding |

### V.6 detail (the keystone build)
Replace per-panel `prov`/`caveat` strings with a `HANDLES` catalog:
`{ "de:macrophage…": { prov, caveat, n, method } }`. `panelEl()` resolves a panel's
binding to its handle and renders inherited banners/footers. This makes II.5 and I.7
real in the mock rather than attached by convention (the current file's biggest gap).

---

## Part VI — Sequencing & open questions

### VI.1 Ranked next steps
1. **Handle-level provenance** (V.6 / I.7) — highest value; makes the system
   trustworthy rather than tidy.
2. **The real rung-selection policy** — replace the keyword matcher with an intent
   classifier that picks the lowest sufficient rung, respects locks, and explains
   itself; decide what is *code-enforced* (cacoa refusing a 1-vs-1 DE) vs.
   *prompt-persuaded* (the strongest version does both).
3. **FLIP / shared-element transitions** (V.2).
4. **Layout direct-manipulation** (V.1).
5. **Vocabulary growth discipline** — every new request biases toward "compose existing
   components" or "add one well-specified component," never raw HTML.
6. **Palette discoverability** (V.7) — ongoing.

### VI.2 The planner boundary
What stays keyword-matched in the mock vs. what the real classifier owns: rung
selection, reply-vs-pivot in a dialogue, the nudge interruption budget, and
refuse/caveat decisions. These are the actual engineering; the mock's `agent()` regex
is the single biggest stand-in (brief §3.1).

### VI.3 Build phasing
- **Done (mockup):** all of Part V — V.1, V.2 (grid FLIP), V.3, V.4, V.5, V.6, V.7 (partial), V.8, V.9.
- **Next polish:** FLIP for cross-workspace moves; geneset as a transient colour-dropdown option;
  richer event back-channel (consume events, not just emit); props-schema checks in `validate`.
- **Real engineering:** the planner (VI.2), real data plumbing, the full registry + handle catalog.

### VI.4 Rejected alternatives to preserve
- Regenerating the dashboard per request (destroys spatial memory).
- A permanent chat sidebar as default (becomes the only channel; starves manipulation).
- Showing the rung ladder to users (it's the agent's internal cost model).
- Raw HTML/JS from the agent (injection + correctness hazard).
- Caveats as agent prose (forgettable; must be inherited UI).

### VI.5 Risks of the chosen design (not just the rejected ones)
Naming where *this* design can fail, so iteration watches for it:
- **The thread is easy to miss.** It swells from the bottom strip; users trained on
  center/sidebar chat may not look down. Mitigations: flash/auto-scroll on open
  (V.7), the pip's working state as a pointer. Watch in testing.
- **Autopilot can feel like loss of control** even when interruptible. The Pause/Stop
  affordances and per-step proposals must be *obvious*, not discovered.
- **Inherited provenance can clutter.** If every panel always shows a banner + footer,
  the signal dulls. Likely needs density tiers (collapsed by default, "why?" expands).
- **The two-clock model leaks** when a coordination change *implies* a layout need
  (asking for a view you don't have). The rung policy must classify this crisply or the
  agent will either over-build (Rung 3 for a Rung 1 question) or under-answer.
- **Nudge fatigue.** A proactive agent that badges too often retrains users to ignore
  it — the interruption budget (III.4) is load-bearing, not decoration.
- **Mock realism debt.** A keyword matcher passing as a planner can make the design
  *look* more solved than it is; VI.5 exists to keep that honest.

### VI.6 Real vs. illustrative ledger (updated)
| Piece | State |
|---|---|
| Mock seeded data (~340 cells; D5 story) | illustrative |
| `agent()` keyword matcher | illustrative (the big stand-in) |
| Coordination space + in-place repaint | real pattern |
| Layout/state two-clock separation | real pattern |
| Pin / rail / proposal / timeline / palette / pip / thread | real pattern |
| Presence-proportional-to-agency (5 modes) | real pattern, mock triggers |
| Handle-level provenance (caveat+prov inherited from `HANDLES`) | **built (V.6)** |
| Layout direct-manipulation (drag-reorder · span · close) | **built (V.1)** |
| FLIP transitions | **built (V.2, grid FLIP)** |
| Thread free-text input (open vs. closed turns; refine vs. pivot) | **built (V.3)** |
| Geneset/aspect overdispersion component + geneset colouring | **built (V.9)** |
| Thread first-open flash / auto-scroll | **built (V.7, partial)** |
| Workspace mgmt (save · rename · duplicate · reorder · delete) | **built (V.4)** |
| Pin-open / docked conversation column (always-on transcript) | **built (V.5)** |
| Component registry + validation → visible inert placeholder | **built (V.8)** |
| Two-way event channel (`validation.rejected` emitted) | partial (console `emitEvent`) |

---

## Closing — why these three, together

The proposal keeps returning to three mechanisms because they are the same bet seen
from three sides. **Presence proportional to agency** makes the agent's work
*inspectable* exactly when it matters. **Provenance that travels with the handle** makes
every result *account for itself* — the agent cannot show a finding without showing how
it was made and what it can't support. **The timeline as transcript** makes every state
*recoverable and replayable*. Inspectable, accountable, recoverable: that is what it
means to make correct analysis legible to a human and un-bypassable by a machine — the
scarce thing (brief §1.1). The instrument stays stable and the human stays in
authority; the agent earns its reach one verified step at a time.
