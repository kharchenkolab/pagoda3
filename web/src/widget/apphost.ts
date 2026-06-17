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
  return { theme: h.theme, coord: h.coord, hint: h.hint, subscribe: h.subscribe, data: h.data, fetchExternal: h.fetchExternal, loadLib: h.loadLib, apply: () => { /* preview is side-effect-free */ } };
}

// A short, agent-readable summary of a coordination message a widget EMITS — so a preview can report "the widget did
// X" (e.g. clicking a row emitted setSelection(category cell_type=NK)) without the agent needing the live app.
export function emitSummary(m: WidgetMsg): string {
  if (m.t === "setSelection") { const s: any = (m as any).sel; if (!s) return "setSelection(null)"; if (s.category) return `setSelection(category ${s.category.grouping}=${s.category.value})`; if (Array.isArray(s.cells)) return `setSelection(${s.cells.length} cells)`; return "setSelection(?)"; }
  if (m.t === "setHint") { const h: any = (m as any).hint; if (!h) return "setHint(null)"; if (h.category) return `setHint(category ${h.category.grouping}=${h.category.value})`; if (Array.isArray(h.cells)) return `setHint(${h.cells.length} cells)`; return "setHint(?)"; }
  if (m.t === "setColor") return `setColor(${(m as any).handle})`;
  if (m.t === "updateView") return `updateView(${Object.keys((m as any).patch || {}).join(",") || "?"})`;
  return m.t;
}

// What preview_widget can simulate. Pre-resolved (cells already looked up) so the host stays synchronous.
export interface PreviewSim { selection?: SelectionInfo | null; selCells?: number[]; hint?: HintInfo | null; colorBy?: string; }

// The PREVIEW host: read-only (writes are CAPTURED, never applied) + an optional SIMULATED coord selection / hover so
// the agent can TEST coordination widgets (a selection-reactive or hover-reactive widget renders against realistic
// state), and an in-flight counter so the preview waits for data/fetch/lib to settle before snapshotting. `__emitted`
// collects the coordination the widget tried to drive; `pending()` reports outstanding async ops. Reads (data/theme)
// still resolve against the real app, so previews use real data.
export function previewHost(app: App, sim?: PreviewSim): WidgetHost & { __emitted: string[]; pending: () => number } {
  const base = makeWidgetHost(app);
  const emitted: string[] = [];
  let inflight = 0;
  const track = <T,>(p: Promise<T>): Promise<T> => { inflight++; return p.finally(() => { inflight--; }); };
  const hasSel = sim ? "selection" in sim : false;
  const hasHint = sim ? "hint" in sim : false;
  return {
    theme: base.theme,
    coord: (): CoordInfo => { const c = base.coord(); return { colorBy: sim?.colorBy || c.colorBy, selection: hasSel ? (sim!.selection ?? null) : c.selection, focus: c.focus }; },
    hint: (): HintInfo => (hasHint ? (sim!.hint ?? null) : base.hint()),
    subscribe: base.subscribe,
    apply: (m: WidgetMsg) => { emitted.push(emitSummary(m)); },   // capture for the agent; never mutate the live session
    data: (kind, args) => { if (kind === "selectedCells" && sim && sim.selCells) return track(Promise.resolve(sim.selCells.slice())); return track(base.data(kind, args)); },
    fetchExternal: base.fetchExternal ? (u, o) => track(base.fetchExternal!(u, o)) : undefined,
    loadLib: base.loadLib ? (n) => track(base.loadLib!(n)) : undefined,
    __emitted: emitted,
    pending: () => inflight,
  };
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
        case "rankGenes": {
          // Top genes for a CELL SET vs the rest (markers) — DE over the WHOLE transcriptome, computed app-side in ONE
          // call (subsampled, so fast), so widgets get a MEANINGFUL ranking (what's special about these cells) without
          // looping per-gene expr (slow) or ranking by raw mean (which surfaces housekeeping genes). The cell set is
          // explicit `cells`, a category {field,value}, or — by default — the CURRENT selection.
          let cells: number[] | null = null;
          if (Array.isArray(a.cells)) cells = a.cells.map(Number).filter((i: number) => i >= 0 && i < ctx.n);
          else if (a.field != null && a.value != null) { await ctx.metaOf(String(a.field)); cells = Array.from(ctx.cellsOfCategory(String(a.field), String(a.value))); }
          else cells = Array.from(ctx.selectedCells());
          if (!cells || !cells.length) return { genes: [], nA: 0, note: "no cells in the set (nothing selected?)" };
          const inA = new Uint8Array(ctx.n); for (const i of cells) inA[i] = 1;
          const B: number[] = []; for (let i = 0; i < ctx.n; i++) if (!inA[i]) B.push(i);
          const de = await ctx.view.subsampleDE(cells, B);
          const n = Math.min(Math.max(1, Number(a.n) || 20), 100);
          const dir = a.dir === "abs" ? "abs" : a.dir === "down" ? "down" : "up";
          let ranked = de.ranked;
          if (dir === "up") ranked = ranked.filter((r) => r.lfc > 0).sort((x, y) => y.lfc - x.lfc);
          else if (dir === "down") ranked = ranked.filter((r) => r.lfc < 0).sort((x, y) => x.lfc - y.lfc);
          // 'abs' keeps subsampleDE's existing |lfc| ordering
          const genes = ranked.slice(0, n).map((r) => ({ symbol: r.symbol, lfc: +r.lfc.toFixed(3), meanA: +r.meanA.toFixed(3), meanB: +r.meanB.toFixed(3) }));
          return { genes, nA: de.nA, approx: de.approx };
        }
        default: throw new Error("unknown data kind: " + kind);
      }
    },
    fetchExternal: async (u, opts) => {
      const r = await fetch("/api/ext/fetch?url=" + encodeURIComponent(String(u)));
      if (!r.ok) throw new Error("external fetch failed (" + r.status + "): " + (await r.text()).slice(0, 150));
      const as = opts?.as, ct = r.headers.get("content-type") || "";
      if (as === "text") return r.text();
      if (as === "arrayBuffer") return r.arrayBuffer();
      if (as === "json" || /json/.test(ct)) return r.json();
      return r.text();
    },
    loadLib: async (name) => {
      const r = await fetch("/api/lib?name=" + encodeURIComponent(String(name)));
      if (!r.ok) throw new Error(`library "${name}" not available: ` + (await r.text()).slice(0, 120));
      return r.text();
    },
  };
}
