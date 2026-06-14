# Stage-test findings log

Running log of an autonomous stage-test campaign. Each scenario: observe (function + UI quality +
graphics/layout + density/wasted-space) → list issues → fix the clear ones via OODA (commit refs) →
park questionable calls for review.

## For review (questionable — decide later)
- **Markers dotplot default grouping = leiden (28 clusters), embedding colours by cell_type.** The two
  panels in the Markers workspace describe different partitions. Grouping the dotplot by `cell_type`
  would be more coherent with the embedding and far fewer columns, but coarser than cluster-level. Left
  as leiden for now (the agent/user can switch grouping). Decide the default. (shell.ts:52)
- **Dotplot x-axis: rotate vs thin.** Chose −45° rotation (scanpy/Seurat style) so every group label
  stays present — no thinning/hiding, consistent with the density+honesty principles. If you'd rather a
  cleaner look with fewer labels, say so and I'll switch to thinning. (panels.ts draw)
- **compute_code coloring caveat is chat-only.** A `code:` signature coloring looks identical to a
  validated gene coloring; the "unvalidated custom code" caveat is in the agent's chat reply but there's
  no persistent visual badge on the panel/legend. Given the honesty emphasis, a small "custom"/"~" badge
  on code-derived legends might be warranted. Prominence is a design call — left for you.
- **Display state (labels/legend/alpha) is global, not per-workspace.** Toggling labels off in one
  workspace leaves them off after switching. Could be intentional (consistent viewing prefs) or should
  be saved per-workspace like colorBy/panels. Decide. (coord.state.display vs switchWS save)
- **Narrow/mobile responsiveness.** At ~560px the workbench stays 2 columns (panels ~260px, cramped) and
  the top bar overflows ("Answers" clipped). A naive `@media{grid-template-columns:1fr}` broke worse
  (embedding collapsed to 2px — likely deck.gl canvas width feedback), so I reverted it. Desktop is the
  target and works well; proper responsive (1-col stack + collapsible top bar + deck re-fit) needs real
  design. Parked. (app.css .workbench / topbar)

## Fixed

### Scenario 1 — Markers view (embedding + dotplot)
- **Bug A — embedding cell-type labels invisible on workspace switch / mount.** The on-plot label
  TextLayer uses CollisionFilterExtension (screen-space declutter); on mount the canvas isn't sized
  yet, so it culls every label and they stay hidden until the next redraw (a manual repaint fixed it).
  Fix: a rAF-coalesced ResizeObserver on the embedding container re-renders when the canvas settles
  (and on any later resize), so collisions re-evaluate against the real viewport. Verified: fresh
  Markers load now shows all 25 labels with no manual repaint. (embedding.ts)
- **Bug B — dotplot cluster columns were lexically sorted (0,1,10,11,…,2) and labels cramped.** Two
  fixes: (1) numeric reorder of all-numeric categoricals (leiden) applied at every group-order source —
  metadata codes, precomputed group stats, scoped stats — so columns read 0…27 and faceted panels stay
  aligned (view.ts: numericGroupOrder/reblock/reorderNumericCategorical). (2) x-axis labels rotate −45°
  when they don't fit a column, with ellipsis+hover for over-long names — every group stays legible
  without thinning. Verified: labels now 0…27, rotated. (view.ts, panels.ts)
- **Bug C — panel title wrapped to two lines in a narrow half-width header.** Header flex rules: title
  never wraps (flex 0 0 auto), caption ellipsizes first, controls keep size, header clips overflow.
  Verified: "Marker genes" is one 18px line (was 36px). (app.css .ph)

---

### Scenario 2 — Layout (split dotplot + UMAP by condition) — the user's biggest pain
- **Bug D — faceted panels weren't comparable (agent bug).** Splitting the dotplot by condition, the
  agent built two *independent* scoped Heatmaps and gave them DIFFERENT groupings (day0=leiden,
  day7=cell_type) → different rows+columns, uncomparable. Prompt guidance ("scoped heatmaps share
  rows") already existed and still failed. Fix: a **facet primitive** — `update_view.facet({by, panel?,
  values?, layout?})` splits ONE panel into N copies that differ only in scope; the app clones
  group/genes/mode so alignment is guaranteed and the agent can't diverge. Verified via mechanics AND
  the live agent: day0/day7 dotplots now have identical rows+columns. (viewpatch.ts, shell.ts, live.ts)
- **Bug E — panels scrolled off the viewport (the "UMAP almost scrolled off" complaint).** Grid rows
  were `minmax(300px,1fr)`, so any 3rd panel forced >900px and overflowed the ~685px canvas. Fix:
  `minmax(200px,1fr)` — rows share the viewport dashboard-style; up to ~3 rows fit, only 4+ scroll.
  Verified: the full L2 layout (2 embeddings + 2 dotplots) fits with no scroll. (app.css .workbench)
- **Bug F — narrow faceted headers clipped controls + repeated the scope.** Embedding facets (347px)
  clipped the legend/maximize buttons and showed "Embedding — day0" + redundant "· day0". Fixes:
  header title now ellipsizes so CONTROLS stay reachable; the facet value is a protected cyan **scope
  chip** (never shrinks) instead of a truncatable title suffix; embedding scope-caption removed.
  Verified: chip "day0"/"day7" legible, legend+maximize reachable. (app.css .ph/.scopechip, shell.ts)
- **Bug G — grid rows blew past the 1fr track (premature scroll for 4–6 panels).** A panel's tall
  content (heatmap explicit-height SVG) gave it a `min-content` > 200px which, via `min-height:auto`,
  forced its row to natural height and overflowed — so even a 2×2 scrolled. Fix: `min-height:0` on
  `.panel` and `.workbench`; content scrolls inside `.pbody` instead. Verified: 6 panels now fit at
  211px (no scroll), 2×2 comfortable; only 7-8+ panels scroll. (app.css)
- L4 maximize/restore verified (panel → full-width 709px and back to 349px).
- Minor polish: panel titles carry a tooltip (full title on hover) since narrow embedding headers
  truncate the title to keep the color dropdown + toggles reachable.

### Scenario 3 — Coordination (select / hover / deselect) — ALL PASS, no fixes
- C1: selecting leiden cluster 3 highlights across all panels — embedding lifts those cells (in their
  cell_type colour, rest greyed), dotplot column banded, composition stratum + legend highlighted. The
  leiden→cells→embedding translation works even with the embedding coloured by a different field.
- C2: hovering a dotplot cell drives category + gene hints; the OTHER faceted dotplot shows both the
  column band and the gene-row band (full crosshair). Verified receiver overlays = 1 col + 1 row.
- C3: clearing the selection removes all cross-panel highlights.

### Scenario 4 — Encoding (colormap / heat-dot / alpha / legend) — ALL PASS, no fixes
- E1: agent request "colour by CD3E, red-to-blue scale" → colorBy=gene:CD3E, colormap=rdbu, diverging
  palette renders correctly (T cells blue=high, monocytes red=low), legend matches. This was the exact
  thing the agent COULDN'T do before the colormap fix earlier this session — now end-to-end via agent.
- E2: heat↔dot toggle — heat mode = 1176 filled rects, 0 circles; dot mode = circles. Both clean.
- E3: alpha (0.25) applied; labels toggle (25→0); legend toggle (swatch removed). All work.
- NOTE for S7: display state (labels/legend/alpha) is GLOBAL (coord.state.display), not per-workspace —
  toggling labels off in Overview leaves them off after switching to Markers. Check if this should be
  per-workspace.

### Scenario 5 — Compute (DE / overdispersion / compute_code) — ALL PASS, no fixes
- M1: agent DE "naive B vs memory B" → direct two-group table (B (naive) vs B (memory)), distinct real
  means, honest caveat ("donor is the replicate; verify per-sample…"), one rail card (not flooded).
  Biologically correct: TCL1A/IGHM up in naive, CRIP1/VIM/IGHA1 up in memory. The old "same results on
  both sides" / 0.00-columns bug is gone.
- M2: scoped overdispersion in CD14 mono (6671 cells, recomputed for scope) → interferon-stimulated
  genes (IFITM3, IFI27, ISG15…) — meaningful for COVID monocytes.
- M3: agent compute_code cytotoxicity signature (mean of GZMB/PRF1/GNLY/NKG7) → embedding recolours via
  code: handle, lights up NK/CD8; caveat conveyed in the agent reply ("unvalidated-custom-code caveat").

### Scenario 6 — Conversation (clarify / continuity) — ALL PASS, no fixes
- V2 continuity: "colour by CD3E" then "now do the same for MS4A1" → correctly recolours by MS4A1
  (understood "the same" = recolour) using prior context.
- V1 clarify: ambiguous "Compare them." → agent asked a clarifying question (inferred CD3E vs MS4A1 from
  context, proposed side-by-side, asked to confirm), did NOT guess (view unchanged, no tool call).
- Conversation renders as clickable exchange cards in the history strip (screenshot). Awaiting-reply cue
  code-verified (renderDockedConvo: `.awaiting` foot + "↳ the agent asked you something — reply below" +
  focused reply input when the last response ends with "?"); fires only in the docked Ask panel.

### Scenario 7 — Persistence / honesty / stress — ALL PASS, no fixes
- W1: edited Markers (added CompositionBars + embedding colorBy=gene:GNLY), switched to Overview and
  back → restored exactly (panels + colorBy). (Display state is global — parked above.)
- H1: "colour by IL17A" (not in dataset) → "IL17A isn't present in this dataset, so I can't colour by
  it — want a related Th17 gene (IL17F, RORC, CCR6)?" Honest, view unchanged, offers alternatives.
- H2: "3D rotating UMAP + Sankey of cell flow over time" → graceful refusal explaining why (2D-only, no
  Sankey primitive, cells not tracked across day0→day7 so flow is undefined) + offered faceting. No crash.
- S1 stress: 7 rapid workspace switches (120ms apart, faster than render) → no duplicated/orphaned panels,
  DOM matches model exactly. The renderToken reentrancy guard holds.

### Scenario 8 — Long-tail UI / density sweep
- **Bug H — CompositionBars wasted ~40% of its height.** The bars used a fixed `viewBox 460×200` (2.3:1),
  scaling to width but never growing vertically, so the lower ~335px of a full-height panel sat empty.
  Fix: refactored to a responsive `draw()`-on-resize (like the heatmap) — bars fill the host height, with
  a faint 0/50/100% y-axis scale added for the now-taller bars. Coordination (hover ribbons + segment
  click → selection) preserved. Verified: bars fill the panel, no overflow, click still selects.
  (panels.ts compositionBody). [Watch out: needed pb.position=relative to contain the absolute fill — an
  SVG height:100% won't resolve against a flex parent, so draw() sets explicit px width/height/viewBox.]
- **Bug I — a throwing panel body left the previous workspace's DOM stale.** The Aspects workspace's
  Overdispersion panel reads `aspects`/`aspect_adjvar`, which pbmc6 lacks → overdispBody threw →
  `fullRender`'s serial `await panelEl` rejected → the whole render aborted, leaving the prior
  workspace's panel (Composition) on screen while the model said Overdispersion. Three fixes: (1)
  panelEl catches a throwing body and shows an in-panel "⚠ couldn't render" notice so one bad panel
  never aborts the render; (2) overdispBody degrades to a clean "No gene programs (aspects)…" message
  when the data is absent; (3) the Aspects workspace tab is dropped entirely when the store has no
  aspect tables (don't offer a workspace that can't render). Verified: QC triage→Aspects no longer
  leaves stale DOM; tabs now Overview/Markers/QC triage. (shell.ts panelEl + WS init, panels.ts)
