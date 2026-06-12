# pagoda2 generative viewer — design brief & handoff

A working note for iterating in Claude Code. Companion file: `pagoda2-production.html`
(the latest realization). This document explains the *intent* behind that file —
what it is trying to be, which alternatives were rejected and why, and what is
real vs. illustrative — so iteration doesn't accidentally undo a deliberate
choice or polish a part that was only ever a stand-in.

---

## 0. One-paragraph summary

We're designing the pagoda2 viewer (and, by extension, conos/cacoa) for a world
where most analysis is agent-driven rather than hand-coded, and where the human's
job shifts from *writing* analysis to *steering and verifying* it. The viewer
becomes the surface where that steering and verification happen. The central
design problem is that naive "AI generates a fresh UI per request" disorients the
user; the resolution is a **persistent layout the user owns** plus a **shared
coordination space the agent nudges**, where the agent always prefers the smallest
change that answers the question and *earns* bigger ones. `pagoda2-production.html`
is a clickable embodiment of that resolution.

---

## 1. The general idea

### 1.1 The reframe
In an agent-dominated world, three things shift at once:
- **The user changes identity.** The proximal user of the package is increasingly
  an *agent*; the human is the principal/supervisor. Tools must present cleanly to
  a non-deterministic caller (it may hallucinate, misread purpose, pass malformed
  args, or blow up its context window) while still serving the human behind it.
- **Volume goes up, manual coding goes down.** Far more analysis happens because
  the barrier collapses, but very little of it is typed by hand.
- **Trust/verification becomes the scarce resource.** Capability is commoditised
  monthly; what stays scarce is *correctness a human can rely on* and *an agent
  can't accidentally bypass*. Whoever makes correct analysis legible and
  enforceable to a machine owns the durable advantage.

### 1.2 Use-pattern scenarios (the strategic map)
We sketched six ways these packages get used; they coexist and map onto two axes
(human-in-loop ↔ autonomous; boutique ↔ commodity-scale):
1. **Tool library the agent calls** (MCP-native toolkit; already real — scmcp,
   CellAtria, etc.).
2. **Embedded expertise** — the package ships its *judgment* (a methodological
   skill), not just functions. This is the moat. cacoa is the crown jewel here.
3. **Verification & steering surface** — the viewer reborn as where the human
   checks and steers. **This is the thread the HTML belongs to.**
4. **Commodity-scale autonomous analysis** (headless, reproducible, interop-first).
5. **Living/federated atlases** (conos's domain; incremental, reference-mapping).
6. **Contrarian "what survives"** — agents write disposable glue; the package
   shrinks to its irreducible validated core + canonical vocabulary.

The "no-regret" investments across all six: a machine-actionable interface;
provenance/reproducibility in the object model; statistical guardrails as
*enforced code*; standard data structures + ontology grounding; compact structured
outputs; a constrained generative-UI vocabulary with a two-way event channel;
shipped evals.

### 1.3 The two layers that meet in the viewer
- **Methodological layer (cacoa "skill").** Encoded judgment that stops an agent
  doing the plausible-but-wrong analysis: *the sample is the replicate, not the
  cell*; compositional constraints (proportions sum to 1); expression-shift
  magnitude is confounded with cell count and de-biased via sample-label
  permutation nulls; pseudobulk DE not pooled-cell Wilcoxon; refuse/­caveat when a
  design (e.g. 1-vs-1) can't support a claim. The point for the viewer: these
  caveats and the provenance of each result should be **first-class UI**, not
  prose the agent might forget.
- **Presentation layer (generative-UI vocabulary).** A *finite, validated* set of
  components the agent composes; the viewer renders only validated components, so
  arbitrary HTML/JS never reaches the DOM. Generativity lives at *authoring* time
  (which components, how configured/bound), not at *render* time.

---

## 2. Nuances we worked through (and alternatives we rejected)

These are the non-obvious calls. Preserve them.

### 2.1 Constrain the generation surface
An agent emitting raw markup into a scientific viewer is both an injection surface
and a correctness hazard (a hallucinated axis looks as polished as a correct one).
So the agent authors a **declarative spec** validated against a fixed registry.
Rules: `type` must be in the registry; `props` checked against schema
(enums/ranges/allowed-lists); `bind` values must resolve to a **data handle** in a
catalog (components carry *references*, never raw data). A rejected node becomes a
*visible, inert placeholder* — never silently dropped, never executed. More model
freedom ⇒ more guardrails; keep the surface finite.

### 2.2 The disorientation problem (the big one)
**Critique:** if every request regenerates the dashboard, the user is disoriented.
**Why it's right:** the reason chat is bad at data analysis is the lack of
persistent spatial structure (the "keyhole effect"); a UI that rebuilds its layout
each turn reintroduces that exact failure. Object permanence, recognition-over-
recall, and muscle memory are what make an instrument usable, and full regeneration
destroys them.

**Resolution — separate two clocks:**
- **Layout** = slow-changing, *user-owned*, spatial.
- **Coordinated state** = fast-changing, *agent-driven* (which gene colours things,
  what's selected, what's in focus).

This is exactly **Vitessce's coordination model**, and it's the durable insight —
views are persistent and decoupled; what's shared and manipulated is a coordination
space. The agent should, by default, drive the *coordination space*, not the *view
inventory*. "Show IL6 in macrophages" sets `colorBy` + a selection and animates the
existing linked views; it does **not** spawn a dashboard.

### 2.3 The ladder of change (default to the lowest rung)
The agent prefers the smallest change that answers the question:
- **Rung 0 — Coordinate.** Recolour / select / focus within the fixed layout.
- **Rung 1 — Add answer.** A disposable panel in the *answer rail*; pin to keep.
- **Rung 2 — Switch workspace.** A named, deliberate, reversible layout change.
- **Rung 3 — Reconfigure.** A real relayout, shown as a *diff to confirm*.

The hard engineering problem is not rendering — it's this **policy of restraint**:
teaching the agent when *not* to touch the UI. The unit being protected is the
user's spatial memory; treat it as expensive.

### 2.4 Durable canvas vs. ephemeral answers
Two surfaces. The **canvas/workbench** is user-owned; the agent touches it only
additively and (for big moves) with permission. The **answer rail** is disposable;
the agent is liberal there because nothing is load-bearing. Generation accretes into
the workbench **only by the user's act of pinning**. Over a session the layout
converges on what *this* user wants for *this* dataset — a better-fitted instrument
than any pre-built app, reached without writing code, without the floor moving.

### 2.5 Flux → navigable history
Disorientation largely comes from change being *irreversible and unlabeled*. Make
every state a **named checkpoint** on a timeline you can scroll and jump back to;
"many configurations" becomes navigable history rather than churn — and doubles as
the reproducible, shareable record provenance wanted anyway. **The timeline IS the
transcript** (see 2.7).

### 2.6 The rung ladder is scaffolding, not UI
In the teaching demo the rungs were *displayed* to make the policy auditable to us.
**End users must never see "RUNG 0/1/2/3"** — that's the agent's internal decision
procedure (like printing a query planner's cost estimates over a database GUI). Its
*legibility* is preserved three quieter ways: (a) the change itself is visible; (b)
an on-demand **"why?"** on each action explains, in plain language, that it made the
smallest edit it could; (c) big moves announce themselves by being *proposals*.
Restraint is **experienced, not displayed**.

### 2.7 Chat is a channel, not the throne
**A single always-on command line is not the production answer** — it's the keyhole
trap again (linear, ephemeral, recall-over-recognition). Decisions:
- **Manipulation is the primary verb** (drag-select, per-view colour control, click
  a result to coordinate, pin/dismiss, lock, workspace tabs, context menus).
- **Language is summonable and context-anchored**, for the long tail with no widget.
  A **⌘K command palette** (zero permanent footprint) and **selection-anchored asks**
  (select cells → a popover; "ask about these" pre-scopes the palette). *The
  selection carries the "what"; the words carry only the verb* — this is the single
  biggest usability win, because specifying the referent is the hard part of talking
  to these tools.
- **The agent's outputs are routed to the right surface** — coordinated changes
  happen in the views, answers go to the rail, big changes are proposal cards,
  caveats attach to the relevant panel, a short "what I did" is a transient toast —
  **not** a growing chat scroll that narrates state you can already see.
- **No permanent chat sidebar.** It competes for space/attention and tends to become
  the only channel people use, starving manipulation. Resist it as a default; don't
  ban it (some users want it; this should be configurable).
- **The timeline doubles as the conversation history.** You don't need a separate
  chat log in a spatial tool; each timeline entry is (utterance/action → resulting
  state → one-line why).

### 2.8 User authority overrides the agent
The human disposes. Concrete instance: **lock the layout** and the agent *downgrades*
— it routes what would have been a workspace switch into a rail answer instead, and
says so. Manual edits to one's own layout always win.

### 2.9 Where generative UI does / doesn't earn its keep
It does **not** replace the designed app. Fixed, curated, stable UIs win for routine
repeated work, teaching/onboarding, and high-stakes review where predictability *is*
the feature. Generative UI earns its place in the **long tail**: the one-off
comparison nobody pre-built, exploratory questions where the right view isn't known
in advance, dataset-specific quirks. Framing: the agent extends the curated app into
its long tail on demand, and the good extensions fold back into the durable
workbench.

---

## 3. The latest realization (`pagoda2-production.html`)

A production-*shaped* rebuild. What changed from the teaching demo:
- Rung ladder removed; replaced by toasts + on-demand "why?" + proposals.
- Explanatory header/subtitle removed; slim app top bar.
- Canvas owns the screen.
- Answer rail is a **drawer that collapses to zero width when empty** and reclaims
  its space — never a permanently reserved column.
- History is a **slim collapsible bottom strip = the transcript**.
- Multiple input channels wired: direct manipulation (drag-select, per-panel colour
  dropdown, click-a-DE-gene-to-coordinate, right-click context menu, workspace tabs,
  lock), **⌘K palette** (summonable, context-aware, keyboard-navigable),
  **selection-anchored popover** (pre-scopes asks to the selection), keyboard (⌘K,
  Esc, ⌘Z to step back through history).
- Agent outputs routed to surfaces (coordinate / rail / proposal / attached caveat /
  toast).
- Workspaces (Overview, DE deep-dive, QC triage) as named, switchable, reversible
  layouts.

### 3.1 What is REAL in the file vs. ILLUSTRATIVE (read before iterating)
- **Mocked, deterministic data** (seeded RNG; ~340 cells; a hand-built macrophage
  DE list; an IL6-by-donor story where donor D5 drives the shift to make the cacoa
  caveat meaningful). No real data plumbing.
- **The "agent" is a keyword matcher**, not a planner. `agent(qraw, scope)` regexes
  the request to a rung+action. This is the single biggest stand-in: the real
  rung-selection *policy* is the actual engineering and does not exist here.
- **~7 components** implemented (Embedding, CompositionBars, DeTable, BoxBySample,
  Volcano, Note, plus caveat/provenance affordances). Representative, not the set.
- **Transitions are simple fades**, not FLIP — so when a layout *does* change, object
  permanence is weaker than it should be. Real implementation needs FLIP/shared-
  element transitions for moved panels.
- **Palette discoverability is unsolved** (mitigated by suggestions + the selection
  popover). Ongoing design surface, not done.
- **Provenance/caveats are attached by convention** (workspace-level caveat string,
  per-panel `prov` string), *not* yet borne by the data handle (see 4.2 — the most
  important gap).

---

## 4. Architecture to preserve (concept → where it lives in the HTML)

| Concept | In the file |
|---|---|
| **Coordination space** (shared, persistent state) | `coord = {colorBy, focus, selection}`; all embeddings read it; `updateVisuals()` repaints in place |
| **Layout vs. state separation** | `WS` workspaces define layout; `coord` is the fast state the agent drives |
| **Component vocabulary / renderers** | `bodyFor(p)` switch; per-type body builders; `panelEl()` wraps with header/controls |
| **Persistent canvas** | `canvas[]` + `fullRender()` → `#workbench` |
| **Ephemeral answer rail** | `rail[]` + `renderRail()`; drawer open/close via `setRail()` |
| **Pinning (promote to canvas)** | the `pin` button in `renderRail()` |
| **Named workspaces** | `WS`, `currentWS`, `switchWS()` |
| **Proposals (diff-and-confirm)** | `proposal` object + the proposal card in `renderRail()` |
| **Restraint policy (rungs, internal)** | the ordered branches in `agent()`; never labeled in UI |
| **On-demand "why?"** | `toast(text, why)`; the `.why` toggle |
| **Timeline = transcript** | `history[]`, `checkpoint()`, `restore()`, `renderSpine()` |
| **Input: command palette** | `openPalette()`, `filter()`, `SUGS`, `scopedSugs()`, ⌘K handler |
| **Input: selection-anchored ask** | brush in `embeddingBody()` → `openSelpop()` → sets `scope`, opens palette pre-scoped |
| **Input: context menu** | `openCtx()` on panel right-click |
| **User authority (lock)** | `locked` + the downgrade branch inside `agent()` |
| **Refusal of invalid components** | (in the *vocabulary* demo) `validate()`; production file assumes valid specs |

### 4.1 The data-handle / binding model
Components bind by **handle** (e.g. `embedding:main`, `de:macrophage`,
`expr:IL6@Macrophage`, `gene:IL6`), resolved against a catalog. Specs stay small and
auditable; the same product feeds several views; the validator can confirm a view is
even *possible* before rendering. (In the production file this is simplified to
direct data refs; restore explicit handles when wiring real data.)

### 4.2 The event back-channel (two-way)
Direct manipulation emits **typed events** referencing shared handles, e.g.
`selection.created {n, composition, handle}`, `colorBy.changed`, `deGene.selected`,
`validation.rejected`. Reserved: `gate.applied`, `cluster.merged`, `cell.flagged`,
`resolution.changed`, `annotation.edited`. The agent consumes these to stay in sync
with what the human is looking at — the human steers, the agent re-plans.

---

## 5. Open questions / next steps (ranked)

1. **Handle-level provenance (highest value).** Attach provenance + caveats to the
   *data handle*, so any view binding it **inherits** them automatically — the agent
   then *cannot* display a result without surfacing how it was made and what it
   doesn't establish. This is the join between the coordination/presentation layer
   and the cacoa methodological layer, and the thing that makes the whole system
   trustworthy rather than merely tidy. Build this next.
2. **The real rung-selection policy.** Replace the keyword matcher with an actual
   planner that classifies intent → lowest sufficient rung, respects locks, and can
   explain itself. Decide how much is *code-enforced* (e.g. cacoa refusing a 1-vs-1
   DE) vs. *prompt-persuaded*. Strongest version does both.
3. **FLIP / shared-element transitions** so object permanence survives the rare
   layout change.
4. **Vocabulary growth discipline.** Every new component is new validated surface. A
   request that doesn't fit should bias toward "compose existing components" or "add
   one well-specified component," **never** "drop to raw HTML."
5. **Palette discoverability** (what can I even say?). Lean on contextual/anchored
   asks and good suggested actions; treat as ongoing.
6. **Who owns thresholds** (e.g. volcano lfc/padj): agent-set, human-set via control,
   or fixed by provenance? Probably all three, with provenance recording which.
7. **Configurability of the conversational surface.** Resist a permanent chat sidebar
   as default; allow it for users who want it.
8. **Conos/atlas extensions:** incremental/online ops, stable cell/cluster IDs across
   versions, reference-mapping with conflict detection — for the living-atlas pattern.

---

## 6. Design principles, distilled (the keep-list)

- Stability is the default; change is the exception. Protect the user's spatial
  memory — it's the expensive thing.
- Drive the **coordination space**, not the view inventory. Layout and state are two
  clocks.
- Manipulation is the primary verb; language is summonable and **anchored to a
  referent**.
- Route agent output to the right *surface*; don't narrate state in a chat scroll.
- The agent **proposes**, the human **disposes**. Big moves are diffs to confirm;
  manual edits and locks win.
- Generation is disposable until **pinned**. The user curates the durable workbench.
- Every state is a **named checkpoint**; the timeline is the transcript.
- The generation surface is **finite and validated**; unknown components are refused
  *visibly*, never executed.
- Provenance and caveats should **travel with the data**, so any view inherits them.
- Restraint is **felt, not displayed**; legibility is on-demand ("why?"), not a
  permanent readout.
