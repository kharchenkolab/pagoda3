// Compute the per-cell RGBA + legend for the active colorBy handle, off the view.
import type { LstarView, Metadata } from "../data/view.ts";
import { scalarToRGBA, codesToRGBA } from "../data/view.ts";

export interface Legend { kind: "categorical" | "numeric"; items: { label: string; rgb: [number, number, number] }[]; title: string; }

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

export async function colorsFor(view: LstarView, colorBy: string, focusMask?: Uint8Array): Promise<{ rgba: Uint8Array; legend: Legend }> {
  const [kind, rest] = colorBy.split(/:(.+)/);
  if (kind === "meta") {
    const m = await md(view, rest);
    if (m.kind === "categorical") {
      return {
        rgba: codesToRGBA(m.codes, focusMask),
        legend: { kind: "categorical", title: rest, items: m.categories.map((c, i) => ({ label: c, rgb: catColor(i) })) },
      };
    }
    return { rgba: scalarToRGBA(m.values, m.max, focusMask), legend: numericLegend(rest) };
  }
  if (kind === "qc") {
    const m = await md(view, rest);
    const vals = m.kind === "numeric" ? m.values : new Float32Array(view.nCells);
    const mx = m.kind === "numeric" ? m.max : 1;
    return { rgba: scalarToRGBA(vals, mx, focusMask), legend: numericLegend(rest) };
  }
  if (kind === "gene") {
    const { values, max } = await view.geneExpression(rest);
    return { rgba: scalarToRGBA(values, max, focusMask), legend: numericLegend(rest) };
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
      return { rgba: scalarToRGBA(vals, mx, focusMask), legend: numericLegend(rest) };
    }
  }
  return { rgba: new Uint8Array(view.nCells * 4).fill(150), legend: { kind: "numeric", title: colorBy, items: [] } };
}

function numericLegend(title: string): Legend {
  return { kind: "numeric", title, items: [{ label: "low", rgb: [27, 34, 48] }, { label: "high", rgb: [224, 164, 88] }] };
}
