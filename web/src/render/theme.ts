// Theme-dependent colours that live OUTSIDE CSS — i.e. the embedding's per-cell RGBA, which deck.gl paints on a
// (CSS-transparent) canvas. The DOM re-themes via CSS variables; this is the one piece that JS must set.
// DIM_RGB/DIM_A = the colour of NON-focus cells (greyed under a focus): dark grey on the dark theme, light warm
// grey on the light theme, so the de-emphasised cells read as background in either. Live ESM bindings — callers
// import the names (not destructure-and-cache), so flipping the theme updates everyone on the next repaint.
export let DIM_RGB: [number, number, number] = [62, 68, 80];
export let DIM_A = 150;
// SELECTION (level 2) dim. Lowering ALPHA fails on a dense map: overlapping cells composite back up (1-(1-a)^n), so
// zoomed out the "dimmed" mass re-brightens. Instead we RECEDE BY COLOUR toward the canvas background at FULL alpha —
// near-background opaque points don't accumulate (the topmost just paints ≈background), so it's density-robust at any
// zoom AND any colour mode. BG_RECEDE = the panel surface the deck.gl canvas sits on; SEL_DIM_KEEP = the fraction of a
// cell's OWN colour kept (the rest blended into the background) — small, so a whisper of hue survives but it reads as bg.
export let BG_RECEDE: [number, number, number] = [22, 27, 34];   // ≈ --panel #161b22 (dark)
export const SEL_DIM_KEEP = 0.16;
// SELECTION floor (numeric colourings only). A sequential colormap's neutral/low end ≈ the canvas (low expression fades
// into it), so receding it is a near-identity there — a selected cell at ~0 expression looks like the background and the
// selected/unselected boundary vanishes in low-signal regions. While a selection is active we LIFT the selected cells'
// low end to SEL_FLOOR (a mid-grey clearly offset from the canvas), ramping back to the true palette colour by FLOOR_KNEE.
// So the selected footprint reads even with no signal, WITHOUT changing the no-selection look (low still fades into canvas).
export let SEL_FLOOR: [number, number, number] = [72, 78, 90];   // dark: soft slate grey, well above --panel
export const FLOOR_KNEE = 0.35;   // values at/above this fraction of the range use the pure palette; only the bottom lifts
// Write cell (r,g,b) RECEDED toward the background into out[i*4..+3] at full alpha — the SELECTION-dim treatment for the
// UNSELECTED cells, shared by the numeric and categorical colourers so they recede identically.
export function recedeInto(out: Uint8Array, i: number, r: number, g: number, b: number): void {
  out[i * 4]     = BG_RECEDE[0] + (r - BG_RECEDE[0]) * SEL_DIM_KEEP;
  out[i * 4 + 1] = BG_RECEDE[1] + (g - BG_RECEDE[1]) * SEL_DIM_KEEP;
  out[i * 4 + 2] = BG_RECEDE[2] + (b - BG_RECEDE[2]) * SEL_DIM_KEEP;
  out[i * 4 + 3] = 255;
}
// Write a SELECTED cell's colour with its low end LIFTED to SEL_FLOOR: lerp floor → palette colour over [0, FLOOR_KNEE],
// pure palette above. Keeps the selection footprint legible where expression ≈ 0. t = the cell's normalized value [0,1].
export function floorInto(out: Uint8Array, i: number, r: number, g: number, b: number, t: number): void {
  const k = t >= FLOOR_KNEE ? 1 : t / FLOOR_KNEE;
  out[i * 4]     = SEL_FLOOR[0] + (r - SEL_FLOOR[0]) * k;
  out[i * 4 + 1] = SEL_FLOOR[1] + (g - SEL_FLOOR[1]) * k;
  out[i * 4 + 2] = SEL_FLOOR[2] + (b - SEL_FLOOR[2]) * k;
  out[i * 4 + 3] = 230;
}
let isDark = true;
export function setThemeColors(dark: boolean): void {
  isDark = dark;
  DIM_RGB = dark ? [62, 68, 80] : [201, 194, 174];
  DIM_A = dark ? 150 : 200;
  BG_RECEDE = dark ? [22, 27, 34] : [251, 250, 247];   // --panel: #161b22 / #fbfaf7
  SEL_FLOOR = dark ? [72, 78, 90] : [205, 202, 194];   // selection floor: a mid-grey clearly offset from the canvas in either theme
}
// Default sequential palette for NUMERIC colourings (gene/qc/score) when none is chosen: the dark ramp fades
// low values into the dark canvas; on the light theme that inverts (low would be darkest), so default to a
// light ramp where low ≈ paper-white. Explicitly-chosen colormaps are respected as-is.
export function defaultNumericPalette(): string { return isDark ? "amber" : "amberLight"; }
export function themeIsDark(): boolean { return isDark; }
// Interaction accent (selection ring / category-hint lift / crosshair) painted on the CSS-transparent deck.gl
// canvas, so it must be set by hand. Mirrors the --cyan CSS var: a bright cyan reads over the dark map, but on
// white it washes out — so use a deeper teal-blue that holds contrast over paper.
export function accentRGB(): [number, number, number] { return isDark ? [120, 224, 255] : [31, 127, 175]; }
