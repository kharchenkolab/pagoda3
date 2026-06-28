// The EMBEDDING panel's STYLE DESCRIPTOR — owned by the panel, NOT a central schema. A panel module declares its own
// styleable surface (defaults + ranges + how the legacy `display` knobs map in) and REGISTERS it; the core style.ts is
// generic and never names a panel type. This is what makes panels independent/installable: adding a panel = ship its
// renderer + a *.style.ts like this (self-registers on import), with zero edits to the core. Pure (no deck.gl) so it's
// node-testable; the renderer (embedding.ts) imports its types/defaults from here.
import { registerStyle, type StyleDescriptor } from "./style.ts";

export type RGBA = [number, number, number, number];

export interface EmbeddingStyle {
  point: { radius: number; minPixels: number; opacity: number };
  selection: { ringThreshold: number; ringGrow: number; ringWidth: number; ringOpacity: number; fillGrow: number; fillOpacity: number };
  hint: { grow: number; opacity: number; ring: number; dim: number; maxMarks: number; ringThreshold: number; mode: "adaptive" | "ring" | "lift" | "fill" };
  crosshair: { width: number; opacity: number };
  label: { show: boolean; fontSize: number; minPixels: number; maxPixels: number; weight: number; fontFamily: string; textColor: RGBA; bgColor: RGBA; padding: [number, number]; atlasFontSize: number; collisionScale: number; collisionMaxPixels: number };
  legend: { show: boolean | null };
  color: { winsor: number };
  fit: { pad: number };
}

// The ONE home for the embedding's literals (theme-aware). Defaults === the former inline constants → an un-patched
// render is byte-identical (the safety rail for moving the constants out of paint).
export function defaultEmbeddingStyle(dark: boolean): EmbeddingStyle {
  return {
    point: { radius: 2.4, minPixels: 1, opacity: 0.7 },
    selection: { ringThreshold: 250, ringGrow: 2.2, ringWidth: 1.6, ringOpacity: 255, fillGrow: 1.4, fillOpacity: 165 },
    hint: { grow: 0.7, opacity: 215, ring: 1.4, dim: 0.45, maxMarks: 600, ringThreshold: 400, mode: "lift" },
    crosshair: { width: 1, opacity: 150 },
    label: {
      show: true, fontSize: 12.5, minPixels: 10, maxPixels: 15, weight: 700, fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      textColor: dark ? [240, 244, 250, 255] : [38, 50, 58, 255], bgColor: dark ? [13, 17, 23, 75] : [255, 255, 255, 82],
      padding: [5, 2], atlasFontSize: 84, collisionScale: 3, collisionMaxPixels: 64,
    },
    legend: { show: null },
    color: { winsor: 0.01 },
    fit: { pad: 0.86 },
  };
}

// Numeric ranges (dotted key → [min,max]) for clamping + describe.
export const EMBEDDING_RANGES: Record<string, [number, number]> = {
  "point.radius": [0.3, 20], "point.minPixels": [0, 10], "point.opacity": [0.02, 1],
  "selection.ringThreshold": [0, 1e9], "selection.ringGrow": [0, 24], "selection.ringWidth": [0.2, 8], "selection.ringOpacity": [0, 255],
  "selection.fillGrow": [0, 24], "selection.fillOpacity": [0, 255], "hint.grow": [0, 24], "hint.opacity": [0, 255], "hint.ring": [0, 6], "hint.dim": [0.05, 1], "hint.maxMarks": [0, 1e9], "hint.ringThreshold": [0, 1e9],
  "crosshair.width": [0.2, 8], "crosshair.opacity": [0, 255],
  "label.fontSize": [5, 48], "label.minPixels": [2, 48], "label.maxPixels": [4, 96], "label.weight": [100, 900],
  "label.atlasFontSize": [16, 256], "label.collisionScale": [0.5, 10], "label.collisionMaxPixels": [8, 256],
  "color.winsor": [0, 0.2], "fit.pad": [0.3, 1],
};

// The descriptor the panel registers with the core. `fromDisplay` keeps the legacy `display` knobs working by mapping
// them into this panel's own style vocabulary (each panel maps its own — there's no central knowledge of "display").
export const EMBEDDING_STYLE: StyleDescriptor = {
  defaults: defaultEmbeddingStyle,
  ranges: EMBEDDING_RANGES,
  fromDisplay: (d: any) => {
    const o: any = {};
    if (d?.alpha != null) o.point = { opacity: d.alpha };
    if (d?.labels != null) o.label = { show: d.labels };
    if (d && d.legend !== undefined) o.legend = { show: d.legend };
    if (d?.winsor != null) o.color = { winsor: d.winsor };
    return o;
  },
};

registerStyle("Embedding", EMBEDDING_STYLE);   // self-register on import (the plug point — no core edit needed)
