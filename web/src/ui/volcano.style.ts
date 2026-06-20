// The Volcano panel's STYLE DESCRIPTOR (self-registers). Pure → node-testable; volcanoBody reads it. The hit
// thresholds (lfc, p) are the most useful knobs — they change which genes are highlighted/labelled.
import { registerStyle, type StyleDescriptor } from "../render/style.ts";

export interface VolcanoStyle {
  thresh: { lfc: number; p: number };   // |log2FC| ≥ lfc AND padj ≤ p ⇒ a "hit" (coloured + labelled)
  dot: { radius: number };
  label: { lfc: number };               // |log2FC| above which a hit gets a gene label
  axis: { xMax: number; yMax: number };
}

export function defaultVolcanoStyle(_dark: boolean): VolcanoStyle {
  return { thresh: { lfc: 1, p: 0.05 }, dot: { radius: 3.4 }, label: { lfc: 1.4 }, axis: { xMax: 3, yMax: 5 } };
}

export const VOLCANO_RANGES: Record<string, [number, number]> = {
  "thresh.lfc": [0, 5], "thresh.p": [0, 1], "dot.radius": [1, 10], "label.lfc": [0, 6], "axis.xMax": [1, 10], "axis.yMax": [1, 50],
};

export const VOLCANO_STYLE: StyleDescriptor = { defaults: defaultVolcanoStyle, ranges: VOLCANO_RANGES };
registerStyle("Volcano", VOLCANO_STYLE);
