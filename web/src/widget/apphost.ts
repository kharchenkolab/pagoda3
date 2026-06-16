// The REAL WidgetHost — bridges an in-app widget iframe to the live coordination space (coord), the data context
// (ctx) and the theme. The dev harness has a mock host with the same shape; this is its production counterpart.
// A widget thus reads + writes exactly the same coordination events every other panel does.
import type { App } from "../ui/shell.ts";
import type { EntityRef } from "../data/coord.ts";
import type { WidgetHost } from "./runtime.ts";
import type { ThemeInfo, CoordInfo, SelectionInfo, HintInfo, WidgetMsg } from "./contract.ts";
import { themeIsDark } from "../render/theme.ts";

// The CSS custom properties a widget may use (injected into the iframe :root so it themes with the app). Mirrors
// the set defined in app.css for both themes — read live so a theme flip re-pushes the new values.
const THEME_VARS = ["--ink", "--panel", "--inset", "--card", "--line", "--line2", "--text", "--dim", "--faint",
  "--teal", "--cyan", "--amber", "--ok", "--good", "--bad", "--on-accent", "--sel", "--sans", "--mono"];

export function readThemeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement); const out: Record<string, string> = {};
  for (const k of THEME_VARS) { const v = cs.getPropertyValue(k).trim(); if (v) out[k] = v; }
  return out;
}

// ---- pure mappers (unit-tested; no DOM/app) ----
// The app's typed EntityRef → the widget-facing selection DESCRIPTOR (count instead of the id array).
export function selToInfo(ref: EntityRef | null, countOf: (r: EntityRef) => number): SelectionInfo {
  if (!ref) return null;
  if (ref.kind === "cells") return { kind: "cells", count: ref.ids.length };
  return { kind: "category", grouping: ref.grouping, value: ref.value, count: countOf(ref) };
}
// The app's typed hint EntityRef → the widget-facing HintInfo. Hints are SMALL (a hovered cell, or a category), so
// they carry content; cells are capped defensively in case a brush-hint ever arrives.
export function hintToInfo(ref: EntityRef | null): HintInfo {
  if (!ref) return null;
  if (ref.kind === "cells") return { kind: "cells", ids: Array.from(ref.ids.length > 256 ? ref.ids.subarray(0, 256) : ref.ids) };
  return { kind: "category", grouping: ref.grouping, value: ref.value };
}
// A widget's setSelection/setHint argument ({cells}|{category}|null) → the app's typed EntityRef.
export function widgetSelToRef(sel: any): EntityRef | null {
  if (!sel) return null;
  if (Array.isArray(sel.cells)) return { kind: "cells", ids: Int32Array.from(sel.cells) };
  if (sel.category && sel.category.grouping) return { kind: "category", grouping: String(sel.category.grouping), value: String(sel.category.value) };
  return null;
}
// metadataFields() rows → the {categorical, numeric} lists a widget's data('fields') returns.
export function fieldsInfo(fields: { name: string; kind: "categorical" | "numeric" }[]): { categorical: string[]; numeric: string[] } {
  return { categorical: fields.filter((f) => f.kind === "categorical").map((f) => f.name), numeric: fields.filter((f) => f.kind === "numeric").map((f) => f.name) };
}

// A READ-ONLY wrapper for preview_widget: data/theme/coord still resolve against the real app (so a preview renders
// with real data + the current selection), but the widget's WRITES (setSelection/setColor/updateView) are swallowed —
// previewing/probing a widget must NOT mutate the user's live session.
export function readonlyHost(h: WidgetHost): WidgetHost {
  return { theme: h.theme, coord: h.coord, hint: h.hint, subscribe: h.subscribe, data: h.data, apply: () => { /* preview is side-effect-free */ } };
}

export function makeWidgetHost(app: App): WidgetHost {
  const ctx = app.ctx, coord = app.coord;
  const countOf = (r: EntityRef) => app.ctx.refToCells(r).length;

  return {
    theme: (): ThemeInfo => ({ dark: themeIsDark(), vars: readThemeVars() }),
    coord: (): CoordInfo => ({
      colorBy: coord.state.colorBy,
      selection: selToInfo(coord.state.selection, countOf),
      focus: coord.state.focus ? { label: coord.state.focus.label } : null,
    }),
    hint: (): HintInfo => hintToInfo(coord.state.hint),
    subscribe: (cb) => {
      // coord (committed) and hint (ephemeral hover) are SEPARATE channels, so hover churn never re-fires coord handlers.
      const u1 = coord.subscribe((_s, changed: string[]) => {
        if (changed.some((k) => k === "colorBy" || k === "selection" || k === "focus")) cb("coord");
        if (changed.some((k) => k === "hint")) cb("hint");
      });
      const u2 = app.onTheme(() => cb("theme"));
      return () => { u1(); u2(); };
    },
    apply: (m: WidgetMsg) => {
      if (m.t === "setColor") void app.applyViewPatch({ color: m.handle });
      else if (m.t === "setSelection") coord.setSelection(widgetSelToRef(m.sel));
      else if (m.t === "setHint") coord.setHint(widgetSelToRef(m.hint));
      else if (m.t === "updateView") void app.applyViewPatch(m.patch || {});
    },
    data: async (kind, args) => {
      const a = args || {};
      switch (kind) {
        case "n": return ctx.n;
        case "fields": return fieldsInfo(ctx.metadataFields());
        case "categories": {
          const m = await ctx.metaOf(String(a.field)) as any;
          if (m.kind !== "categorical") throw new Error(`'${a.field}' is not categorical`);
          const counts = new Array(m.categories.length).fill(0);
          for (let i = 0; i < m.codes.length; i++) { const c = m.codes[i]; if (c >= 0) counts[c]++; }
          return { categories: m.categories, counts };
        }
        case "category": {
          const m = await ctx.metaOf(String(a.field)) as any;
          if (m.kind !== "categorical") throw new Error(`'${a.field}' is not categorical`);
          return { categories: m.categories, codes: Array.from(m.codes as Int32Array) };
        }
        case "cellsOf": {
          await ctx.metaOf(String(a.field));   // warm so cellsOfCategory (reads cached) resolves
          return Array.from(ctx.cellsOfCategory(String(a.field), String(a.value)));
        }
        case "expr": {
          try { const { values } = await ctx.view.geneExpression(String(a.gene)); return values; }
          catch (e) { throw new Error(`no gene '${a.gene}' in this dataset`); }
        }
        case "numeric": {
          const m = await ctx.metaOf(String(a.field)) as any;
          if (m.kind !== "numeric") throw new Error(`'${a.field}' is not numeric`);
          return { values: m.values, min: m.min, max: m.max };
        }
        case "selectedCells": return Array.from(ctx.selectedCells());
        case "groupStats": {
          const m = await ctx.metaOf(String(a.field)) as any;
          if (m.kind !== "categorical") throw new Error(`'${a.field}' is not categorical`);
          const G = m.categories.length, codes = m.codes as Int32Array, genes: string[] = Array.isArray(a.genes) ? a.genes.map(String) : [];
          const mean: number[][] = [], frac: number[][] = [];
          for (const g of genes) {
            let vals: Float32Array | null = null;
            try { vals = (await ctx.view.geneExpression(g)).values; } catch { mean.push(new Array(G).fill(0)); frac.push(new Array(G).fill(0)); continue; }
            const sum = new Array(G).fill(0), pos = new Array(G).fill(0), cnt = new Array(G).fill(0);
            for (let i = 0; i < codes.length; i++) { const c = codes[i]; if (c >= 0) { const v = vals[i]; sum[c] += v; if (v > 0) pos[c]++; cnt[c]++; } }
            mean.push(sum.map((s, j) => cnt[j] ? s / cnt[j] : 0));
            frac.push(pos.map((p, j) => cnt[j] ? p / cnt[j] : 0));
          }
          return { groups: m.categories, genes, mean, frac };
        }
        default: throw new Error("unknown data kind: " + kind);
      }
    },
  };
}
