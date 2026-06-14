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
