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
// SELECTION ghost target (numeric colourings). A sequential colormap's neutral/low end ≈ the canvas, so receding an
// UNSELECTED neutral cell toward the canvas (BG_RECEDE) barely moves it — the dim is invisible in low-signal regions.
// Instead, for numeric colourings recede the unselected cells toward SEL_GHOST: a grey OFFSET from the canvas, so even a
// ~0-expression unselected cell becomes a visible grey ghost and the selected/unselected boundary reads with no signal.
// Still opaque (full alpha) → density-robust. Categorical dim keeps receding toward the canvas (saturated hues recede fine).
export let SEL_GHOST: [number, number, number] = [58, 64, 76];   // dark: soft grey, clearly above --panel
// Write cell (r,g,b) RECEDED toward the background into out[i*4..+3] at full alpha — the SELECTION-dim treatment,
// shared by the numeric and categorical colourers so they recede identically.
export function recedeInto(out: Uint8Array, i: number, r: number, g: number, b: number, target: [number, number, number] = BG_RECEDE): void {
  out[i * 4]     = target[0] + (r - target[0]) * SEL_DIM_KEEP;
  out[i * 4 + 1] = target[1] + (g - target[1]) * SEL_DIM_KEEP;
  out[i * 4 + 2] = target[2] + (b - target[2]) * SEL_DIM_KEEP;
  out[i * 4 + 3] = 255;
}
let isDark = true;
export function setThemeColors(dark: boolean): void {
  isDark = dark;
  DIM_RGB = dark ? [62, 68, 80] : [201, 194, 174];
  DIM_A = dark ? 150 : 200;
  BG_RECEDE = dark ? [22, 27, 34] : [251, 250, 247];   // --panel: #161b22 / #fbfaf7
  SEL_GHOST = dark ? [58, 64, 76] : [210, 207, 199];   // numeric selection-dim ghost: a grey clearly offset from the canvas in either theme
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
