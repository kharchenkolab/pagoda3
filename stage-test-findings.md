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
