// A library of self-contained, theme-aware WIDGET RECIPES the agent adapts to build advanced data-viz widgets.
// Each `source` is a COMPLETE, runnable widget (calls pagoda.ready) demonstrating one technique against the real
// data API — the agent reads one with get_widget_recipe, then adapts (change the field/gene, restyle, combine).
// Convention (mirrors template.ts KITCHEN_SINK so it parses cleanly): outer backtick string; inner HTML via an
// escaped \`...\` template; build dynamic markup with string concatenation (no ${} interpolation); colours ONLY via
// var(--*) so they theme. SVG for vector charts, <canvas> for dense scatter. No external/CDN code.

export interface WidgetRecipe { name: string; title: string; about: string; techniques: string[]; source: string; }

// ---- ranked horizontal bars of a categorical field (composition); click a bar to select; cross-filters on selection ----
const RANKED_BARS = `// Ranked composition bars for a categorical field. Click a bar to select that category.
const root = document.body;
root.innerHTML = \`<div class="pg-row"><label>field <select id="f"></select></label><span id="sub" class="pg-muted"></span></div><svg id="c" width="100%" style="display:block"></svg>\`;
const sel = root.querySelector('#f'), svg = root.querySelector('#c'), sub = root.querySelector('#sub');
let field = null;
async function draw() {
  const d = await pagoda.data('categories', { field });
  const order = d.categories.map((name, i) => ({ name, n: d.counts[i] })).sort((a, b) => b.n - a.n);
  const total = order.reduce((s, o) => s + o.n, 0), max = Math.max(1, ...order.map(o => o.n));
  const rowH = 20, padL = 0, w = svg.clientWidth || 320, barX = 116, barW = Math.max(40, w - barX - 52);
  svg.setAttribute('height', order.length * rowH + 6);
  const cur = pagoda.coord && pagoda.coord.selection;
  svg.innerHTML = order.map((o, i) => {
    const y = i * rowH + 3, bw = (o.n / max) * barW;
    const on = cur && cur.value === o.name;
    const fill = on ? 'var(--amber)' : 'var(--cyan)';
    return '<text x="0" y="' + (y + 13) + '" fill="var(--text)" font-size="11" font-family="var(--sans)">' + o.name.slice(0, 16) + '</text>'
      + '<rect x="' + barX + '" y="' + (y + 3) + '" width="' + bw + '" height="12" rx="2" fill="' + fill + '" style="cursor:pointer"><title>' + o.name + ': ' + o.n + ' (' + (100 * o.n / total).toFixed(1) + '%)</title></rect>'
      + '<text x="' + (barX + bw + 5) + '" y="' + (y + 13) + '" fill="var(--dim)" font-size="10" font-family="var(--mono)">' + o.n + '</text>';
  }).join('');
  sub.textContent = '· ' + order.length + ' categories, ' + total.toLocaleString() + ' cells';
  [...svg.querySelectorAll('rect')].forEach((r, i) => r.onclick = () => pagoda.setSelection({ category: { grouping: field, value: order[i].name } }));
}
(async () => { const f = await pagoda.data('fields'); sel.innerHTML = f.categorical.map(n => '<option>' + n + '</option>').join(''); field = f.categorical[0]; sel.value = field; sel.onchange = () => { field = sel.value; draw(); }; draw(); })();
pagoda.on('coord', draw);   // re-draw to reflect (and highlight) the active selection
pagoda.ready({ title: 'Composition', controls: [{ id: 'clear', label: 'clear' }] });
pagoda.on('control', id => { if (id === 'clear') pagoda.setSelection(null); });
`;

// ---- histogram of a numeric field with a drag-brush that selects the cells in the brushed range ----
const HISTOGRAM = `// Histogram of a numeric field. Drag across the bars to select the cells in that value range.
const root = document.body;
root.innerHTML = \`<div class="pg-row"><label>field <select id="f"></select></label><span id="sub" class="pg-muted"></span></div><svg id="c" width="100%" height="120" style="display:block;cursor:crosshair"></svg>\`;
const sel = root.querySelector('#f'), svg = root.querySelector('#c'), sub = root.querySelector('#sub');
let field = null, vals = null, vmin = 0, vmax = 1, bins = [], BN = 28;
async function load() {
  const d = await pagoda.data('numeric', { field }); vals = d.values; vmin = d.min; vmax = d.max || 1;
  bins = new Array(BN).fill(0);
  const span = (vmax - vmin) || 1;
  for (let i = 0; i < vals.length; i++) { let b = Math.floor((vals[i] - vmin) / span * BN); if (b < 0) b = 0; if (b >= BN) b = BN - 1; bins[b]++; }
  draw(null);
}
function draw(brush) {
  const w = svg.clientWidth || 320, h = 120, max = Math.max(1, ...bins), bw = w / BN;
  svg.innerHTML = bins.map((c, i) => {
    const bh = (c / max) * (h - 18), inBrush = brush && i >= brush[0] && i <= brush[1];
    return '<rect x="' + (i * bw) + '" y="' + (h - 16 - bh) + '" width="' + (bw - 1) + '" height="' + bh + '" fill="' + (inBrush ? 'var(--amber)' : 'var(--cyan)') + '"/>';
  }).join('') + '<text x="0" y="' + (h - 2) + '" fill="var(--faint)" font-size="10" font-family="var(--mono)">' + vmin.toFixed(1) + '</text>'
    + '<text x="' + (w - 2) + '" y="' + (h - 2) + '" text-anchor="end" fill="var(--faint)" font-size="10" font-family="var(--mono)">' + vmax.toFixed(1) + '</text>';
}
let drag = null;
const binAt = (e) => { const r = svg.getBoundingClientRect(); return Math.max(0, Math.min(BN - 1, Math.floor((e.clientX - r.left) / (r.width / BN)))); };
svg.onmousedown = (e) => { drag = [binAt(e), binAt(e)]; draw(drag); };
svg.onmousemove = (e) => { if (!drag) return; drag[1] = binAt(e); draw([Math.min(drag[0], drag[1]), Math.max(drag[0], drag[1])]); };
window.addEventListener('mouseup', () => { if (!drag) return; const lo = Math.min(drag[0], drag[1]), hi = Math.max(drag[0], drag[1]); const span = (vmax - vmin) || 1;
  const a = vmin + lo / BN * span, b = vmin + (hi + 1) / BN * span; const ids = []; for (let i = 0; i < vals.length; i++) if (vals[i] >= a && vals[i] <= b) ids.push(i);
  pagoda.setSelection({ cells: ids }); sub.textContent = '· ' + ids.length.toLocaleString() + ' cells in [' + a.toFixed(2) + ', ' + b.toFixed(2) + ']'; drag = null; });
(async () => { const f = await pagoda.data('fields'); sel.innerHTML = f.numeric.map(n => '<option>' + n + '</option>').join(''); field = f.numeric[0]; sel.value = field; sel.onchange = () => { field = sel.value; load(); }; load(); })();
pagoda.ready({ title: 'Histogram' });
`;

// ---- canvas scatter of two numeric fields (or genes); selected cells highlighted; reacts to coord ----
const SCATTER = `// Canvas scatter of two numeric fields. Selected cells (from anywhere) are highlighted. Type gene: to use a gene.
const root = document.body;
root.innerHTML = \`<div class="pg-row"><label>x <input id="x" style="width:88px"></label><label>y <input id="y" style="width:88px"></label><button id="go">plot</button></div><div id="wrap" style="position:relative;height:240px"><canvas id="cv" style="position:absolute;inset:0;width:100%;height:100%"></canvas></div>\`;
const cv = root.querySelector('#cv'), wrap = root.querySelector('#wrap');
let X = null, Y = null, selSet = null;
async function series(spec) { spec = spec.trim(); if (spec.startsWith('gene:')) return await pagoda.data('expr', { gene: spec.slice(5) }); const d = await pagoda.data('numeric', { field: spec }); return d.values; }
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888'; }
function paint() {
  if (!X || !Y) return; const dpr = window.devicePixelRatio || 1, W = wrap.clientWidth, H = wrap.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < X.length; i++) { if (X[i] < xmin) xmin = X[i]; if (X[i] > xmax) xmax = X[i]; if (Y[i] < ymin) ymin = Y[i]; if (Y[i] > ymax) ymax = Y[i]; }
  const sx = v => 4 + (v - xmin) / ((xmax - xmin) || 1) * (W - 8), sy = v => H - 4 - (v - ymin) / ((ymax - ymin) || 1) * (H - 8);
  const dim = css('--faint'), hot = css('--amber'); g.globalAlpha = selSet ? 0.25 : 0.55; g.fillStyle = css('--cyan');
  for (let i = 0; i < X.length; i++) { if (selSet && selSet.has(i)) continue; g.fillRect(sx(X[i]), sy(Y[i]), 2, 2); }
  if (selSet) { g.globalAlpha = 0.9; g.fillStyle = hot; selSet.forEach(i => { if (i < X.length) g.fillRect(sx(X[i]) - 0.5, sy(Y[i]) - 0.5, 3, 3); }); }
}
async function plot() { try { X = await series(root.querySelector('#x').value); Y = await series(root.querySelector('#y').value); paint(); } catch (e) { console.error(e.message); } }
async function refreshSel() { const ids = await pagoda.data('selectedCells'); selSet = ids && ids.length ? new Set(ids) : null; paint(); }
root.querySelector('#go').onclick = plot;
pagoda.on('coord', refreshSel); pagoda.on('theme', paint); new ResizeObserver(paint).observe(wrap);
(async () => { const f = await pagoda.data('fields'); const n = f.numeric; root.querySelector('#x').value = n[0] || ''; root.querySelector('#y').value = n[1] || n[0] || ''; plot(); })();
pagoda.ready({ title: 'Scatter', height: 300 });
`;

// ---- mean-expression heatmap: genes (rows) x a grouping's categories (cols), sequential colour scale ----
const HEATMAP = `// Mean-expression heatmap: genes (rows) by a categorical grouping's groups (cols). Edit GENES / grouping.
const root = document.body;
const GENES = ['CD3D', 'CD8A', 'MS4A1', 'NKG7', 'LYZ', 'PPBP'];   // adapt to the dataset's genes
root.innerHTML = \`<div class="pg-row"><label>group by <select id="g"></select></label></div><div id="grid" style="overflow:auto"></div><div id="msg" class="pg-muted"></div>\`;
const gsel = root.querySelector('#g'), grid = root.querySelector('#grid'), msg = root.querySelector('#msg');
function ramp(t) { t = Math.max(0, Math.min(1, t)); const a = [13, 27, 42], b = [92, 200, 255]; return 'rgb(' + a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(',') + ')'; }
async function draw(grouping) {
  const cat = await pagoda.data('category', { field: grouping }); const G = cat.categories, codes = cat.codes;
  const rows = []; let gmax = 0;
  for (const gene of GENES) { let vals; try { vals = await pagoda.data('expr', { gene }); } catch (e) { rows.push({ gene, miss: true, m: [] }); continue; }
    const sum = new Array(G.length).fill(0), cnt = new Array(G.length).fill(0);
    for (let i = 0; i < codes.length; i++) { const c = codes[i]; if (c >= 0) { sum[c] += vals[i]; cnt[c]++; } }
    const m = sum.map((s, i) => cnt[i] ? s / cnt[i] : 0); gmax = Math.max(gmax, ...m); rows.push({ gene, m });
  }
  const cw = 46, ch = 20;
  let html = '<table style="border-collapse:collapse;font-family:var(--mono);font-size:10px"><tr><td></td>' + G.map(g => '<td style="padding:2px 3px;color:var(--dim);text-align:center;max-width:' + cw + 'px;overflow:hidden">' + g.slice(0, 8) + '</td>').join('') + '</tr>';
  for (const r of rows) { html += '<tr><td style="padding:2px 6px;color:var(--text);white-space:nowrap">' + r.gene + (r.miss ? ' <span style="color:var(--faint)">(n/a)</span>' : '') + '</td>'
    + (r.miss ? G.map(() => '<td></td>').join('') : r.m.map(v => '<td style="width:' + cw + 'px;height:' + ch + 'px;background:' + ramp(v / (gmax || 1)) + '" title="' + v.toFixed(2) + '"></td>').join('')) + '</tr>'; }
  grid.innerHTML = html + '</table>'; msg.textContent = 'mean log-expression · ' + G.length + ' groups · scale 0–' + gmax.toFixed(1);
}
(async () => { const f = await pagoda.data('fields'); gsel.innerHTML = f.categorical.map(n => '<option>' + n + '</option>').join(''); const g0 = f.categorical[0]; gsel.value = g0; gsel.onchange = () => draw(gsel.value); draw(g0); })();
pagoda.ready({ title: 'Expression heatmap' });
`;

// ---- donut of a categorical field's proportions (SVG arcs) ----
const DONUT = `// Donut chart of a categorical field's proportions.
const root = document.body;
root.innerHTML = \`<div class="pg-row"><label>field <select id="f"></select></label></div><div style="display:flex;gap:12px;align-items:center"><svg id="d" width="120" height="120" viewBox="0 0 120 120"></svg><div id="leg" style="font-size:11px"></div></div>\`;
const sel = root.querySelector('#f'), svg = root.querySelector('#d'), leg = root.querySelector('#leg');
const PAL = ['--cyan', '--amber', '--good', '--bad', '--teal', '--ct2', '--ct0', '--ct3'];
function arc(cx, cy, r, a0, a1) { const p = (a, rr) => [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]; const large = a1 - a0 > Math.PI ? 1 : 0; const [x0, y0] = p(a0, r), [x1, y1] = p(a1, r), [x2, y2] = p(a1, r * 0.6), [x3, y3] = p(a0, r * 0.6); return 'M' + x0 + ' ' + y0 + 'A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1 + 'L' + x2 + ' ' + y2 + 'A' + (r * 0.6) + ' ' + (r * 0.6) + ' 0 ' + large + ' 0 ' + x3 + ' ' + y3 + 'Z'; }
async function draw(field) {
  const d = await pagoda.data('categories', { field }); const order = d.categories.map((name, i) => ({ name, n: d.counts[i] })).sort((a, b) => b.n - a.n);
  const total = order.reduce((s, o) => s + o.n, 0) || 1; let a = -Math.PI / 2;
  svg.innerHTML = order.map((o, i) => { const a1 = a + o.n / total * Math.PI * 2; const path = arc(60, 60, 54, a, a1); a = a1; return '<path d="' + path + '" fill="var(' + PAL[i % PAL.length] + ')"><title>' + o.name + ': ' + (100 * o.n / total).toFixed(1) + '%</title></path>'; }).join('');
  leg.innerHTML = order.slice(0, 8).map((o, i) => '<div style="display:flex;gap:6px;align-items:center;margin:1px 0"><span style="width:9px;height:9px;border-radius:2px;background:var(' + PAL[i % PAL.length] + ')"></span><span style="color:var(--text)">' + o.name + '</span> <span style="color:var(--faint)">' + (100 * o.n / total).toFixed(0) + '%</span></div>').join('');
}
(async () => { const f = await pagoda.data('fields'); sel.innerHTML = f.categorical.map(n => '<option>' + n + '</option>').join(''); sel.value = f.categorical[0]; sel.onchange = () => draw(sel.value); draw(f.categorical[0]); })();
pagoda.ready({ title: 'Proportions' });
`;

// ---- selection analytics: what is the current selection made of? (reacts to coord, pulls selectedCells) ----
const SELECTION_BREAKDOWN = `// Breaks down the CURRENT selection by a chosen field — a live analytic that reacts to selections from any panel.
const root = document.body;
root.innerHTML = \`<div class="pg-row"><label>break down by <select id="f"></select></label></div><div id="hd" class="pg-muted"></div><svg id="c" width="100%" style="display:block;margin-top:4px"></svg>\`;
const sel = root.querySelector('#f'), svg = root.querySelector('#c'), hd = root.querySelector('#hd');
let field = null, codesCache = {};
async function codesFor(f) { if (!codesCache[f]) codesCache[f] = await pagoda.data('category', { field: f }); return codesCache[f]; }
async function draw() {
  const ids = await pagoda.data('selectedCells');
  if (!ids || !ids.length) { hd.textContent = 'No selection — pick cells or a category in any panel.'; svg.innerHTML = ''; svg.setAttribute('height', 0); return; }
  const cat = await codesFor(field); const counts = new Array(cat.categories.length).fill(0);
  for (const i of ids) { const c = cat.codes[i]; if (c >= 0) counts[c]++; }
  const order = cat.categories.map((name, i) => ({ name, n: counts[i] })).filter(o => o.n).sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...order.map(o => o.n)), rowH = 18, w = svg.clientWidth || 300, barX = 110, barW = Math.max(40, w - barX - 46);
  svg.setAttribute('height', order.length * rowH + 4);
  svg.innerHTML = order.map((o, i) => { const y = i * rowH + 2, bw = o.n / max * barW; return '<text x="0" y="' + (y + 12) + '" fill="var(--text)" font-size="11" font-family="var(--sans)">' + o.name.slice(0, 15) + '</text><rect x="' + barX + '" y="' + (y + 2) + '" width="' + bw + '" height="11" rx="2" fill="var(--amber)"/><text x="' + (barX + bw + 5) + '" y="' + (y + 12) + '" fill="var(--dim)" font-size="10" font-family="var(--mono)">' + o.n + '</text>'; }).join('');
  hd.textContent = ids.length.toLocaleString() + ' cells selected · by ' + field;
}
(async () => { const f = await pagoda.data('fields'); sel.innerHTML = f.categorical.map(n => '<option>' + n + '</option>').join(''); field = f.categorical[0]; sel.value = field; sel.onchange = () => { field = sel.value; draw(); }; draw(); })();
pagoda.on('coord', draw);
pagoda.ready({ title: 'Selection breakdown' });
`;

export const RECIPES: WidgetRecipe[] = [
  { name: "ranked-bars", title: "Ranked composition bars", about: "Horizontal bars of a categorical field's composition; click a bar to select; highlights the active selection.", techniques: ["SVG bars", "data('categories')", "click → setSelection", "react to coord"], source: RANKED_BARS },
  { name: "histogram", title: "Histogram + brush", about: "Binned distribution of a numeric field; drag a range to select the cells in it.", techniques: ["SVG histogram", "data('numeric')", "drag-brush", "range → setSelection(cells)"], source: HISTOGRAM },
  { name: "scatter", title: "Canvas scatter", about: "Two numeric fields/genes on a <canvas>; selected cells highlighted; reacts to selection + theme.", techniques: ["canvas 2d + DPR", "data('numeric'/'expr')", "data('selectedCells')", "react to coord+theme"], source: SCATTER },
  { name: "heatmap", title: "Expression heatmap", about: "Mean expression of a gene set across a grouping's groups, with a sequential colour scale.", techniques: ["table grid", "per-group means", "colour ramp", "data('category')+data('expr')"], source: HEATMAP },
  { name: "donut", title: "Proportions donut", about: "Donut chart of a categorical field's proportions (SVG arc paths) with a legend.", techniques: ["SVG arc paths", "data('categories')", "themed palette"], source: DONUT },
  { name: "selection-breakdown", title: "Selection breakdown", about: "Live analytic: breaks the CURRENT selection down by a chosen field — reacts to selections from any panel.", techniques: ["data('selectedCells')", "tally by category", "react to coord"], source: SELECTION_BREAKDOWN },
];

export function listRecipes(): { name: string; title: string; about: string; techniques: string[] }[] {
  return RECIPES.map((r) => ({ name: r.name, title: r.title, about: r.about, techniques: r.techniques }));
}
export function getRecipe(name: string): string | null {
  const r = RECIPES.find((x) => x.name === (name || "").trim());
  return r ? `// RECIPE "${r.name}" — ${r.title}: ${r.about}\n// Techniques: ${r.techniques.join(", ")}\n// Adapt freely (fields/genes/styling); keep it self-contained + themed via var(--*).\n${r.source}` : null;
}
