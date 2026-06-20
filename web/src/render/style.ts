// The per-panel STYLE spec — the "view escape hatch" (the compute_code analogue for RENDERING). Every visual constant
// a built-in renderer used to hardcode is a key here with a DEFAULT; the renderer reads the RESOLVED style, and the
// agent/user patch it via update_view({style, panel?}). DEFAULT_STYLE is the single home for the literals, so paint
// stops baking in view decisions (the [[generative-control-principle]] made real). Pure + theme passed as a param, so
// node --test covers the merge/clamp without a browser. P0 implements the Embedding family; other panels follow the
// same recipe (a default table + a resolver read in the renderer).

export type RGBA = [number, number, number, number];

export interface EmbeddingStyle {
  point: { radius: number; minPixels: number; opacity: number };
  selection: { ringThreshold: number; ringGrow: number; ringWidth: number; ringOpacity: number; fillGrow: number; fillOpacity: number };
  hint: { grow: number; opacity: number };
  crosshair: { width: number; opacity: number };
  label: { show: boolean; fontSize: number; minPixels: number; maxPixels: number; weight: number; fontFamily: string; textColor: RGBA; bgColor: RGBA; padding: [number, number]; atlasFontSize: number; collisionScale: number; collisionMaxPixels: number };
  legend: { show: boolean | null };
  color: { winsor: number };
  fit: { pad: number };
}

// The ONE place the embedding's literals live now (theme-aware). Defaults === the former inline constants, so an
// un-patched render is byte-identical — the safety rail for moving the constants out of paint.
export function defaultEmbeddingStyle(dark: boolean): EmbeddingStyle {
  return {
    point: { radius: 2.4, minPixels: 1, opacity: 0.7 },
    selection: { ringThreshold: 250, ringGrow: 2.2, ringWidth: 1.6, ringOpacity: 255, fillGrow: 1.4, fillOpacity: 165 },
    hint: { grow: 1.6, opacity: 200 },
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

// Validation + reflection schema: dotted-key → [min,max] for the numeric leaves. Used to CLAMP a patch (so the open
// escape hatch is open but not unsafe) and to DESCRIBE the surface (P1) so the agent's view of it can't drift.
export const EMBEDDING_RANGES: Record<string, [number, number]> = {
  "point.radius": [0.3, 20], "point.minPixels": [0, 10], "point.opacity": [0.02, 1],
  "selection.ringThreshold": [0, 1e9], "selection.ringGrow": [0, 24], "selection.ringWidth": [0.2, 8], "selection.ringOpacity": [0, 255],
  "selection.fillGrow": [0, 24], "selection.fillOpacity": [0, 255], "hint.grow": [0, 24], "hint.opacity": [0, 255],
  "crosshair.width": [0.2, 8], "crosshair.opacity": [0, 255],
  "label.fontSize": [5, 48], "label.minPixels": [2, 48], "label.maxPixels": [4, 96], "label.weight": [100, 900],
  "label.atlasFontSize": [16, 256], "label.collisionScale": [0.5, 10], "label.collisionMaxPixels": [8, 256],
  "color.winsor": [0, 0.2], "fit.pad": [0.3, 1],
};

// Recursive object merge — patch overrides base; arrays + primitives REPLACE (so a colour array or padding pair is set
// wholesale, not element-merged). The generalization of the existing `{ ...c.display, ...view.display }` line.
export function deepMerge<T>(base: T, patch: any): T {
  if (patch == null || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out: any = Array.isArray(base) ? (base as any).slice() : { ...(base as any) };
  for (const k of Object.keys(patch)) {
    const pv = patch[k], bv = out[k];
    if (pv === undefined) continue;   // a partial layer (e.g. a display alias) omits keys — undefined must not clobber the default
    out[k] = pv && typeof pv === "object" && !Array.isArray(pv) && bv && typeof bv === "object" && !Array.isArray(bv) ? deepMerge(bv, pv) : pv;
  }
  return out;
}

// Resolve the effective embedding style: defaults (theme) ← each override layer in order (global display alias, global
// style, panel display alias, panel style). Cheap — once per paint, no per-cell cost.
export function resolveEmbeddingStyle(dark: boolean, ...layers: (Partial<EmbeddingStyle> | null | undefined)[]): EmbeddingStyle {
  let s: any = defaultEmbeddingStyle(dark);
  for (const L of layers) if (L) s = deepMerge(s, L);
  return s;
}

// Clamp a style PATCH against the schema (numbers to range); pass strings/bools/arrays through; NOTE unknown numeric
// keys (kept, so future keys work, but the agent learns it wasn't validated). Returns the cleaned patch + notes.
export function clampStyle(panelType: string, patch: any): { clean: any; notes: string[] } {
  const ranges = panelType === "Embedding" ? EMBEDDING_RANGES : {};
  const notes: string[] = [];
  const walk = (p: any, prefix: string): any => {
    if (p == null || typeof p !== "object" || Array.isArray(p)) return p;
    const out: any = {};
    for (const k of Object.keys(p)) {
      const path = prefix ? prefix + "." + k : k, v = p[k];
      if (v && typeof v === "object" && !Array.isArray(v)) out[k] = walk(v, path);
      else if (typeof v === "number" && ranges[path]) { const [lo, hi] = ranges[path]; out[k] = Math.max(lo, Math.min(hi, v)); }
      else { out[k] = v; if (typeof v === "number" && !ranges[path]) notes.push(`style key "${path}" is not a known numeric knob (kept, unvalidated)`); }
    }
    return out;
  };
  return { clean: walk(patch, ""), notes };
}

// Reflection: the describable schema for a panel type (defaults + ranges) — drives a `describe_style` surface (P1) so
// the agent knows what it can set without a static list that rots out of sync with paint.
export function styleSchema(panelType: string, dark = true): { defaults: any; ranges: Record<string, [number, number]> } | null {
  if (panelType === "Embedding") return { defaults: defaultEmbeddingStyle(dark), ranges: EMBEDDING_RANGES };
  return null;
}

// FLATTEN the schema into a describe list (one row per dotted leaf): the styleable key, its current effective value
// (from the panel's RESOLVED style), its default, and the numeric range. This is what `describe_panel` returns — the
// agent reads it like an MCP tool's schema, then sets keys via update_view({style}). One source of truth: the rows
// come from the same DEFAULT_STYLE the renderer reads, so the describable surface can't drift from what paint honours.
export function describeStyle(panelType: string, dark: boolean, resolved?: any): { key: string; current: any; default: any; range?: [number, number] }[] {
  const sc = styleSchema(panelType, dark); if (!sc) return [];
  const out: { key: string; current: any; default: any; range?: [number, number] }[] = [];
  const walk = (def: any, cur: any, prefix: string) => {
    for (const k of Object.keys(def)) {
      const path = prefix ? prefix + "." + k : k, dv = def[k], cv = cur ? cur[k] : undefined;
      if (dv && typeof dv === "object" && !Array.isArray(dv)) walk(dv, cv, path);
      else out.push({ key: path, current: cv !== undefined ? cv : dv, default: dv, range: sc.ranges[path] });
    }
  };
  walk(sc.defaults, resolved, "");
  return out;
}
