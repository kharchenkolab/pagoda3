// The MetadataFacets panel's STYLE DESCRIPTOR (self-registers). Pure → node-testable; facetsBody reads the resolved
// style. The histogram bin count is the panel's main styleable knob (numeric-covariate granularity).
import { registerStyle, type StyleDescriptor } from "../render/style.ts";

export interface FacetsStyle {
  hist: { bins: number };   // numeric-covariate histogram granularity
}

export function defaultFacetsStyle(_dark: boolean): FacetsStyle {
  return { hist: { bins: 28 } };
}

export const FACETS_RANGES: Record<string, [number, number]> = { "hist.bins": [4, 100] };

export const FACETS_STYLE: StyleDescriptor = { defaults: defaultFacetsStyle, ranges: FACETS_RANGES };
registerStyle("MetadataFacets", FACETS_STYLE);
