# Stage-test findings log

Running log of an autonomous stage-test campaign. Each scenario: observe (function + UI quality +
graphics/layout + density/wasted-space) → list issues → fix the clear ones via OODA (commit refs) →
park questionable calls for review.

## For review (questionable — decide later)
_(empty)_

## Fixed

### Scenario 1 — Markers view (embedding + dotplot)
- **Bug A — embedding cell-type labels invisible on workspace switch / mount.** The on-plot label
  TextLayer uses CollisionFilterExtension (screen-space declutter); on mount the canvas isn't sized
  yet, so it culls every label and they stay hidden until the next redraw (a manual repaint fixed it).
  Fix: a rAF-coalesced ResizeObserver on the embedding container re-renders when the canvas settles
  (and on any later resize), so collisions re-evaluate against the real viewport. Verified: fresh
  Markers load now shows all 25 labels with no manual repaint. (embedding.ts)

---
