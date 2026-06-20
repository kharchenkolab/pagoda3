// The BoxBySample panel's STYLE DESCRIPTOR (self-registers). Pure → node-testable; boxBody reads it.
import { registerStyle, type StyleDescriptor } from "../render/style.ts";

export interface BoxStyle {
  dot: { radius: number; opacity: number; maxPer: number };   // per-sample jittered points: size, opacity, decimation cap
  mean: { width: number };                                     // the mean line thickness
}

export function defaultBoxStyle(_dark: boolean): BoxStyle {
  return { dot: { radius: 2, opacity: 0.4, maxPer: 60 }, mean: { width: 2.4 } };
}

export const BOX_RANGES: Record<string, [number, number]> = {
  "dot.radius": [0.5, 8], "dot.opacity": [0.02, 1], "dot.maxPer": [10, 500], "mean.width": [0.5, 8],
};

export const BOX_STYLE: StyleDescriptor = { defaults: defaultBoxStyle, ranges: BOX_RANGES };
registerStyle("BoxBySample", BOX_STYLE);
