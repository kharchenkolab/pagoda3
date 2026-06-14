// Compute the per-cell RGBA + legend for the active colorBy handle, off the view.
import type { LstarView, Metadata } from "../data/view.ts";
import { codesToRGBA } from "../data/view.ts";
import { PALETTES, normalizePalette, Palette } from "./palettes.ts";

export interface Legend { kind: "categorical" | "numeric"; items: { label: string; rgb: [number, number, number] }[]; title: string; }

const DIM_RGB = [62, 68, 80], DIM_A = 150;   // non-focus cells under a focus (matches view.ts scalarToRGBA)
// Per-cell RGBA for a NUMERIC field through a chosen palette. Replaces the old fixed-ramp scalarToRGBA so the
// colormap is a drivable property, not baked into paint.
function numericRGBA(values: ArrayLike<number>, max: number, pal: Palette, focusMask?: Uint8Array): Uint8Array {
  const n = values.length, out = new Uint8Array(n * 4), m = max || 1;
  for (let i = 0; i < n; i++) {
    if (focusMask && !focusMask[i]) { out[i * 4] = DIM_RGB[0]; out[i * 4 + 1] = DIM_RGB[1]; out[i * 4 + 2] = DIM_RGB[2]; out[i * 4 + 3] = DIM_A; continue; }
    const [r, g, b] = pal(Math.max(0, Math.min(1, values[i] / m)));
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 230;
  }
  return out;
}

const mdCache = new Map<string, Metadata>();
async function md(view: LstarView, field: string) {
  if (!mdCache.has(field)) mdCache.set(field, await view.metadata(field));
  return mdCache.get(field)!;
}

export async function focusMaskFor(view: LstarView, focus: { dim: string; value: string } | null, n: number): Promise<Uint8Array | undefined> {
  if (!focus) return undefined;
  const m = await md(view, focus.dim);
  if (m.kind !== "categorical") return undefined;
  const code = m.categories.indexOf(focus.value);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = m.codes[i] === code ? 1 : 0;
  return mask;
}

import { catColor } from "../data/view.ts";

// Custom per-cell vectors produced by the code escape hatch (compute_code → kind:"values"). Stored here so a
// `code:<label>` handle resolves like any other numeric colouring, with no special-casing in the paint path.
const codeStore = new Map<string, { values: Float32Array; max: number }>();
export function setCodeValues(label: string, values: Float32Array): void {
  let mx = 0; for (let i = 0; i < values.length; i++) if (values[i] > mx) mx = values[i];
  codeStore.set(label, { values, max: mx || 1 });
}

export async function colorsFor(view: LstarView, colorBy: string, focusMask?: Uint8Array, colormap?: string): Promise<{ rgba: Uint8Array; legend: Legend }> {
  const pal = PALETTES[normalizePalette(colormap || "") || "amber"];   // chosen palette for numeric colourings; default = amber
  const [kind, rest] = colorBy.split(/:(.+)/);
  if (kind === "meta") {
    const m = await md(view, rest);
    if (m.kind === "categorical") {
      return {
        rgba: codesToRGBA(m.codes, focusMask),
        legend: { kind: "categorical", title: rest, items: m.categories.map((c, i) => ({ label: c, rgb: catColor(i) })) },
      };
    }
    return { rgba: numericRGBA(m.values, m.max, pal, focusMask), legend: numericLegend(rest, pal) };
  }
  if (kind === "qc") {
    const m = await md(view, rest);
    const vals = m.kind === "numeric" ? m.values : new Float32Array(view.nCells);
    const mx = m.kind === "numeric" ? m.max : 1;
    return { rgba: numericRGBA(vals, mx, pal, focusMask), legend: numericLegend(rest, pal) };
  }
  if (kind === "gene") {
    const { values, max } = await view.geneExpression(rest);
    return { rgba: numericRGBA(values, max, pal, focusMask), legend: numericLegend(rest, pal) };
  }
  if (kind === "code") {
    const e = codeStore.get(rest);
    const vals = e ? e.values : new Float32Array(view.nCells);
    return { rgba: numericRGBA(vals, e ? e.max : 1, pal, focusMask), legend: numericLegend(rest, pal) };
  }
  if (kind === "geneset") {
    const m = await md(view, "aspect_scores"); // dense (cells, aspects)
    // resolve aspect index by name
    const names = await view.ds.axisLabels("aspects");
    const ai = names.indexOf(rest);
    const n = view.nCells, vals = new Float32Array(n);
    if (m.kind === "numeric" && ai >= 0) {
      const A = names.length;
      let mx = 0;
      for (let i = 0; i < n; i++) { const v = m.values[i * A + ai]; vals[i] = v; if (v > mx) mx = v; }
      return { rgba: numericRGBA(vals, mx, pal, focusMask), legend: numericLegend(rest, pal) };
    }
  }
  return { rgba: new Uint8Array(view.nCells * 4).fill(150), legend: { kind: "numeric", title: colorBy, items: [] } };
}

function numericLegend(title: string, pal: Palette): Legend {
  return { kind: "numeric", title, items: [{ label: "low", rgb: pal(0) }, { label: "high", rgb: pal(1) }] };
}
