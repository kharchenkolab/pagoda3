import { mk, S } from "./dom.ts";
import { Ctx } from "../data/ctx.ts";
import { EmbeddingView } from "../render/embedding.ts";
import { colorsFor, focusMaskFor } from "../render/colors.ts";
import { catColor } from "../data/view.ts";

export interface Panel {
  id: number; type: string; title: string; cap?: string; full?: boolean;
  bind?: string; text?: string; q?: string; group?: string; gene?: string;
  rows?: { gene?: number; symbol: string; lfc?: number; padj?: number; score?: number }[];
}

export interface PanelHooks {
  onGeneClick: (symbol: string) => void;
  onSelect: (ids: Int32Array, anchor: { left: number; top: number }) => void;
  registerEmbedding: (ev: EmbeddingView) => void;
}

export interface BuiltBody { el: HTMLElement; afterAttach?: () => void; }

export async function bodyFor(p: Panel, ctx: Ctx, hooks: PanelHooks): Promise<BuiltBody> {
  switch (p.type) {
    case "Embedding": return embeddingBody(ctx, hooks);
    case "DeTable": return deBody(p, ctx, hooks);
    case "Volcano": return volcanoBody(p, ctx);
    case "CompositionBars": return compositionBody(ctx);
    case "BoxBySample": return boxBody(p, ctx);
    case "Overdispersion": return overdispBody(ctx, hooks);
    case "Heatmap": return heatmapBody(p, ctx, hooks);
    case "GeneList": return geneListBody(p, hooks);
    case "Note": { const d = mk("div", "notebody"); d.innerHTML = p.text || ""; d.style.cssText = "font-size:12.5px;line-height:1.5"; return { el: d }; }
    default: return { el: mk("div", undefined, p.type) };
  }
}

function embeddingBody(ctx: Ctx, hooks: PanelHooks): BuiltBody {
  const host = mk("div", "embhost");
  const legend = mk("div", "emblegend");
  const wrap = mk("div"); wrap.style.cssText = "position:absolute;inset:0"; wrap.appendChild(host); wrap.appendChild(legend);
  const afterAttach = () => {
    const ev = new EmbeddingView(host, ctx.embedding.data, ctx.embedding.n);
    ev.onSelect = (ids) => { const r = host.getBoundingClientRect(); hooks.onSelect(ids, { left: r.left + r.width * 0.55, top: r.top + 40 }); };
    (ev as any)._legend = legend;
    hooks.registerEmbedding(ev);
  };
  return { el: wrap, afterAttach };
}

export async function paintEmbedding(ev: EmbeddingView, ctx: Ctx) {
  const c = ctx.coord.state;
  const mask = await focusMaskFor(ctx.view, c.focus, ctx.n);
  const { rgba, legend } = await colorsFor(ctx.view, c.colorBy, mask);
  ev.setColors(rgba);
  ev.setSelection(c.selection);
  // view options come from the coordination space (agent- and user-drivable), never decided here.
  const isCat = legend.kind === "categorical";
  ev.setLabels(c.display.labels && isCat ? await categoryLabels(ctx, c.colorBy) : []);
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
async function categoryLabels(ctx: Ctx, colorBy: string): Promise<{ text: string; p: [number, number]; priority: number }[]> {
  if (!colorBy.startsWith("meta:")) return [];
  const md = await ctx.metaOf(colorBy.slice(5)) as any;
  if (md.kind !== "categorical") return [];
  const K = md.categories.length, emb = ctx.embedding.data, n = ctx.n;
  const xs: number[][] = Array.from({ length: K }, () => []), ys: number[][] = Array.from({ length: K }, () => []);
  for (let i = 0; i < n; i++) { const k = md.codes[i]; if (k < 0) continue; xs[k].push(emb[i * 2]); ys[k].push(emb[i * 2 + 1]); }
  const median = (a: number[]) => { a.sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  let maxC = 1; for (let k = 0; k < K; k++) if (xs[k].length > maxC) maxC = xs[k].length;
  const out: { text: string; p: [number, number]; priority: number }[] = [];
  for (let k = 0; k < K; k++) if (xs[k].length) out.push({ text: md.categories[k], p: [median(xs[k]), median(ys[k])], priority: (xs[k].length / maxC) * 1000 });
  return out;
}

function deBody(p: Panel, ctx: Ctx, hooks: PanelHooks): BuiltBody {
  const t = document.createElement("table");
  t.innerHTML = `<thead><tr><th>gene</th><th>log2FC</th><th>p.adj</th></tr></thead>`;
  const tb = document.createElement("tbody");
  const rows = (p.rows || []).slice(0, 20);
  for (const r of rows) {
    const tr = mk("tr", "gene");
    const lfc = r.lfc ?? 0, pj = r.padj ?? 1;
    const padj = pj < 1e-3 ? pj.toExponential(1) : pj.toFixed(3);
    tr.innerHTML = `<td>${r.symbol}</td><td class="${lfc > 0 ? "up" : "dn"}">${lfc.toFixed(2)}</td><td>${padj}</td>`;
    tr.onclick = () => { [...tb.children].forEach((x) => x.classList.remove("on")); tr.classList.add("on"); hooks.onGeneClick(r.symbol); };
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  return { el: t };
}

// A ranked gene list with a single score column (e.g. scope-aware overdispersion). Clicking a
// row colours the embedding by that gene — the same gesture as the DE table.
function geneListBody(p: Panel, hooks: PanelHooks): BuiltBody {
  const t = document.createElement("table");
  t.innerHTML = `<thead><tr><th>gene</th><th>${p.cap || "score"}</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const r of (p.rows || []).slice(0, 25)) {
    const tr = mk("tr", "gene");
    tr.innerHTML = `<td>${r.symbol}</td><td class="up">${(r.score ?? 0).toFixed(2)}</td>`;
    tr.onclick = () => { [...tb.children].forEach((x) => x.classList.remove("on")); tr.classList.add("on"); hooks.onGeneClick(r.symbol); };
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  return { el: t };
}

async function compositionBody(ctx: Ctx): Promise<BuiltBody> {
  const { samples, conds, groups, props } = await ctx.composition("leiden");
  const W = 460, H = 200, p = 28, bw = Math.min(46, (W - p - 6) / samples.length - 6);
  let g = "";
  samples.forEach((sm, i) => {
    const x = p + i * ((W - p - 6) / samples.length); let ya = H - 26;
    props[i].forEach((pr, t) => { const h = pr * (H - 46); ya -= h; const c = catColor(t); g += `<rect x="${x}" y="${ya.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" fill="rgb(${c.join(",")})" fill-opacity=".9"/>`; });
    g += `<text class="axis" x="${x + bw / 2}" y="${H - 13}" text-anchor="middle">${sm}</text>`;
    g += `<text class="axis" x="${x + bw / 2}" y="${H - 3}" text-anchor="middle" fill="${conds[i] === "disease" ? "var(--bad)" : "var(--cyan)"}">${conds[i]}</text>`;
  });
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}` }); svg.innerHTML = g;
  const w = mk("div"); w.appendChild(svg);
  const leg = mk("div", "legend"); leg.innerHTML = groups.map((gr, i) => `<span><span class="sw" style="background:rgb(${catColor(i).join(",")})"></span>${gr}</span>`).join("");
  w.appendChild(leg);
  return { el: w };
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
      ctx.coord.setHint(grouping, grp);
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
    el.addEventListener("pointermove", (e) => { colg.setAttribute("x", String(x0 + c * cw)); colg.style.display = "block"; rowg.style.display = "none"; showTip(e, `<b>${esc(grp)}</b>`); ctx.coord.setHint(grouping, grp); });
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
