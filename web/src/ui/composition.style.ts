// The CompositionBars panel's STYLE DESCRIPTOR (self-registers). Pure → node-testable; compositionBody reads it.
import { registerStyle, type StyleDescriptor } from "../render/style.ts";

export interface CompositionStyle {
  bar: { maxWidth: number; gap: number };
  ribbon: { selOpacity: number; hovOpacity: number };   // cross-panel link ribbons: committed (select) vs ephemeral (hover)
  axis: { font: number };
}

export function defaultCompositionStyle(_dark: boolean): CompositionStyle {
  return { bar: { maxWidth: 64, gap: 8 }, ribbon: { selOpacity: 0.42, hovOpacity: 0.16 }, axis: { font: 8 } };
}

export const COMPOSITION_RANGES: Record<string, [number, number]> = {
  "bar.maxWidth": [8, 200], "bar.gap": [0, 40], "ribbon.selOpacity": [0, 1], "ribbon.hovOpacity": [0, 1], "axis.font": [5, 18],
};

export const COMPOSITION_STYLE: StyleDescriptor = { defaults: defaultCompositionStyle, ranges: COMPOSITION_RANGES };
registerStyle("CompositionBars", COMPOSITION_STYLE);
