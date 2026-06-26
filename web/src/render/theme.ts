// Theme-dependent colours that live OUTSIDE CSS — i.e. the embedding's per-cell RGBA, which deck.gl paints on a
// (CSS-transparent) canvas. The DOM re-themes via CSS variables; this is the one piece that JS must set.
// DIM_RGB/DIM_A = the colour of NON-focus cells (greyed under a focus): dark grey on the dark theme, light warm
// grey on the light theme, so the de-emphasised cells read as background in either. Live ESM bindings — callers
// import the names (not destructure-and-cache), so flipping the theme updates everyone on the next repaint.
export let DIM_RGB: [number, number, number] = [62, 68, 80];
export let DIM_A = 150;
// SEL_DIM_A = alpha for a SELECTION (level 2) dim, which KEEPS each cell's own colour (just recedes it) rather than
// greying it — so the colour-by still reads in the de-emphasised cells. Lower than DIM_A so the selected cells (full
// alpha) clearly pop against the faint-but-hued rest. (Greying is reserved for SCOPE's evidence-board desaturation.)
export let SEL_DIM_A = 5;
let isDark = true;
export function setThemeColors(dark: boolean): void {
  isDark = dark;
  DIM_RGB = dark ? [62, 68, 80] : [201, 194, 174];
  DIM_A = dark ? 150 : 200;
  SEL_DIM_A = dark ? 5 : 10;
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
