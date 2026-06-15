// Theme-dependent colours that live OUTSIDE CSS — i.e. the embedding's per-cell RGBA, which deck.gl paints on a
// (CSS-transparent) canvas. The DOM re-themes via CSS variables; this is the one piece that JS must set.
// DIM_RGB/DIM_A = the colour of NON-focus cells (greyed under a focus): dark grey on the dark theme, light warm
// grey on the light theme, so the de-emphasised cells read as background in either. Live ESM bindings — callers
// import the names (not destructure-and-cache), so flipping the theme updates everyone on the next repaint.
export let DIM_RGB: [number, number, number] = [62, 68, 80];
export let DIM_A = 150;
let isDark = true;
export function setThemeColors(dark: boolean): void {
  isDark = dark;
  DIM_RGB = dark ? [62, 68, 80] : [201, 194, 174];
  DIM_A = dark ? 150 : 200;
}
// Default sequential palette for NUMERIC colourings (gene/qc/score) when none is chosen: the dark ramp fades
// low values into the dark canvas; on the light theme that inverts (low would be darkest), so default to a
// light ramp where low ≈ paper-white. Explicitly-chosen colormaps are respected as-is.
export function defaultNumericPalette(): string { return isDark ? "amber" : "amberLight"; }
