# Stage test — self-driven UX/UI scenarios

A repeatable loop to surface layout/UX regressions before the user hits them: **drive the viewer →
observe the real render → auto-flag quality issues → fix the clear ones → report the judgment calls.**
Run by Claude on the running dev server using the preview tools. Triggered on demand by the user.

## How to run
- "run stage test" → full catalog. "stage test <slice>" → one group below (e.g. `layout`).
- Load `?store=/pbmc6.lstar.zarr` on the dev server (restart with preview_start if it dropped).
- Drive two ways:
  - **agent reasoning** — `await app.agent.ask("<natural request>")` (live agent; proxy must be healthy at /api/health). Tests tool choice, placement, honesty.
  - **mechanics** — `app.applyViewPatch(...)`, drag, header toggles. Tests UI independent of the LLM.
- After each step: run the heuristics snippet + take a screenshot. Record any fired heuristic.
- Fix clear issues with the OODA loop (edit → reload → re-check). Flag judgment calls for the user.
- Reset between scenarios with a reload, or `applyViewPatch` removing panels.

## Quality heuristics (computed from the DOM — paste into preview_eval after a step)
```js
(() => { const canvas = document.querySelector('.canvas'), wb = document.querySelector('.workbench'); if (!wb) return { error: 'no workbench' };
  const panels = [...wb.querySelectorAll('.panel')];
  const colN = {}; panels.forEach(p => { const c = p.dataset.col ?? 'full'; colN[c] = (colN[c] || 0) + 1; });
  const counts = Object.entries(colN).filter(([c]) => c !== 'full').map(([, n]) => n);
  const imbalance = counts.length > 1 ? +(Math.max(...counts) / Math.min(...counts)).toFixed(2) : 1;
  const rects = panels.map(p => ({ id: p.dataset.pid, r: p.getBoundingClientRect() }));
  return {
    nPanels: panels.length, perColumn: colN,
    overflow: canvas.scrollHeight > canvas.clientHeight + 4,    // .canvas is the SCROLL container (.workbench grows to fit)
    offscreen: rects.filter(x => x.r.bottom > innerHeight + 8 || x.r.right > innerWidth + 8).map(x => x.id),
    imbalance,                                                  // tallest col / shortest col by panel count (flag > 2.5)
    tiny: rects.filter(x => x.r.width < 240 || x.r.height < 180).map(x => x.id),
    canvasScrollH: canvas.scrollHeight, canvasClientH: canvas.clientHeight,
  };
})()
```
**Flag if:** `overflow` true · `offscreen` non-empty · `imbalance` > 2.5 · `tiny` non-empty · console has errors
(check `preview_console_logs level=error`). Also per-scenario semantic checks listed below.

## Scenario catalog

### layout
- L1 split a dotplot by condition, stack day0 over day7 → faceted, aligned, no overflow.
- L2 **then split the UMAP too** (the known-bad case) → both UMAPs + both dotplots arranged WITHOUT overflow/imbalance; no panel scrolls off.
- L3 build a 2×2 board (2 embeddings + 2 dotplots) → balanced grid, all readable.
- L4 maximize one panel, then restore → spans / returns cleanly.
- L5 add 5–6 panels → no off-screen, columns stay balanced.

### coordination
- C1 select a cluster in the embedding → composition + dotplot columns highlight (translated).
- C2 hover a dotplot cell → other dotplot shows row + column crosshair.
- C3 deselect (click empty) → all highlights clear.

### encoding
- E1 colour embedding by a gene, set colormap red-to-blue → diverging palette + matching legend.
- E2 heat ↔ dot toggle; dot sizes vary with % expressing.
- E3 alpha down → density visible; labels/legend toggles.

### compute
- M1 "DE between naive and memory B" → one direct table, real means, caveat present; rail not flooded.
- M2 markers of a cluster; overdispersion within a cell type (scoped).
- M3 compute_code signature score → embedding recolours; carries "unvalidated" caveat.

### faceting
- F1 two scoped dotplots (day0/day7) → identical rows + columns, dots differ.

### conversation
- V1 ask something ambiguous → clarifying question shows in full + "awaiting reply" cue.
- V2 follow-up ("now do the same for <gene>") → uses prior context (continuity).

### workspace
- W1 edit a workspace → switch away → return → restored exactly.

### honesty
- H1 ask for an unmeasured gene (IL17A) → pinned-as-footnote / honest "not measured"; no hallucinated control.
- H2 ask for an impossible view (3D / sankey) → graceful refusal, no crash.

### stress
- S1 rapid workspace switches / concurrent renders → no duplicated or orphaned panels.

## Report format
Per scenario: `request/action → screenshot → PASS | ✗ <fired heuristic> → fixed (commit ref) | flagged for review`.
End with a summary: N pass, M fixed, K flagged.
