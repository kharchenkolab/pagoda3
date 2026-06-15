# Annotation — implementation plan

Status: design converged with Peter (2026-06-15). This document is the build spec. Companion context:
`stage-test-findings.md` (the proposal that started it) and the memory `stage-test-pending-decisions`.

## 1. The reframe

Annotation is a **reconciliation** problem, not "name a cluster." A dataset arrives with several
candidate labelings (a clustering, maybe a published `cell_type`, predictions from tools, the agent's
own marker reads). The user's job is to reconcile them into one clean, **CAP-grade** annotation
(depositable to the Cell Annotation Platform, celltype.info). So the spine is: many label LAYERS →
compare → resolve → one working annotation, each label carrying a CAP record.

## 2. Decisions (locked unless noted)

- **Reconciliation UI**: a confusion matrix (compare two layers) AND agent-in-chat resolution (advise,
  offer options, explain, merge). Complementary.
- **Ontology**: live OLS (EBI Ontology Lookup Service) network call. Learn from CAP.
- **Persistence**: session/in-app for now. Future: *aggregate layers* — a read-only core zarr (maybe
  remote) + writable annotation layers on top (local/session). The app-side role map and the layer model
  here are built to slot into that.
- **Sources**: in-browser, serverless. Ship two cheap methods — scType-style marker scoring (first) and
  CellTypist (logistic-regression forward pass, later). The agent's marker reasoning is a third, lighter
  source. Heavier tools (Azimuth, scANVI) are pre-baked in the pipeline as layers.
- **Recognizing which obs columns are annotations**: NOT a zarr role (L\* just regularizes AnnData/Seurat,
  which rarely carry it). Classify **app-side**: a cheap pre-filter + agent inference from the category
  *values*, user-overridable, stored in a session `fieldName → role` map.
- **Overlaps** (proposed default, await veto): single label per layer, last-write-wins. Orthogonal axes
  go in separate layers.
- **Rename** (proposed default, await veto): non-destructive — labeling builds the `annotation` layer;
  the base clustering (leiden) is never mutated.

## 3. Data model

```
Role = "annotation" | "partition" | "covariate" | "qc" | "other"

AnnotationLayer {
  name: string                 // "annotation" = the working draft; "scType", "CellTypist", … = sources
  source: "manual" | "agent" | "sctype" | "celltypist" | "imported" | "derived"
  codes: Int32Array            // cell → category index, -1 = unlabeled
  categories: string[]         // label names
  confidence?: Float32Array    // per-cell, when a source provides it (CellTypist prob, scType score)
  records: Map<label, CapRecord>   // per-label CAP metadata (working draft only, initially)
  provenance: { method, model?, when, params? }
}

CapRecord {                    // mirrors celltype.info/docs/cell-annotation-metadata-terms
  label, fullName?, synonyms[]
  ontologyTermId?, ontologyTermExists?, ontologyTerm?, category?   // OLS / Cell Ontology (CL:xxxx)
  markerEvidence[]             // genes from THIS dataset (auto-filled from DE)
  canonicalMarkers[]           // known/literature
  rationale?, rationaleDoi[]
}
```

The layers live **app-side** (a writable overlay), keyed by name. The working draft is the layer named
`annotation` — which `ctx.defaultGrouping()` already prefers, so every panel re-keys to it for free once
it exists.

## 4. Architecture — annotation layers as first-class categoricals

The whole point: an annotation layer must behave **exactly** like a zarr categorical so colour / scope /
facet / dotplot-group / composition / `compute` / `defaultGrouping` all work with zero special-casing.
Two injection points:

- `LstarView.overlays: Map<string, Metadata>`; `view.metadata(name)` returns the overlay if present, else
  the zarr. This makes colouring (`colorsFor` → `view.metadata`) and group-stats (`groupSufficientStats` →
  `view.metadata`, then the on-the-fly `colSumByGroup` path since there are no precomputed `stats_<name>`)
  work for a layer. Markers are derived on the fly too (no `markers_<name>` table). `view.invalidate(name)`
  clears cached stats when the working draft is edited.
- `Ctx` tracks layer names and surfaces them: `groupings()` and `categoricalFields()` include them,
  `cachedCat(name)`/`categoricalValues(name)` resolve them (the layer also goes into `ctx.meta`).
  `setAnnotationLayer(name, codes, categories, meta?)` wires both sides + invalidates; `removeAnnotationLayer`.

This is the high-leverage move — once a layer is a categorical, the existing dotplot faceting, the
composition stacking, cross-panel coordination (viewer-entity-translation), and DE-on-cell-sets all
operate on annotations unchanged.

## 5. Sources (serverless, in-browser)

- **scType-style scoring** (first). Bundle a marker DB (scTypeDB / PanglaoDB subset) as JSON
  `{ tissue → { cellType → { positive[], negative[] } } }`. Score each *cluster* from the group mean
  expression we already compute (`groupStats`): z-score genes across clusters, sum positive-marker
  z's minus negative-marker z's, divide by √(#markers) for the specificity normalization. Assign each
  cluster its top-scoring cell type (with a score + runner-up gap). Produces a `scType` layer (per
  cluster → label, broadcast to cells). Pure, fast, transparent — the agent can read *why*.
- **CellTypist** (later). It's plain logistic regression: ship/fetch a model as `{ genes[], classes[],
  W: Float32Array (genes×classes), b: Float32Array }`; prediction = `softmax(X·W + b)` over the model's
  genes, argmax → label + probability. One matmul (~35k × ~1–2k × ~30–100), run via the libstar WASM
  seam or plain JS (~1s). Produces a per-cell `CellTypist` layer + confidence.
- **Agent**: reads markers/DE and proposes labels directly (a lighter, explainable source) and is the
  reconciler (see §7).

## 6. Recognizing annotation columns (app-side, agent + user)

- **Pre-filter (pure, cheap)** narrows candidates: numeric/continuous → qc/covariate; cardinality ≈
  #samples or ≈ #cells → covariate/id; the rest are mid-cardinality categoricals → candidates.
- **Agent classifies** the candidates by their *values* (it reads "CD4 T, NK, CD14 mono" = annotation vs
  "GSM…/day0/145/alive" = covariate). Extend the dataset brief to list all candidate categoricals with
  cardinality + sample values. The agent records a `fieldName → role` map and surfaces it as a confirmable
  suggestion.
- **User override** is first-class: an "add as source" control + chat ("treat `manual_labels` as an
  annotation", "`phase` is a covariate"). A zarr role hint, if ever present, is only a prior.

## 7. UI

- **Reconciliation panel** (the new panel type). Rows = base-partition clusters; columns = the working
  label (editable, coloured chip) + each source's dominant label (+ confidence). Agreeing rows collapse;
  conflicts float up (amber, "unresolved"). Row actions: accept a source's label, split, merge. Selecting
  a row expands the **CAP record card** (ontology w/ OLS lookup, marker evidence auto-filled from DE,
  canonical markers, rationale, provenance). Header: working-draft name, source chips, "agreement" view
  toggle, export-CAP. (Mockup shown to Peter.)
- **Confusion matrix** (a second view / panel): cluster × source, or source A × source B — cell counts,
  diagonal-ish = agreement. Built on a `groupStatsSplit`-style cross-tab.
- **Embedding agreement view**: colour cells by agree-vs-conflict (a `code:`-style numeric handle), to
  see *where* the labelings fight.
- All coordinate via the existing event bus (select a label → highlight its cells everywhere).

## 8. Agent surface

- `annotate({ label, cells, capFields? })` — set/relabel in the working draft over a cell-set expression
  (reuses the cell-set algebra). Last-write-wins.
- `run_annotation({ method: "sctype" | "celltypist" })` — compute a source layer.
- `set_field_roles({ annotation[], partition[], covariate[], qc[] })` — record the classification.
- Reconciliation itself is conversational: the agent reads the cross-tab + markers and proposes
  resolutions ("12 splits into a CD8 and a CD4 lobe; accept CD8 for the GZMK+ part?"), like the existing
  workspace proposals/checkpoints.

## 9. Persistence

- Now: layers + role map + CAP records in app/session state; export to CAP TSV/JSON.
- Future (note from Peter): aggregate layers — read-only core zarr (maybe remote) + writable
  annotation/role layers persisted locally/per-session. The model above is already a clean "layer over
  the core."

## 10. Build increments (each independently testable; OODA per step)

1. **Layer infrastructure** — `anno/model.ts` (types + pure ops: seedLayer, setLabel last-wins,
   reconcile cross-tab) + view.overlays + ctx wiring + `App.startAnnotation(fromGrouping?)`. Verify a
   seeded `annotation` layer is a first-class categorical (colour/dotplot/scope/defaultGrouping). UNIT:
   model ops. ← start here.
2. **scType source** — `anno/sctype.ts` (pure scoring) + bundled marker DB + `run_annotation('sctype')`.
   UNIT: scoring on synthetic data.
3. **Field-role classification** — `anno/roles.ts` pre-filter (pure) + brief extension + agent tool +
   override. UNIT: pre-filter.
4. **Reconciliation panel** — the table UI over `reconcile()`, row actions (accept/split/merge),
   coordination.
5. **CAP record card** — per-label fields, marker-evidence auto-fill from DE, OLS lookup, export.
6. **Confusion matrix view** + embedding agreement coloring.
7. **CellTypist** in-browser + agent proposal/conflict-flagging.

## Build notes (discovered while implementing)

- **Increment 1 + 2 done** (committed): the layer infra (writable categoricals via view.overlays + ctx)
  and the scType source. scType independently re-derived sensible PBMC types in-browser (CD16 mono→CD16+
  monocyte, B (naive)→Naive B cell, CD8 T→CD8 T cell).
- **Cross-source string matching over-reports conflicts.** reconcile(leiden; [cell_type, scType]) flagged
  26/28 clusters as "conflict" — but almost all are *vocabulary* mismatches ("CD14 mono" vs "CD14+
  monocyte", "CD4 T (naive)" vs "Naive T cell"), not real disagreement. Implication for increments 4–5:
  the **confusion matrix (raw counts of A-label × B-label) is the honest, vocabulary-agnostic primitive** —
  a clean off-diagonal that's *consistent* (CD14 mono always ↔ CD14+ monocyte) reveals the mapping. The
  string-based `status` only means something within one vocabulary or AFTER ontology/agent normalization.
  So: matrix shows the counts; the agent (and OLS/CL term mapping) decides what's truly the same vs a real
  split/merge. Validates the "agent-in-chat resolution" + ontology decisions.

## Status (2026-06-15) — all phases built

Increments 1–5, 3, agent surface, and 7 are done, tested, UI-verified, committed:
- 1 layers · 2 scType · 4a reconcile table · 4b confusion matrix · 5 CAP card + OLS + export ·
  agent surface (run_annotation/annotate/get_reconciliation) · 3 field-roles (+set_field_roles) ·
  7 CellTypist inference engine.
- 45 node --test cases pass. Live agent drove the whole workflow (ran scType, flagged leiden 22 as a
  real doublet with marker reasoning, labeled clusters on request). OLS returns real CL terms.
- **CellTypist — one pending ASSET, not code.** The in-browser LR inference (`anno/celltypist.ts`
  predictLR/lrFinalize + `App.runCellTypist` sparse runner) is built + verified with a synthetic model on
  the real data (T→CD4 T, Monocyte→CD14 mono, B→B memory, NK→NK). To ship a real source, convert a
  CellTypist `.pkl` (`model.classifier.features`, `.classes_`, `.coef_`, `.intercept_`) to the `LRModel`
  JSON {genes, classes, W[genes×classes], b} and load it (fetch/upload). Until then `run_annotation` keeps
  `method` = sctype only; runCellTypist is callable once a model is provided.

## Iteration 2 (2026-06-15) — design feedback + B-series + bug fixes

Peter's 4-point review of the pilot, and how each was resolved:
1. **Record-card colours off-theme** → CAP card re-themed dark (`.pbody input/textarea`), matches agent chat.
2. **Record card too big / wanted narrower** → the standalone AnnoRecord panel was removed; the CAP form was
   extracted into `renderCapRecord` and folded into the Reconcile panel as a slim bottom detail
   (`showRecord(label)`), driven by selecting a cluster. Annotate workspace is now just Embedding + Reconcile.
3. **UX drifted from the proposal** → recentred on the reconcile surface: one panel with `table | matrix |
   labels` segmented views + the folded record, instead of a panel zoo.
4. **"labels don't always map to the same clusters"** → addressed at three levels:
   - *table*: each source's read of a base cluster shows the runner-up in amber when it splits the cluster
     (dominant <70%), so a non-1:1 mapping is visible, not hidden behind the majority (`reconcile` returns
     `alt/altFrac`).
   - *matrix*: the confusion grid is resolution-agnostic — it shows the actual A×B joint counts regardless of
     how either source was clustered.
   - *reconcile-by-intersection (B5)*: clicking a matrix cell selects the A∩B intersection **and** opens the
     "Label as…" popover (routes through `hooks.onSelect`), so you resolve a cross-clustering disagreement by
     labelling the exact intersecting set — not by base cluster. Verified end-to-end (6671-cell working×scType
     off-diagonal → labelled across 3 leiden clusters).

B-series also delivered: B1 rename/merge (non-destructive, merge = rename-to-existing), B2 source-confidence
colouring (`conf:<source>` handle — colour by scType margin / CellTypist prob to find ambiguous cells; the
honest "where is reconciliation hard" signal, since cross-vocab string "agreement" is noise), B3 labels
overview (completeness before export), B4 stable colour-by-name registry.

**Bugs found while stage-testing (fixed + committed):**
- **Stale colour-cache → black categories.** `render/colors.ts` had a module `mdCache` that was never
  invalidated; any annotation edit that *added* a category left a stale `{codes(new), colors(old/short)}`
  pair, so `colorMap[newCode]` was `undefined` → `catColor(undefined)` → NaN → the new label rendered BLACK
  until a full reload. Fix: `invalidateColor(name)` at the `commitLayer` chokepoint; defensive
  `colorMap[code] ?? code` in `codesToRGBA` + the categorical legend so a short map can never render NaN.
- **Phantom empty categories.** Merging a label (and, generally, relabelling a category's *last* cells) left a
  0-cell category lingering in the legend / table / overview. Fix: `compact(layer)` at the `commitLayer`
  chokepoint, so every mutation yields a phantom-free layer.

## Phase C (2026-06-15) — agent-assisted suggestions (the conversational core)

Peter: "the agent should be helping to SUGGEST things — names, categories, explanations — instead of export
CAP (rare). Add agent suggestion controls. Still looks far from the originally designed functionality." This
was the gap: §8 ("reconciliation is conversational; the agent reads markers + cross-tab and proposes") wasn't
realized — only the mechanical scaffolding was. Phase C makes agent suggestion a first-class affordance.

- **propose_label** (tool) — agent writes a proposed CAP record (clean `name` to rename to, fullName, parent
  category, Cell-Ontology CL term, canonicalMarkers, marker-grounded rationale) onto a working label; CapRecord
  gains `suggested:true` → record card badges "✨ suggested" (reviewable/editable). App.proposeLabel + the
  per-label "✨ Suggest" button (which replaced "export CAP" on the card) → App.proposeRecord asks the agent
  with a prompt scoped to the cluster's cells + seeded with its top DE markers.
- **propose_labels** (tool, batch) — ONE call applies records to MANY labels (reliable; a single tool call
  beats hoping the model fans out N calls). App.proposeLabels loops a no-render applyRename + one commit. The
  labels-overview header has "✨ Suggest names" (batch) + "export CAP" (moved here — rare, review-before-deposit).
- **system prompt**: propose_label is the main assist; the agent proactively offers to name/document clusters
  after adopt_source/annotate.
- **FIX found by stage-testing**: the agent loop sent `max_tokens:1500`, which truncated a batch propose_labels
  call over ~28 clusters mid-tool-call → it never executed (the agent looked "done" with nothing applied).
  Raised to 4096 — also unblocks any large response/tool call.

Verified end-to-end (the realistic multi-step scenario): per-label "✨ Suggest" on a cluster → agent renames it
"Non-classical monocyte", fills CL:0000875 + category + canonical markers + rationale. Batch "✨ Suggest names"
on a draft seeded from raw leiden (28 cluster-ids) → one propose_labels call names all 28 into 21 distinct PBMC
types, each with ontology + marker-grounded rationale → export = 21 valid CAP records; colours stable, no
phantom/numeric labels. 45 node --test pass.

## Polish passes (2026-06-15, from "try it out" feedback)

Each item below was a real bug/UX gap Peter hit while using it; fixes committed:
- **Record card UX (D1):** card appeared in ~3.9s (ensureAnnotation awaited scType; renderCapRecord blocked on
  a DE call) → now ~170ms (seed + render immediately, scType in the background, marker evidence fills async with
  a staleness guard). And clicking leiden rows that share a working label looked frozen → the card now shows a
  per-cluster context line ("selected: leiden 4 · 2,295 cells · 'CD14 mono' also covers leiden 1, 19") + flash,
  so every click visibly responds and the N:1 cluster→label relation is explicit.
- **Table interaction (D2):** source columns used to be invisible click-to-accept buttons (silent mutate, cyan
  flash, no card) — inconsistent with the cluster/working columns that selected. Now EVERY cell click selects +
  inspects; accept moved to an explicit "set from source:" button strip in the card.
- **Suggest aftermath (D3):** the agent's rename left a stale `ctx.xlateCache` (cross-grouping translations not
  invalidated on edit) → refToCategories returned the OLD label → the card flew to an unrelated stale label
  with no fields. Fix: setAnnotationLayer clears xlateCache; proposeLabel selects the resulting label (card
  follows in all paths); the reconcile view (table/matrix/labels) persists across the Suggest re-render.
- **Working-annotation column (E1):** header renamed 'working' → 'working annotation' + a subtle tint marks it
  as the canonical output vs the informational source columns.
- **Clickable gene chips (E2):** genes in marker-evidence + canonical-markers are chips → click colours the
  embedding by that gene's expression (hooks.onGeneClick).
- **Render-race guard (E2, found by deep stage test):** clicking a row mid-rebuild could act on stale DOM →
  wrong cluster → an edit/merge on the wrong label. fullRender now freezes workbench input during the off-DOM
  build. (Deep researcher-workflow stage tests — examine→express→merge/split→rename→next, checking UI at each
  step — are now the standard; single-function checks missed all of the above. See memory stage-test.)

## 11. Test approach

Pure cores get `node --test` cases (zero deps, Node strips TS), consistent with viewpatch/cellset/codeapi:
- model: seed copies; setLabel last-wins + adds new categories; unlabeled stays -1; reconcile yields the
  right dominant label + agreement flag per cluster.
- sctype: known markers → correct top cell type; √#markers normalization; negative markers subtract.
- roles: numeric → qc; #samples-cardinality → covariate; cell-type-like values left for the agent.
Integration (overlay → categorical, UI, agent) verified in-browser via the stage-test OODA loop.
