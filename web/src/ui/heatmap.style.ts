// The Heatmap/dotplot panel's STYLE DESCRIPTOR — owned by the panel, self-registers with the core (no central schema).
// Pure (no DOM) so node --test covers it; heatmapBody (panels.ts) reads the resolved style. Defaults === the former
// inline literals → byte-identical at rest.
import { registerStyle, type StyleDescriptor } from "../render/style.ts";

export interface HeatmapStyle {
  dot: { sizeScale: number; minRadius: number };
  cell: { colMin: number; colMax: number; rowMin: number; rowMax: number };
  font: { floor: number; max: number };
  ramp: { lo: number[]; hi: number[] };   // fill ramp endpoints (theme-aware); dotplot colour = mean expression
  highlight: { selOpacity: number; hovOpacity: number };
}

export function defaultHeatmapStyle(dark: boolean): HeatmapStyle {
  return {
    dot: { sizeScale: 1, minRadius: 0.5 },
    cell: { colMin: 6, colMax: 40, rowMin: 7, rowMax: 26 },
    font: { floor: 5, max: 9 },
    ramp: { lo: dark ? [27, 34, 48] : [244, 240, 228], hi: dark ? [224, 164, 88] : [186, 96, 22] },
    highlight: { selOpacity: 0.22, hovOpacity: 0.1 },
  };
}

export const HEATMAP_RANGES: Record<string, [number, number]> = {
  "dot.sizeScale": [0.2, 3], "dot.minRadius": [0, 4],
  "cell.colMin": [2, 30], "cell.colMax": [10, 120], "cell.rowMin": [3, 30], "cell.rowMax": [8, 80],
  "font.floor": [3, 12], "font.max": [6, 24],
  "highlight.selOpacity": [0, 1], "highlight.hovOpacity": [0, 1],
};

export const HEATMAP_STYLE: StyleDescriptor = { defaults: defaultHeatmapStyle, ranges: HEATMAP_RANGES };
registerStyle("Heatmap", HEATMAP_STYLE);
