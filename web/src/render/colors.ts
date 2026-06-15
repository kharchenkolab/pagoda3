// Compute the per-cell RGBA + legend for the active colorBy handle, off the view.
import type { LstarView, Metadata } from "../data/view.ts";
import { codesToRGBA } from "../data/view.ts";
import { PALETTES, normalizePalette, Palette } from "./palettes.ts";

export interface Legend { kind: "categorical" | "numeric"; items: { label: string; rgb: [number, number, number] }[]; title: string; unvalidated?: boolean; }

import { DIM_RGB, DIM_A, defaultNumericPalette } from "./theme.ts";   // non-focus cells under a focus — theme-aware (live binding)
// Per-cell RGBA for a NUMERIC field through a chosen palette. Maps the value range [lo,hi] → palette [0,1] (lo/hi
// come from winsorBounds, so a few outlier cells don't compress everyone else into the pale end). Replaces the old
// fixed-ramp scalarToRGBA so the colormap is a drivable property, not baked into paint.
function numericRGBA(values: ArrayLike<number>, lo: number, hi: number, pal: Palette, focusMask?: Uint8Array): Uint8Array {
  const n = values.length, out = new Uint8Array(n * 4), span = (hi - lo) || 1;
  for (let i = 0; i < n; i++) {
    if (focusMask && !focusMask[i]) { out[i * 4] = DIM_RGB[0]; out[i * 4 + 1] = DIM_RGB[1]; out[i * 4 + 2] = DIM_RGB[2]; out[i * 4 + 3] = DIM_A; continue; }
    const [r, g, b] = pal(Math.max(0, Math.min(1, (values[i] - lo) / span)));
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 230;
  }
  return out;
}

// Winsorized value range for a numeric colouring: clip the bottom/top `frac` quantiles so outlier cells don't
// dominate the scale (frac=0.01 → map the 1st…99th percentile). Falls back to [0,max] when frac=0 or the clipped
// range collapses (e.g. a gene expressed in <frac of cells — clipping would erase its signal). Cached by (key,frac):
// the sort is O(n log n) and colorsFor runs every repaint (incl. hover), so we don't re-sort an unchanged field.
const winsorCache = new Map<string, [number, number]>();
function winsorBounds(values: ArrayLike<number>, max: number, frac: number, key: string): [number, number] {
  if (!frac || frac <= 0) return [0, max || 1];
  const ck = key + "::" + frac;
  const hit = winsorCache.get(ck); if (hit) return hit;
  const n = values.length;
  const sorted = Float32Array.from(values as ArrayLike<number>); sorted.sort();
  const q = (f: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))))];
  let lo = q(frac), hi = q(1 - frac);
  if (!(hi > lo)) { lo = 0; hi = max || 1; }   // collapsed clip (very sparse field) → full range, lose nothing
  const r: [number, number] = [lo, hi]; winsorCache.set(ck, r); return r;
}

const mdCache = new Map<string, Metadata>();
async function md(view: LstarView, field: string) {
  if (!mdCache.has(field)) mdCache.set(field, await view.metadata(field));
  return mdCache.get(field)!;
}
// Drop a field's cached metadata (call after a writable overlay changes — annotation edits add categories,
// so the stale snapshot would carry an outdated codes/colors pairing). No arg = clear all.
export function invalidateColor(field?: string) { if (field) mdCache.delete(field); else mdCache.clear(); winsorCache.clear(); }

// Boolean mask (1 = in focus) over n cells, from the focus's resolved cell ids. Sync — the focus already
// carries its ids (a labeled subpopulation), so no metadata lookup is needed.
export function focusMaskFor(focus: { ids: ArrayLike<number> } | null, n: number): Uint8Array | undefined {
  if (!focus || !focus.ids || !focus.ids.length) return undefined;
  const mask = new Uint8Array(n);
  for (let i = 0; i < focus.ids.length; i++) { const c = focus.ids[i]; if (c >= 0 && c < n) mask[c] = 1; }
  return mask;
}

import { catColor } from "../data/view.ts";

// Custom per-cell vectors produced by the code escape hatch (compute_code → kind:"values"). Stored here so a
// `code:<label>` handle resolves like any other numeric colouring, with no special-casing in the paint path.
const codeStore = new Map<string, { values: Float32Array; max: number }>();
export function setCodeValues(label: string, values: Float32Array): void {
  let mx = 0; for (let i = 0; i < values.length; i++) if (values[i] > mx) mx = values[i];
  codeStore.set(label, { values, max: mx || 1 }); winsorCache.clear();   // values changed → drop stale winsor bounds
}
// Per-cell confidence vectors for annotation sources → the `conf:<layer>` handle (uncertain = where to look).
const confStore = new Map<string, { values: Float32Array; max: number }>();
export function setConfValues(label: string, values: Float32Array): void {
  let mx = 0; for (let i = 0; i < values.length; i++) if (values[i] > mx) mx = values[i];
  confStore.set(label, { values, max: mx || 1 }); winsorCache.clear();   // values changed → drop stale winsor bounds
}

export async function colorsFor(view: LstarView, colorBy: string, focusMask?: Uint8Array, colormap?: string, winsor: number = 0): Promise<{ rgba: Uint8Array; legend: Legend }> {
  const pal = PALETTES[normalizePalette(colormap || "") || defaultNumericPalette()];   // chosen palette for numeric colourings; default is theme-aware (amber on dark, amberLight on white)
  // every numeric branch maps through this — winsorBounds clips outliers (keyed by colorBy so the sort is cached)
  const numRGBA = (vals: ArrayLike<number>, max: number) => numericRGBA(vals, ...winsorBounds(vals, max, winsor, colorBy), pal, focusMask);
  const [kind, rest] = colorBy.split(/:(.+)/);
  if (kind === "meta") {
    const m = await md(view, rest);
    if (m.kind === "categorical") {
      return {
        rgba: codesToRGBA(m.codes, focusMask, m.colors),
        legend: { kind: "categorical", title: rest, items: m.categories.map((c, i) => ({ label: c, rgb: catColor(m.colors?.[i] ?? i) })) },
      };
    }
    return { rgba: numRGBA(m.values, m.max), legend: numericLegend(rest, pal) };
  }
  if (kind === "qc") {
    const m = await md(view, rest);
    const vals = m.kind === "numeric" ? m.values : new Float32Array(view.nCells);
    const mx = m.kind === "numeric" ? m.max : 1;
    return { rgba: numRGBA(vals, mx), legend: numericLegend(rest, pal) };
  }
  if (kind === "gene") {
    const { values, max } = await view.geneExpression(rest);
    return { rgba: numRGBA(values, max), legend: numericLegend(rest, pal) };
  }
  if (kind === "code") {
    const e = codeStore.get(rest);
    const vals = e ? e.values : new Float32Array(view.nCells);
    // mark the legend unvalidated → the panel shows a persistent "custom" badge (this colouring came from
    // sandboxed agent code, not a validated metric), so it's never mistaken for a real gene/QC colouring.
    return { rgba: numRGBA(vals, e ? e.max : 1), legend: { ...numericLegend(rest, pal), unvalidated: true } };
  }
  if (kind === "conf") {
    // per-cell CONFIDENCE of an annotation source (scType margin / CellTypist prob). Low = where the call is
    // uncertain — i.e. where reconciliation is hard. Honest spatial signal (vocabulary-free).
    const e = confStore.get(rest); const vals = e ? e.values : new Float32Array(view.nCells);
    return { rgba: numRGBA(vals, e ? e.max : 1), legend: { ...numericLegend(rest + " confidence", pal) } };
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
      return { rgba: numRGBA(vals, mx), legend: numericLegend(rest, pal) };
    }
  }
  return { rgba: new Uint8Array(view.nCells * 4).fill(150), legend: { kind: "numeric", title: colorBy, items: [] } };
}

function numericLegend(title: string, pal: Palette): Legend {
  return { kind: "numeric", title, items: [{ label: "low", rgb: pal(0) }, { label: "high", rgb: pal(1) }] };
}
