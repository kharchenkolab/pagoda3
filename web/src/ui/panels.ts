import { mk, S } from "./dom.ts";
import { Ctx } from "../data/ctx.ts";
import { EmbeddingView } from "../render/embedding.ts";
import { colorsFor, focusMaskFor } from "../render/colors.ts";
import { catColor } from "../data/view.ts";
import type { EntityRef } from "../data/coord.ts";

// Per-panel view spec — the agent's deep-control surface (configure_panel). Each property overrides the
// GLOBAL coord default for THIS panel only; the shared bus (selection/hint) stays global. See docs/deep-view-control.md.
export interface PanelView {
  colorBy?: string;     // override the panel's colouring handle (else falls back to coord.colorBy)
  scope?: EntityRef;    // restrict the panel to a cell set — the embedding reframes to it + desaturates the rest
  embedding?: string;   // which embedding this panel renders (e.g. "umap" vs "umap.unintegrated"); else the default
  // (future: scale, clip, splitBy, highlight, colormap, overlays)
}

export interface Panel {
  id: number; type: string; title: string; cap?: string; full?: boolean;
  bind?: string; text?: string; q?: string; group?: string; gene?: string;
  view?: PanelView;
  split?: { levels: string[]; genes: string[]; means: number[][] };   // gene × donor concordance matrix (SplitHeat)
  rows?: { gene?: number; symbol: string; lfc?: number; padj?: number; score?: number }[];
}

export interface PanelHooks {
  onGeneClick: (symbol: string) => void;
  onSelect: (ids: Int32Array, anchor: { left: number; top: number }) => void;
  registerEmbedding: (ev: EmbeddingView) => void;
  onCellHover: (index: number | null) => void;                 // embedding → cross-panel hint (hover tier)
  onCellClick: (index: number | null) => void;                 // embedding click → select cluster, or deselect (empty)
  registerComposition: (r: CompReactor) => void;               // a panel that reacts to selection + hint
}

// A vocabulary-bound panel that reacts to the two tiers, distinctly: `setSelect` is the committed selection
// (strong), `setHover` the ephemeral hint (light). `grouping` is the categorical it stacks/keys on; each set
// holds the category values to lift (translated in via cells when vocabularies differ). null = clear that tier.
export interface CompReactor { grouping: string; setSelect: (values: Set<string> | null) => void; setHover: (values: Set<string> | null) => void; }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export interface BuiltBody { el: HTMLElement; afterAttach?: () => void; }

export async function bodyFor(p: Panel, ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  switch (p.type) {
    case "Embedding": return embeddingBody(p, ctx, hooks);
    case "DeTable": return deBody(p, ctx, hooks);
    case "Volcano": return volcanoBody(p, ctx);
    case "CompositionBars": return compositionBody(p, ctx, hooks);
    case "BoxBySample": return boxBody(p, ctx);
    case "Overdispersion": return overdispBody(ctx, hooks);
    case "Heatmap": return heatmapBody(p, ctx, hooks);
    case "SplitHeat": return splitHeatBody(p);
    case "GeneList": return geneListBody(p, hooks);
    case "Note": { const d = mk("div", "notebody"); d.innerHTML = p.text || ""; d.style.cssText = "font-size:12.5px;line-height:1.5"; return { el: d }; }
    default: return { el: mk("div", undefined, p.type) };
  }
}

function embeddingBody(p: Panel, ctx: Ctx, hooks: PanelHooks): BuiltBody {
  const host = mk("div", "embhost");
  const legend = mk("div", "emblegend");
  const wrap = mk("div"); wrap.style.cssText = "position:absolute;inset:0"; wrap.appendChild(host); wrap.appendChild(legend);
  const afterAttach = () => {
    const emb = ctx.embeddingOf(p.view?.embedding);          // the panel's chosen embedding (else the default)
    const ev = new EmbeddingView(host, emb.data, emb.n);
    ev.onSelect = (ids) => { const r = host.getBoundingClientRect(); hooks.onSelect(ids, { left: r.left + r.width * 0.55, top: r.top + 40 }); };
    ev.onHover = (idx) => hooks.onCellHover(idx);
    ev.onPick = (idx) => hooks.onCellClick(idx);
    (ev as any)._legend = legend;
    (ev as any)._panel = p;            // carry the panel so paintEmbedding can read its per-panel view spec
    hooks.registerEmbedding(ev);
  };
  return { el: wrap, afterAttach };
}

export async function paintEmbedding(ev: EmbeddingView, ctx: Ctx) {
  const c = ctx.coord.state;
  const view = (ev as any)._panel?.view as PanelView | undefined;
  const colorBy = view?.colorBy ?? c.colorBy;            // per-panel override (configure_panel) → else the global default
  // scope frames THIS panel on a cell set: reframe the viewport to it (once, on change — never fight the user's pan),
  // and desaturate everything outside. A scoped panel is the evidence-board building block (e.g. "zoom to CD8-T").
  const scopeCells = view?.scope ? ctx.refToCells(view.scope) : null;
  const scopeKey = view?.scope ? (view.scope.kind === "category" ? `c:${view.scope.grouping}=${view.scope.value}` : `n:${scopeCells!.length}`) : "";
  if ((ev as any)._scopeKey !== scopeKey) { (ev as any)._scopeKey = scopeKey; ev.fitTo(scopeCells && scopeCells.length ? scopeCells : undefined); }

  // dim mask: scope frames the panel; else the committed SELECTION (bright cells, grey context); else metadata focus.
  const selCells = ctx.refToCells(c.selection);   // this panel is cell-space — read the selection as cells
  let mask: Uint8Array | undefined;
  if (scopeCells && scopeCells.length) { mask = new Uint8Array(ctx.n); for (let j = 0; j < scopeCells.length; j++) mask[scopeCells[j]] = 1; }
  else if (selCells.length) { mask = new Uint8Array(ctx.n); for (let j = 0; j < selCells.length; j++) mask[selCells[j]] = 1; }
  else mask = await focusMaskFor(ctx.view, c.focus, ctx.n);
  const { rgba, legend } = await colorsFor(ctx.view, colorBy, mask);
  ev.setColors(rgba);
  ev.setSelection(selCells.length ? selCells : null);
  // view options come from the coordination space (agent- and user-drivable), never decided here.
  const isCat = legend.kind === "categorical";
  ev.setLabels(c.display.labels && isCat ? await categoryLabels(ctx, colorBy, ctx.embeddingOf(view?.embedding).data) : []);
  const showLegend = c.display.legend ?? !isCat;   // auto: key for numeric colourings; hidden when on-plot labels carry identity
  const lg = (ev as any)._legend as HTMLElement | undefined;
  if (lg) lg.innerHTML = showLegend
    ? `<span class="lt">${legend.title}</span>` + legend.items.map((it) => `<span><span class="sw" style="background:rgb(${it.rgb.join(",")})"></span>${it.label}</span>`).join("")
    : "";
}

// On-plot label per category, for categorical colourings only (returns [] for gene/qc so the
// embedding clears its labels). Placement is the marginal MEDIAN (x,y) — robust to stray cells and
// multi-lobe clusters where a mean drifts into empty space. priority = cluster size, normalised to
// the [0,1000] the collision filter expects, so when two labels clash the larger cluster keeps its name.
async function categoryLabels(ctx: Ctx, colorBy: string, emb: Float32Array = ctx.embedding.data): Promise<{ text: string; p: [number, number]; priority: number }[]> {
  if (!colorBy.startsWith("meta:")) return [];
  const md = await ctx.metaOf(colorBy.slice(5)) as any;
  if (md.kind !== "categorical") return [];
  const K = md.categories.length, n = ctx.n;
  const xs: number[][] = Array.from({ length: K }, () => []), ys: number[][] = Array.from({ length: K }, () => []);
  for (let i = 0; i < n; i++) { const k = md.codes[i]; if (k < 0) continue; xs[k].push(emb[i * 2]); ys[k].push(emb[i * 2 + 1]); }
  const median = (a: number[]) => { a.sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  let maxC = 1; for (let k = 0; k < K; k++) if (xs[k].length > maxC) maxC = xs[k].length;
  const out: { text: string; p: [number, number]; priority: number }[] = [];
  for (let k = 0; k < K; k++) if (xs[k].length) out.push({ text: md.categories[k], p: [median(xs[k]), median(ys[k])], priority: (xs[k].length / maxC) * 1000 });
  return out;
}

// A filterable, sortable gene table — shared by DE tables and ranked gene lists. The search box filters by
// symbol; a header click sorts by that column (toggling asc/desc); a row click colours the embedding by that
// gene. No sort initially, so the upstream ranking is preserved until the user asks for another order.
type GCol = { key: string; label: string; num?: boolean; get: (r: any) => any; fmt?: (v: any, r: any) => string; cls?: (v: any) => string };
function geneTable(rows: any[], cols: GCol[], onPick: (symbol: string) => void): BuiltBody {
  const wrap = mk("div", "gtable");
  const search = Object.assign(document.createElement("input"), { className: "gsearch", placeholder: "filter genes…" }) as HTMLInputElement;
  const scroll = mk("div", "gscroll"), table = document.createElement("table");
  const thead = document.createElement("thead"), tb = document.createElement("tbody");
  table.appendChild(thead); table.appendChild(tb); scroll.appendChild(table);
  wrap.appendChild(search); wrap.appendChild(scroll);
  let sortKey: string | null = null, dir = 1;
  const render = () => {
    thead.innerHTML = `<tr>${cols.map((c) => `<th data-k="${c.key}" class="sortable${sortKey === c.key ? " sorted" : ""}">${esc(c.label)}${sortKey === c.key ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr>`;
    thead.querySelectorAll<HTMLElement>("th").forEach((th) => th.onclick = () => { const k = th.dataset.k!; if (sortKey === k) dir = -dir; else { sortKey = k; dir = cols.find((c) => c.key === k)?.num ? -1 : 1; } render(); });
    const q = search.value.trim().toLowerCase();
    let rs = q ? rows.filter((r) => String(r.symbol).toLowerCase().includes(q)) : rows.slice();
    if (sortKey) { const c = cols.find((x) => x.key === sortKey)!; rs.sort((a, b) => { const av = c.get(a), bv = c.get(b); return (av < bv ? -1 : av > bv ? 1 : 0) * dir; }); }
    tb.innerHTML = rs.map((r) => `<tr class="gene">${cols.map((c) => { const v = c.get(r); return `<td class="${c.cls ? c.cls(v) : ""}">${c.fmt ? c.fmt(v, r) : esc(String(v))}</td>`; }).join("")}</tr>`).join("");
    [...tb.children].forEach((tr, i) => (tr as HTMLElement).onclick = () => { [...tb.children].forEach((x) => x.classList.remove("on")); tr.classList.add("on"); onPick(rs[i].symbol); });
  };
  search.oninput = render; render();
  return { el: wrap };
}

function deBody(p: Panel, _ctx: Ctx, hooks: PanelHooks): BuiltBody {
  return geneTable(p.rows || [], [
    { key: "symbol", label: "gene", get: (r) => r.symbol },
    { key: "lfc", label: "log2FC", num: true, get: (r) => r.lfc ?? 0, fmt: (v) => v.toFixed(2), cls: (v) => (v > 0 ? "up" : "dn") },
    { key: "padj", label: "p.adj", num: true, get: (r) => r.padj ?? 1, fmt: (v) => (v < 1e-3 ? v.toExponential(1) : v.toFixed(3)) },
  ], hooks.onGeneClick);
}

// A ranked gene list with a single score column (e.g. scope-aware overdispersion).
function geneListBody(p: Panel, hooks: PanelHooks): BuiltBody {
  return geneTable(p.rows || [], [
    { key: "symbol", label: "gene", get: (r) => r.symbol },
    { key: "score", label: p.cap || "score", num: true, get: (r) => r.score ?? 0, fmt: (v) => v.toFixed(2), cls: () => "up" },
  ], hooks.onGeneClick);
}

async function compositionBody(panel: Panel, ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  const grouping = panel.view?.colorBy?.startsWith("meta:") ? panel.view.colorBy.slice(5) : "leiden";   // per-panel stack grouping (p is padding below)
  const { samples, conds, groups, props } = await ctx.composition(grouping);
  const W = 460, H = 200, p = 28, bw = Math.min(46, (W - p - 6) / samples.length - 6);
  // remember each category's segment box per sample — geometry for the hover ribbons
  const seg: ({ x: number; yTop: number; yBot: number } | null)[][] = groups.map(() => samples.map(() => null));
  let g = "";
  samples.forEach((sm, i) => {
    const x = p + i * ((W - p - 6) / samples.length); let ya = H - 26;
    props[i].forEach((pr, t) => { const h = pr * (H - 46); const yTop = ya - h; seg[t][i] = { x, yTop, yBot: ya };
      g += `<rect class="cseg" data-g="${esc(groups[t])}" x="${x}" y="${yTop.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" fill="rgb(${catColor(t).join(",")})"/>`; ya = yTop; });
    g += `<text class="axis" x="${x + bw / 2}" y="${H - 13}" text-anchor="middle">${esc(sm)}</text>`;
    g += `<text class="axis" x="${x + bw / 2}" y="${H - 3}" text-anchor="middle" fill="${conds[i] === "disease" ? "var(--bad)" : "var(--cyan)"}">${esc(conds[i])}</text>`;
  });
  const host = mk("div", "comphost");
  host.innerHTML = `<svg class="compsvg" viewBox="0 0 ${W} ${H}"><g class="cbars">${g}</g><g class="cribbons"></g></svg>`;
  const leg = mk("div", "legend"); leg.innerHTML = groups.map((gr, i) => `<span class="lgi" data-g="${esc(gr)}"><span class="sw" style="background:rgb(${catColor(i).join(",")})"></span>${esc(gr)}</span>`).join("");
  const w = mk("div"); w.appendChild(host); w.appendChild(leg);

  // React to BOTH tiers, distinctly: select = committed (heavy dim + bold + bright ribbon), hover = ephemeral
  // (soft dim + thin cue + faint ribbon). State is internal; re-rendered when either tier updates.
  const ribbons = host.querySelector(".cribbons") as SVGGElement;
  let selSet: Set<string> | null = null, hovSet: Set<string> | null = null;
  const ribbonOf = (name: string, opacity: number) => {
    const t = groups.indexOf(name); if (t < 0) return "";
    let d = ""; for (let i = 0; i + 1 < samples.length; i++) { const a = seg[t][i], b = seg[t][i + 1]; if (!a || !b) continue;
      const xr = a.x + bw, xl = b.x, mx = (xr + xl) / 2;
      d += `<path d="M${xr} ${a.yTop.toFixed(1)} C${mx} ${a.yTop.toFixed(1)} ${mx} ${b.yTop.toFixed(1)} ${xl} ${b.yTop.toFixed(1)} L${xl} ${b.yBot.toFixed(1)} C${mx} ${b.yBot.toFixed(1)} ${mx} ${a.yBot.toFixed(1)} ${xr} ${a.yBot.toFixed(1)} Z" fill="rgb(${catColor(t).join(",")})" fill-opacity="${opacity}"/>`; }
    return d;
  };
  const render = () => {
    const hasSel = !!(selSet && selSet.size), hasHov = !!(hovSet && hovSet.size);
    host.querySelectorAll<SVGRectElement>(".cseg").forEach((s) => { const n = s.dataset.g!, inSel = !!selSet?.has(n), inHov = !!hovSet?.has(n);
      s.classList.toggle("sel", inSel); s.classList.toggle("seldim", hasSel && !inSel);
      s.classList.toggle("hov", inHov && !inSel); s.classList.toggle("hovdim", !hasSel && hasHov && !inHov); });
    leg.querySelectorAll<HTMLElement>(".lgi").forEach((e) => { const n = e.dataset.g!; e.classList.toggle("sel", !!selSet?.has(n)); e.classList.toggle("hov", !!hovSet?.has(n)); });
    let paths = "";
    if (hasSel) for (const n of selSet!) paths += ribbonOf(n, 0.42);
    if (hasHov) for (const n of hovSet!) if (!selSet?.has(n)) paths += ribbonOf(n, 0.16);
    ribbons.innerHTML = paths;
  };
  // emit on hover (hint, light); click commits a SELECTION — the exact cell-set any panel would produce
  const nameAt = (e: Event) => ((e.target as Element).closest(".cseg, .lgi") as HTMLElement | null)?.dataset.g || null;
  w.addEventListener("pointermove", (e) => { const n = nameAt(e); if (n) ctx.coord.setHint({ kind: "category", grouping, value: n }); else ctx.coord.clearHint(); });
  w.addEventListener("pointerleave", () => ctx.coord.clearHint());
  w.addEventListener("click", (e) => { const n = nameAt(e); ctx.coord.setSelection(n ? { kind: "category", grouping, value: n } : null); });   // block → select; empty → deselect (mirrors the UMAP)

  return { el: w, afterAttach: () => hooks.registerComposition({ grouping, setSelect: (v) => { selSet = v; render(); }, setHover: (v) => { hovSet = v; render(); } }) };
}

function volcanoBody(p: Panel, _ctx: Ctx): BuiltBody {
  const W = 420, H = 240, pad = 28, lT = 1, pT = 0.05, xm = 3, ym = 5;
  const rows = (p.rows || []);
  const sx = (v: number) => pad + (Math.max(-xm, Math.min(xm, v)) + xm) / (2 * xm) * (W - pad - 6);
  const sy = (v: number) => H - pad - Math.min(v, ym) / ym * (H - 2 * pad);
  let g = `<line class="gl" x1="${sx(0)}" y1="6" x2="${sx(0)}" y2="${H - pad}"/>`;
  for (const r of rows) {
    const lfc = r.lfc ?? 0, pj = r.padj ?? 1;
    const y = -Math.log10(Math.max(pj, 1e-12)); const hit = Math.abs(lfc) >= lT && pj <= pT;
    g += `<circle cx="${sx(lfc).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="3.4" fill="${hit ? (lfc > 0 ? "var(--bad)" : "var(--cyan)") : "var(--faint)"}"/>`;
    if (hit && Math.abs(lfc) > 1.4) g += `<text class="axis" x="${(sx(lfc) + 5).toFixed(1)}" y="${(sy(y) + 3).toFixed(1)}">${r.symbol}</text>`;
  }
  g += `<text class="axis" x="${W / 2}" y="${H - 3}" text-anchor="middle">log2 fold-change</text>`;
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}` }); svg.innerHTML = g;
  const w = mk("div"); w.appendChild(svg); return { el: w };
}

async function boxBody(p: Panel, ctx: Ctx): Promise<BuiltBody> {
  const gene = p.gene || "IL6";
  const bins = await ctx.exprBySample(gene, p.group);
  const W = 540, H = 180, pad = 28; const allMax = Math.max(...bins.flatMap((b) => b.vals), 1);
  const sx = (i: number) => pad + i * ((W - pad - 6) / bins.length) + 20;
  const sy = (v: number) => H - pad - v / allMax * (H - 2 * pad);
  let g = "";
  bins.forEach((b, i) => {
    const x = sx(i), col = b.cond === "disease" ? "var(--bad)" : "var(--cyan)";
    const step = Math.max(1, Math.floor(b.vals.length / 60));
    for (let k = 0; k < b.vals.length; k += step) g += `<circle cx="${(x + (k % 9 - 4)).toFixed(1)}" cy="${sy(b.vals[k]).toFixed(1)}" r="2" fill="${col}" fill-opacity=".4"/>`;
    g += `<line x1="${x - 13}" y1="${sy(b.mean).toFixed(1)}" x2="${x + 13}" y2="${sy(b.mean).toFixed(1)}" stroke="${col}" stroke-width="2.4"/>`;
    g += `<text class="axis" x="${x}" y="${H - 12}" text-anchor="middle">${b.sample}</text><text class="axis" x="${x}" y="${H - 3}" text-anchor="middle" fill="${col}">${b.cond}</text>`;
  });
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}` }); svg.innerHTML = g;
  const w = mk("div"); w.appendChild(svg); return { el: w };
}

async function overdispBody(ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  const names = await ctx.view.ds.axisLabels("aspects");
  const adj = (await ctx.view.ds.fieldDense("aspect_adjvar")).data as Float32Array;
  const order = names.map((n, i) => ({ n, v: adj[i] })).sort((a, b) => b.v - a.v);
  const t = document.createElement("table");
  t.innerHTML = `<thead><tr><th>program</th><th>adj.var</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const o of order) {
    const on = ctx.coord.state.colorBy === `geneset:${o.n}`;
    const tr = mk("tr", "gene" + (on ? " on" : ""));
    tr.innerHTML = `<td style="text-align:left">${o.n}</td><td>${o.v.toFixed(1)}</td>`;
    tr.onclick = () => { [...tb.children].forEach((x) => x.classList.remove("on")); tr.classList.add("on"); ctx.coord.setColor(`geneset:${o.n}`); };
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  return { el: t };
}

// Per-donor concordance heat (gene × donor mean expression, row-normalised). A marker reading the SAME across
// donors = a genuinely merged cell type; bright in one donor and dim in the other = residual batch / divergence.
function splitHeatBody(p: Panel): BuiltBody {
  const d = p.split; if (!d || !d.genes.length || !d.levels.length) return { el: mk("div", undefined, "no split data") };
  const D = d.levels.length, padL = 96, padT = 26, cw = Math.max(42, Math.min(70, (320 - padL) / D)), rh = 17;
  const W = padL + D * cw + 6, H = padT + d.genes.length * rh + 6;
  let g = "";
  d.levels.forEach((lv, j) => { const short = lv.length > 9 ? "…" + lv.slice(-6) : lv; g += `<text class="axis" x="${padL + j * cw + cw / 2}" y="${padT - 9}" text-anchor="middle">${esc(short)}</text>`; });
  d.genes.forEach((gene, i) => {
    const row = d.means[i], mx = Math.max(...row, 1e-9);
    g += `<text class="axis" x="${padL - 6}" y="${padT + i * rh + rh - 5}" text-anchor="end">${esc(gene)}</text>`;
    row.forEach((v, j) => { const t = v / mx;
      g += `<rect x="${padL + j * cw}" y="${padT + i * rh}" width="${cw - 2}" height="${rh - 2}" rx="1" fill="rgb(${Math.round(22 + t * 202)},${Math.round(28 + t * 176)},${Math.round(38 + t * 52)})"/>`;
      g += `<text x="${padL + j * cw + cw / 2}" y="${padT + i * rh + rh - 5}" text-anchor="middle" style="font-size:8px;font-family:var(--mono)" fill="${t > 0.55 ? "#0d1117" : "#7d8a9a"}">${v.toFixed(1)}</text>`;
    });
  });
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}` }); svg.innerHTML = g; (svg as any).style.cssText = "width:100%;height:auto;max-width:340px";
  const w = mk("div"); w.appendChild(svg); return { el: w };
}

async function heatmapBody(p: Panel, ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  const grouping = p.group || "leiden";
  const gs = await ctx.groupStatsCached(grouping);
  const markers = await ctx.markers(grouping);
  // top 3 genes per group, unique
  const seen = new Set<number>(); const rows: { gene: number; symbol: string }[] = [];
  for (const grp of gs.groups) for (const m of (markers.get(grp) || []).slice(0, 3)) if (!seen.has(m.gene)) { seen.add(m.gene); rows.push({ gene: m.gene, symbol: m.symbol }); }
  const G = gs.groups.length, R = rows.length, cw = Math.min(28, 360 / G), ch = 13, x0 = 70, y0 = 6;
  // scale each gene row to its max-across-groups for contrast. Cells/labels carry their row+col
  // index so hover can read the names (axis labels go faint — unreadable when dense — and the
  // names are revealed legibly on hover instead).
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  let g = "";
  rows.forEach((r, ri) => {
    let mx = 1e-6; for (let c = 0; c < G; c++) mx = Math.max(mx, gs.mean[c * gs.nGenes + r.gene]);
    for (let c = 0; c < G; c++) {
      const t = Math.min(1, gs.mean[c * gs.nGenes + r.gene] / mx); const col = ramp(t);
      g += `<rect class="hcell" data-ri="${ri}" data-c="${c}" x="${x0 + c * cw}" y="${y0 + ri * ch}" width="${cw - 0.5}" height="${ch - 0.5}" fill="${col}"/>`;
    }
    g += `<text class="axis hgene" data-ri="${ri}" x="${x0 - 4}" y="${y0 + ri * ch + 10}" text-anchor="end">${esc(r.symbol)}</text>`;
  });
  gs.groups.forEach((grp, c) => { g += `<text class="axis hgrp" data-c="${c}" x="${x0 + c * cw + cw / 2}" y="${y0 + R * ch + 10}" text-anchor="middle">${esc(grp)}</text>`; });
  // row + column highlight bands, shown only while hovering (so you can see which cell you're on)
  g += `<rect class="hrowg" x="${x0}" width="${G * cw}" height="${ch}" fill="rgba(150,225,255,.14)" pointer-events="none" style="display:none"/>`;
  g += `<rect class="hcolg" y="${y0}" width="${cw}" height="${R * ch}" fill="rgba(150,225,255,.14)" pointer-events="none" style="display:none"/>`;
  const H = y0 + R * ch + 16, W = x0 + G * cw + 6;
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}` }); svg.innerHTML = g; (svg as any).style.maxHeight = "320px";
  const rowg = svg.querySelector<SVGRectElement>(".hrowg")!, colg = svg.querySelector<SVGRectElement>(".hcolg")!;

  const w = mk("div"); w.style.position = "relative"; w.appendChild(svg);
  // a legible readout that follows the cursor — the actual gene/cell-type names, however dense the axes
  const tip = mk("div"); tip.style.cssText = "position:absolute;display:none;background:var(--ink);border:1px solid var(--line2);border-radius:6px;padding:3px 8px;font-size:11px;color:var(--text);pointer-events:none;z-index:20;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.45)";
  w.appendChild(tip);
  const showTip = (e: PointerEvent, html: string) => {
    tip.innerHTML = html; tip.style.display = "block";
    const r = w.getBoundingClientRect(); let x = e.clientX - r.left + 13;
    if (x + tip.offsetWidth > r.width - 4) x = e.clientX - r.left - tip.offsetWidth - 8;
    tip.style.left = Math.max(2, x) + "px"; tip.style.top = (e.clientY - r.top + 13) + "px";
  };
  const clear = () => { tip.style.display = "none"; rowg.style.display = colg.style.display = "none"; ctx.coord.clearHint(); };
  svg.addEventListener("pointerleave", clear);

  // two-tier coordination. HOVER: a row/col guide + a name readout + a subtle locator ring on the UMAP
  // (no recolour). CLICK: the committed act — recolour by the gene, or recolour + focus the cell type.
  svg.querySelectorAll<SVGElement>(".hcell").forEach((el) => {
    const ri = +el.getAttribute("data-ri")!, c = +el.getAttribute("data-c")!;
    const sym = rows[ri].symbol, grp = gs.groups[c]; el.style.cursor = "pointer";
    el.addEventListener("pointermove", (e) => {
      rowg.setAttribute("y", String(y0 + ri * ch)); colg.setAttribute("x", String(x0 + c * cw));
      rowg.style.display = colg.style.display = "block";
      const mean = gs.mean[c * gs.nGenes + rows[ri].gene];
      showTip(e, `<b>${esc(sym)}</b> · ${esc(grp)} <span style="color:var(--faint)">${mean.toFixed(2)}</span>`);
      ctx.coord.setHint({ kind: "category", grouping, value: grp });
    });
    el.addEventListener("click", () => hooks.onGeneClick(sym));
  });
  svg.querySelectorAll<SVGElement>(".hgene").forEach((el) => {
    const ri = +el.getAttribute("data-ri")!; const sym = rows[ri].symbol; el.style.cursor = "pointer";
    el.addEventListener("pointermove", (e) => { rowg.setAttribute("y", String(y0 + ri * ch)); rowg.style.display = "block"; colg.style.display = "none"; showTip(e, `<b>${esc(sym)}</b>`); });
    el.addEventListener("click", () => hooks.onGeneClick(sym));
  });
  svg.querySelectorAll<SVGElement>(".hgrp").forEach((el) => {
    const c = +el.getAttribute("data-c")!; const grp = gs.groups[c]; el.style.cursor = "pointer";
    el.addEventListener("pointermove", (e) => { colg.setAttribute("x", String(x0 + c * cw)); colg.style.display = "block"; rowg.style.display = "none"; showTip(e, `<b>${esc(grp)}</b>`); ctx.coord.setHint({ kind: "category", grouping, value: grp }); });
    el.addEventListener("click", () => { ctx.coord.setColor("meta:" + grouping); ctx.coord.setFocus(grouping, grp); });
  });

  const hint = mk("div"); hint.style.cssText = "font-size:10.5px;color:var(--faint);padding:5px 7px 2px;line-height:1.4";
  hint.textContent = "hover a cell to read its gene × cell type · click a gene to colour by it · click a column to focus the type";
  w.appendChild(hint);
  return { el: w };
}

function ramp(t: number): string {
  const a = [27, 34, 48], b = [224, 164, 88];
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`;
}
