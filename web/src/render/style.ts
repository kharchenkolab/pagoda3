// The generic STYLE protocol — the "view escape hatch" runtime, with ZERO knowledge of any particular panel. A panel
// module declares its own StyleDescriptor (defaults + ranges + optional display-alias) and REGISTERS it here; the core
// only merges/resolves/clamps/describes against whatever descriptor it's handed. This keeps panels independent +
// installable: there is no central schema to edit when a panel is added — the panel describes ITSELF (strong-C).
// Pure (no browser/DOM, theme passed as a param) so node --test covers the protocol with a mock descriptor.

// What a panel module provides to make itself styleable. `defaults(dark)` = the theme-aware default style (the home for
// the panel's former literals); `ranges` = dotted-key numeric bounds (clamp + describe); `fromDisplay` (optional) maps
// the legacy display knobs (labels/legend/alpha/winsor) into THIS panel's style vocabulary (back-compat alias).
export interface StyleDescriptor {
  defaults(dark: boolean): any;
  ranges: Record<string, [number, number]>;
  fromDisplay?(display: any): any;
}

// The registry panels plug INTO (not a central schema — the schema lives in each panel's descriptor). A panel's
// *.style.ts calls registerStyle on import; the core looks it up by type. Unknown type → null (describe/clamp degrade).
const REGISTRY = new Map<string, StyleDescriptor>();
export function registerStyle(panelType: string, d: StyleDescriptor): void { REGISTRY.set(panelType, d); }
export function getStyle(panelType: string): StyleDescriptor | null { return REGISTRY.get(panelType) || null; }
export function styledTypes(): string[] { return [...REGISTRY.keys()]; }

// Recursive object merge — patch overrides base; arrays + primitives REPLACE; undefined in a patch is skipped (so a
// partial layer, e.g. a display alias, can't clobber a default). The generalization of `{ ...c.display, ...view.display }`.
export function deepMerge<T>(base: T, patch: any): T {
  if (patch == null || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out: any = Array.isArray(base) ? (base as any).slice() : { ...(base as any) };
  for (const k of Object.keys(patch)) {
    const pv = patch[k], bv = out[k];
    if (pv === undefined) continue;
    out[k] = pv && typeof pv === "object" && !Array.isArray(pv) && bv && typeof bv === "object" && !Array.isArray(bv) ? deepMerge(bv, pv) : pv;
  }
  return out;
}

// Resolve the effective style: the descriptor's defaults (theme) ← each override layer in order. Cheap — once per paint.
export function resolveStyle(d: StyleDescriptor, dark: boolean, ...layers: any[]): any {
  let s: any = d.defaults(dark);
  for (const L of layers) if (L) s = deepMerge(s, L);
  return s;
}

// Clamp a style PATCH against a descriptor's ranges (numbers→range); pass strings/bools/arrays through; NOTE unknown
// numeric keys (kept, so future keys work, but the agent learns it wasn't validated). Null descriptor → pass-through.
export function clampStyle(d: StyleDescriptor | null, patch: any): { clean: any; notes: string[] } {
  const ranges = d?.ranges || {};
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

// FLATTEN a descriptor into a describe list (one row per dotted leaf): the key, its current effective value (from the
// panel's RESOLVED style), its default, and the numeric range. This is what `describe_panel` returns — the agent reads
// it like an MCP tool's schema, then sets keys via update_view({style}). Rows come from the SAME descriptor the
// renderer reads, so the describable surface can't drift from what paint honours. Null descriptor → [].
export function describeStyle(d: StyleDescriptor | null, dark: boolean, resolved?: any): { key: string; current: any; default: any; range?: [number, number] }[] {
  if (!d) return [];
  const defaults = d.defaults(dark), ranges = d.ranges || {};
  const out: { key: string; current: any; default: any; range?: [number, number] }[] = [];
  const walk = (def: any, cur: any, prefix: string) => {
    for (const k of Object.keys(def)) {
      const path = prefix ? prefix + "." + k : k, dv = def[k], cv = cur ? cur[k] : undefined;
      if (dv && typeof dv === "object" && !Array.isArray(dv)) walk(dv, cv, path);
      else out.push({ key: path, current: cv !== undefined ? cv : dv, default: dv, range: ranges[path] });
    }
  };
  walk(defaults, resolved, "");
  return out;
}
