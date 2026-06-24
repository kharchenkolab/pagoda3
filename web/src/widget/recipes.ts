// A library of self-contained, theme-aware WIDGET RECIPES the agent adapts to build advanced data-viz widgets.
// Each `source` is a COMPLETE, runnable widget (calls pagoda.ready) demonstrating one technique against the real
// data API — the agent reads one with get_widget_recipe, then adapts (change the field/gene, restyle, combine).
// Convention (mirrors template.ts KITCHEN_SINK so it parses cleanly): outer backtick string; inner HTML via an
// escaped \`...\` template; build dynamic markup with string concatenation (no ${} interpolation); colours ONLY via
// var(--*) so they theme. SVG for vector charts, <canvas> for dense scatter. No external/CDN code.

// kind 'widget' = a complete runnable widget to adapt; 'snippet' = reusable building-block functions to paste in
// (the "plot library", delivered as inlinable code rather than a bundled dependency — keeps widgets self-contained).
export interface WidgetRecipe { name: string; title: string; about: string; techniques: string[]; source: string; kind?: "widget" | "snippet"; }

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

// Top MARKER genes for the current selection — the canonical "react to selection → meaningful stats" pattern. Uses
// data('rankGenes') (DE vs rest, ONE call) — NOT a per-gene expr loop (slow) or raw-mean ranking (housekeeping genes).
// (No inner backticks: built with string concatenation so the whole source stays a clean template literal.)
const SELECTION_MARKERS = "// Top marker genes for whatever is selected in any panel — reacts to the selection.\n"
+ "const root = document.body;\n"
+ "root.innerHTML = '<div id=\"hd\" class=\"pg-muted\" style=\"margin-bottom:6px\"></div><svg id=\"c\" width=\"100%\" style=\"display:block\"></svg>';\n"
+ "const svg = root.querySelector('#c'), hd = root.querySelector('#hd');\n"
+ "let busy = false, again = false;\n"
+ "async function draw() {\n"
+ "  if (busy) { again = true; return; }\n"
+ "  busy = true;\n"
+ "  try {\n"
+ "    const sel = pagoda.coord && pagoda.coord.selection;\n"
+ "    if (!sel) { hd.textContent = 'Nothing selected — pick cells or a category in any panel.'; svg.innerHTML = ''; svg.setAttribute('height', 0); return; }\n"
+ "    hd.textContent = 'ranking…';\n"
+ "    const res = await pagoda.data('rankGenes', { n: 10, dir: 'up' });   // current selection vs the rest, one call\n"
+ "    const genes = (res && res.genes) || [];\n"
+ "    if (!genes.length) { hd.textContent = 'No marker genes for this set.'; svg.innerHTML = ''; svg.setAttribute('height', 0); return; }\n"
+ "    const max = Math.max.apply(null, genes.map(function (g) { return g.lfc; }).concat([1e-6]));\n"
+ "    const rowH = 20, w = svg.clientWidth || 300, barX = 80, barW = Math.max(40, w - barX - 46);\n"
+ "    svg.setAttribute('height', genes.length * rowH + 4);\n"
+ "    svg.innerHTML = genes.map(function (g, i) {\n"
+ "      const y = i * rowH + 2, bw = Math.max(1, g.lfc / max * barW);\n"
+ "      return '<text x=\"0\" y=\"' + (y + 14) + '\" fill=\"var(--text)\" font-size=\"11\" font-family=\"var(--mono)\">' + g.symbol.slice(0, 11) + '</text>'\n"
+ "        + '<rect x=\"' + barX + '\" y=\"' + (y + 4) + '\" width=\"' + bw + '\" height=\"12\" rx=\"2\" fill=\"var(--cyan)\"></rect>'\n"
+ "        + '<text x=\"' + (barX + bw + 5) + '\" y=\"' + (y + 14) + '\" fill=\"var(--dim)\" font-size=\"10\" font-family=\"var(--mono)\">' + g.lfc.toFixed(2) + '</text>';\n"
+ "    }).join('');\n"
+ "    const cnt = sel.count != null ? sel.count.toLocaleString() + ' cells · ' : '';\n"
+ "    hd.textContent = cnt + 'top markers (log-FC vs rest)';\n"
+ "  } finally { busy = false; if (again) { again = false; draw(); } }\n"
+ "}\n"
+ "pagoda.on('coord', draw);\n"
+ "draw();\n"
+ "pagoda.ready({ title: 'Selection markers' });\n";

// ---- reusable building-block SNIPPETS (the "plot kit", delivered as inlinable functions) ----
const SNIP_SCALES = `// scales + nice ticks — paste in, then use for axes/positions.
function scaleLinear(d0, d1, r0, r1) { const m = (r1 - r0) / ((d1 - d0) || 1); return (v) => r0 + (v - d0) * m; }
function niceTicks(min, max, n) { n = n || 5; const span = (max - min) || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0))), norm = step0 / mag; const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag; const lo = Math.ceil(min / step) * step, out = []; for (let v = lo; v <= max + 1e-9; v += step) out.push(+v.toFixed(6)); return out; }
`;
const SNIP_CANVAS_POINTS = `// paint points on a <canvas> (DPR-correct, auto-scaled). Returns {sx,sy,x0,x1,y0,y1} so you can hit-test + draw axes.
// opt: { color?, sel?:Set<number>, selColor?, size? }
// Call this from inside the 'responsive' onSized(canvas.parentElement, ...) so it repaints at the right size + on resize.
function paintPoints(canvas, xs, ys, opt) { opt = opt || {}; const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 400, H = canvas.clientHeight || (canvas.parentElement && canvas.parentElement.clientHeight) || 260;   // guard a transient 0 size (measured before first layout) — repaint on a ResizeObserver to refine
  canvas.width = W * dpr; canvas.height = H * dpr; const g = canvas.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (let i = 0; i < xs.length; i++) { if (xs[i] < x0) x0 = xs[i]; if (xs[i] > x1) x1 = xs[i]; if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i]; }
  const sx = (v) => 6 + (v - x0) / ((x1 - x0) || 1) * (W - 12), sy = (v) => H - 6 - (v - y0) / ((y1 - y0) || 1) * (H - 12);
  const cv = getComputedStyle(document.documentElement), sz = opt.size || 2;
  g.globalAlpha = opt.sel ? 0.25 : 0.6; g.fillStyle = opt.color || cv.getPropertyValue('--cyan').trim() || '#5cc8ff';
  for (let i = 0; i < xs.length; i++) { if (opt.sel && opt.sel.has(i)) continue; g.fillRect(sx(xs[i]), sy(ys[i]), sz, sz); }
  if (opt.sel) { g.globalAlpha = 0.95; g.fillStyle = opt.selColor || cv.getPropertyValue('--amber').trim() || '#e0a458'; opt.sel.forEach((i) => { if (i < xs.length) g.fillRect(sx(xs[i]) - 0.5, sy(ys[i]) - 0.5, sz + 1, sz + 1); }); }
  return { sx, sy, x0, x1, y0, y1 };
}
`;
const SNIP_HITTEST = `// nearest-point pick for canvas hover/click (sx,sy from paintPoints). Returns the cell index or -1.
function nearestPoint(xs, ys, sx, sy, px, py, maxPx) { maxPx = maxPx || 8; let best = -1, bd = maxPx * maxPx; for (let i = 0; i < xs.length; i++) { const dx = sx(xs[i]) - px, dy = sy(ys[i]) - py, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } } return best; }
// wire it: canvas.onmousemove = (e) => { const r = canvas.getBoundingClientRect(), i = nearestPoint(xs, ys, S.sx, S.sy, e.clientX - r.left, e.clientY - r.top); pagoda.setHint(i >= 0 ? { cells: [i] } : null); };
//          canvas.onclick     = (e) => { const r = canvas.getBoundingClientRect(), i = nearestPoint(xs, ys, S.sx, S.sy, e.clientX - r.left, e.clientY - r.top); if (i >= 0) pagoda.setSelection({ cells: [i] }); };
`;
const SNIP_COLOR = `// theme-aware colour helpers. seqRamp(t in 0..1) -> 'rgb(...)' for heat scales; catColor(i) -> a CSS var() for categories.
function seqRamp(t) { t = Math.max(0, Math.min(1, t)); const a = [20, 28, 40], b = [92, 200, 255]; return 'rgb(' + a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(',') + ')'; }
const CAT_VARS = ['--cyan', '--amber', '--good', '--bad', '--teal', '--ct2', '--ct0', '--ct3'];
function catColor(i) { return 'var(' + CAT_VARS[i % CAT_VARS.length] + ')'; }
`;
const SNIP_SVG_AXES = `// draw x/y axes with nice ticks into an <svg> (needs scaleLinear + niceTicks above). Returns {sx,sy} mapping data->px.
// IMPORTANT: measure the container's size with the 'responsive' snippet (onSized) and draw inside it — a chart that
// reads clientWidth at init renders at 0×0 before first layout. Pass the w,h from onSized as the svg/plot dimensions.
function drawAxes(svg, x0, x1, y0, y1, w, h, pad) { pad = pad || { l: 36, b: 18, t: 6, r: 8 };
  const sx = scaleLinear(x0, x1, pad.l, w - pad.r), sy = scaleLinear(y0, y1, h - pad.b, pad.t);
  let s = '<line x1="' + pad.l + '" y1="' + (h - pad.b) + '" x2="' + (w - pad.r) + '" y2="' + (h - pad.b) + '" stroke="var(--line)"/>'
        + '<line x1="' + pad.l + '" y1="' + pad.t + '" x2="' + pad.l + '" y2="' + (h - pad.b) + '" stroke="var(--line)"/>';
  niceTicks(x0, x1, 5).forEach((t) => { s += '<text x="' + sx(t) + '" y="' + (h - 5) + '" text-anchor="middle" font-size="9" font-family="var(--mono)" fill="var(--faint)">' + t + '</text>'; });
  niceTicks(y0, y1, 4).forEach((t) => { s += '<text x="' + (pad.l - 4) + '" y="' + (sy(t) + 3) + '" text-anchor="end" font-size="9" font-family="var(--mono)" fill="var(--faint)">' + t + '</text>'; });
  svg.insertAdjacentHTML('beforeend', s); return { sx, sy };
}
`;
const SNIP_BINS = `// bin values into n bins → {counts, edges, min, max}. Pair with SVG rects for a histogram.
function histogramBins(values, n) { n = n || 28; let mn = Infinity, mx = -Infinity; for (const v of values) { if (v < mn) mn = v; if (v > mx) mx = v; } const span = (mx - mn) || 1, counts = new Array(n).fill(0); for (const v of values) { let b = Math.floor((v - mn) / span * n); if (b < 0) b = 0; if (b >= n) b = n - 1; counts[b]++; } const edges = []; for (let i = 0; i <= n; i++) edges.push(mn + i / n * span); return { counts, edges, min: mn, max: mx }; }
`;

const SNIP_REGION_BRUSH = `// drag a RECTANGLE on a canvas scatter to select the cells inside (region → setSelection). Uses a <div> overlay so
// the box survives canvas repaints. brushRegion(canvas, getState, onSelect): getState()->{xs,ys,S} (S from paintPoints,
// has sx,sy); onSelect(ids:number[]).
function brushRegion(canvas, getState, onSelect) {
  const box = document.createElement('div'); box.style.cssText = 'position:absolute;border:1px solid var(--cyan);background:rgba(92,200,255,.12);pointer-events:none;display:none';
  (canvas.parentElement || document.body).appendChild(box);
  let x0 = 0, y0 = 0, dragging = false;
  const rel = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('mousedown', (e) => { dragging = true; [x0, y0] = rel(e); Object.assign(box.style, { display: '', left: (canvas.offsetLeft + x0) + 'px', top: (canvas.offsetTop + y0) + 'px', width: '0px', height: '0px' }); });
  window.addEventListener('mousemove', (e) => { if (!dragging) return; const [x, y] = rel(e); Object.assign(box.style, { left: (canvas.offsetLeft + Math.min(x0, x)) + 'px', top: (canvas.offsetTop + Math.min(y0, y)) + 'px', width: Math.abs(x - x0) + 'px', height: Math.abs(y - y0) + 'px' }); });
  window.addEventListener('mouseup', (e) => { if (!dragging) return; dragging = false; box.style.display = 'none'; const [x, y] = rel(e), st = getState(); if (!st || !st.S) return;
    const ax = Math.min(x0, x), bx = Math.max(x0, x), ay = Math.min(y0, y), by = Math.max(y0, y); if (bx - ax < 3 && by - ay < 3) return;
    const ids = []; for (let i = 0; i < st.xs.length; i++) { const sx = st.S.sx(st.xs[i]), sy = st.S.sy(st.ys[i]); if (sx >= ax && sx <= bx && sy >= ay && sy <= by) ids.push(i); }
    onSelect(ids); });
}
// usage: const STATE = { xs, ys, S: null }; /* after each paint: */ STATE.S = paintPoints(canvas, xs, ys, opt);
//        brushRegion(canvas, () => STATE, (ids) => pagoda.setSelection({ cells: ids }));
`;

const SNIP_RESPONSIVE = `// Draw ONLY once the container has a real size, and REDRAW when it changes — avoids the "drew at 0×0 before layout"
// trap (an element's clientWidth is 0 until the first layout pass, so charts that measure at init render blank).
// onSized(el, draw): calls draw(width,height) as soon as el is non-zero, and again whenever it resizes.
function onSized(el, draw) {
  let last = '';
  const tick = () => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; const k = w + 'x' + h; if (k === last) return; last = k; draw(w, h); };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(tick).observe(el); else addEventListener('resize', tick);
  tick(); requestAnimationFrame(tick);   // try now + next frame too
}
// usage: onSized(wrap, (w, h) => { svg.setAttribute('width', w); svg.setAttribute('height', h); /* ...draw with w,h... */ });
`;

const SNIP_EXT_FETCH = `// Pull EXTERNAL biodata through the host (allowlisted: PDB/RCSB, UniProt, Ensembl, NCBI, AlphaFold, STRING, Reactome).
// Widgets are sandboxed — never call the browser's network APIs or load a CDN directly; always route through this. Returns json or text.
async function examples(id) {
  const entry = await pagoda.fetchExternal('https://data.rcsb.org/rest/v1/core/entry/' + id, { as: 'json' });   // PDB entry metadata
  const prot  = await pagoda.fetchExternal('https://rest.uniprot.org/uniprotkb/P69905.json', { as: 'json' });    // UniProt record
  const cif   = await pagoda.fetchExternal('https://files.rcsb.org/download/' + id + '.cif', { as: 'text' });    // structure file (text)
  return { entry, prot, cif };
}
`;

const SNIP_LOAD_LIB = `// Load an ALLOWLISTED, host-pinned JS library at runtime — the host injects it; you never load remote code yourself.
// After the promise resolves, the library's global is ready. Registry (grows host-side): '3dmol' -> window.$3Dmol, 'd3' -> window.d3.
async function useLib() {
  await pagoda.loadLib('d3');        // then use the d3 global
  await pagoda.loadLib('3dmol');     // then use the $3Dmol global (molecular structures)
}
// Pair with pagoda.fetchExternal to feed the library real data (a structure file, a record, …), and use the library's
// own documented API. If unsure of that API, fetch_url its docs at author time, then write the calls inline.
`;

export const SNIPPETS: WidgetRecipe[] = [
  { name: "load-lib", title: "Load a host-pinned library", about: "pagoda.loadLib(name) loads an allowlisted, version-pinned JS library at runtime (the host injects it) for capabilities the snippets don't cover — a 3D viewer, a heavy chart/graph lib. Registry: '3dmol'→$3Dmol, 'd3'→d3. Use the library's own API after it resolves.", techniques: ["library", "loadLib", "3D", "viewer", "webgl", "structure", "molecule", "molstar", "3dmol", "d3", "graph", "network", "external code"], source: SNIP_LOAD_LIB, kind: "snippet" },
  { name: "ext-fetch", title: "External data fetch", about: "pagoda.fetchExternal(url,{as}) pulls ALLOWLISTED external biodata (PDB/RCSB, UniProt, Ensembl, NCBI, AlphaFold, STRING, Reactome) through the host — for fetching a structure, a protein record, gene annotations, etc. Never fetch() directly.", techniques: ["external", "fetch", "PDB", "RCSB", "UniProt", "Ensembl", "NCBI", "AlphaFold", "API", "protein", "structure", "annotation"], source: SNIP_EXT_FETCH, kind: "snippet" },
  { name: "responsive", title: "Size-aware draw / redraw", about: "onSized(el, draw): run your draw(width,height) once the container has a real size and again on resize — the antidote to a chart rendering at 0×0 before first layout (SVG or canvas). Wrap any chart's draw in this.", techniques: ["responsive", "resize", "ResizeObserver", "layout", "clientWidth", "redraw", "size", "draw"], source: SNIP_RESPONSIVE, kind: "snippet" },
  { name: "scales", title: "Scales + nice ticks", about: "scaleLinear(domain→range) and niceTicks(min,max,n) — the basis of any axis or positioned chart.", techniques: ["scale", "axis", "ticks", "linear", "log alternative"], source: SNIP_SCALES, kind: "snippet" },
  { name: "canvas-points", title: "Canvas point cloud", about: "paintPoints(canvas,xs,ys,opt): DPR-correct, auto-scaled scatter painting with optional selection highlight; returns the scales for hit-testing.", techniques: ["canvas", "scatter", "DPR", "autoscale", "selection highlight"], source: SNIP_CANVAS_POINTS, kind: "snippet" },
  { name: "hit-test", title: "Nearest-point hit test", about: "nearestPoint(...) + the onmousemove/onclick wiring to turn a canvas scatter into point-level hover (setHint) and click (setSelection) — hover/click like a native panel.", techniques: ["hit test", "hover", "click", "setHint", "setSelection", "nearest"], source: SNIP_HITTEST, kind: "snippet" },
  { name: "region-brush", title: "Rectangle region brush", about: "brushRegion(...): drag a rectangle on a canvas scatter to select the cells inside (region → setSelection); div overlay survives repaints.", techniques: ["brush", "region", "rectangle", "gating", "select", "setSelection", "drag"], source: SNIP_REGION_BRUSH, kind: "snippet" },
  { name: "color", title: "Theme colour helpers", about: "seqRamp(t) for sequential heat scales and catColor(i) for categorical series — both read the theme palette.", techniques: ["colour", "ramp", "palette", "heatmap", "categorical", "theme"], source: SNIP_COLOR, kind: "snippet" },
  { name: "svg-axes", title: "SVG axes", about: "drawAxes(svg,...) renders themed x/y axes with nice ticks into an SVG and returns data→pixel scales (needs the scales snippet).", techniques: ["svg", "axis", "ticks", "labels"], source: SNIP_SVG_AXES, kind: "snippet" },
  { name: "bins", title: "Histogram binning", about: "histogramBins(values,n) → counts/edges/min/max for a histogram or density.", techniques: ["histogram", "bins", "distribution", "density"], source: SNIP_BINS, kind: "snippet" },
];

// External-data demo: fetch a PDB entry's metadata from RCSB via the host (allowlisted) and show a themed card.
const PDB_CARD = `// Fetch a PDB structure's metadata from RCSB via the host and show a card. Adapt to UniProt/Ensembl/AlphaFold.
const root = document.body;
root.innerHTML = '<div class="pg-row"><label>PDB id <input id="pid" value="4HHB" style="width:84px;text-transform:uppercase"></label><button id="go">fetch</button></div><div id="card" class="pg-muted" style="margin-top:8px;line-height:1.6"></div>';
const card = root.querySelector('#card');
async function load() {
  const id = root.querySelector('#pid').value.trim().toUpperCase(); if (!id) return;
  card.textContent = 'loading ' + id + '…';
  try {
    const e = await pagoda.fetchExternal('https://data.rcsb.org/rest/v1/core/entry/' + id, { as: 'json' });
    const title = (e.struct && e.struct.title) || '(no title)';
    const method = (e.exptl && e.exptl[0] && e.exptl[0].method) || '?';
    const res = e.rcsb_entry_info && e.rcsb_entry_info.resolution_combined && e.rcsb_entry_info.resolution_combined[0];
    const atoms = e.rcsb_entry_info && e.rcsb_entry_info.deposited_atom_count;
    card.innerHTML = '<div style="font-weight:600;color:var(--text)">' + id + '</div>'
      + '<div style="color:var(--text);margin:2px 0">' + title + '</div>'
      + '<div>' + method + (res ? (' · ' + res + ' Å') : '') + (atoms ? (' · ' + atoms.toLocaleString() + ' atoms') : '') + '</div>';
  } catch (err) { card.textContent = 'error: ' + err.message; }
}
root.querySelector('#go').onclick = load;
root.querySelector('#pid').onkeydown = (ev) => { if (ev.key === 'Enter') load(); };
load();
pagoda.ready({ title: 'PDB entry' });
`;

// A complete loadLib-powered 3D viewer with CLEAN DEFAULTS — the canonical good first result for "show a structure".
// (No inner backticks: this whole source is a template literal, so it builds markup with string concatenation.)
const STRUCTURE_VIEWER = `// 3D protein STRUCTURE viewer — loadLib('3dmol') + fetchExternal(RCSB) → a clean cartoon.
// CLEAN DEFAULTS so a multi-chain entry doesn't render as a pile of "extra" chains: shows ONE representative chain,
// cartoon/spectrum, waters+ligands hidden. The chain selector switches chain / shows all; .pdb falls back to mmCIF.
const root = document.body;
root.style.cssText = 'margin:0;font-family:var(--sans);color:var(--text);display:flex;flex-direction:column;height:100vh;background:var(--panel)';
const bar = document.createElement('div');
bar.style.cssText = 'display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--line);flex:0 0 auto;flex-wrap:wrap';
bar.innerHTML = '<label style="font-size:12px;color:var(--dim)">PDB</label>'
  + '<input id="pdb" value="1CRN" maxlength="8" style="width:72px;background:var(--inset);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:3px 6px;font-family:var(--mono);text-transform:uppercase">'
  + '<button id="go" style="background:var(--cyan);color:var(--panel);border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-weight:600">Load</button>'
  + '<select id="rep" style="background:var(--inset);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:3px 5px"><option value="cartoon">Cartoon</option><option value="stick">Stick</option><option value="sphere">Sphere</option><option value="line">Line</option></select>'
  + '<select id="chain" style="background:var(--inset);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:3px 5px"></select>'
  + '<span id="status" style="font-size:12px;color:var(--dim);margin-left:auto"></span>';
root.appendChild(bar);
const view = document.createElement('div'); view.style.cssText = 'flex:1 1 auto;position:relative;min-height:0'; root.appendChild(view);
const $ = function (s) { return root.querySelector(s); };
const status = function (m) { $('#status').textContent = m; };
let viewer = null;
function styleSpec() { const r = $('#rep').value; if (r === 'stick') return { stick: { radius: 0.15 } }; if (r === 'sphere') return { sphere: { scale: 0.3 } }; if (r === 'line') return { line: {} }; return { cartoon: { color: 'spectrum' } }; }
function chainSel() { const c = $('#chain').value; return c === '*' ? {} : { chain: c }; }
function draw() { if (!viewer) return; viewer.setStyle({}, {}); const sel = Object.assign({ hetflag: false }, chainSel()); viewer.setStyle(sel, styleSpec()); viewer.zoomTo(sel); viewer.render(); }
async function load() {
  const id = ($('#pdb').value || '').trim().toUpperCase();
  if (!/^[A-Za-z0-9]{4}$/.test(id)) { status('enter a 4-char PDB id'); return; }
  status('loading ' + id + '…');
  try {
    await pagoda.loadLib('3dmol');
    let txt = await pagoda.fetchExternal('https://files.rcsb.org/download/' + id + '.pdb', { as: 'text' }).catch(function () { return null; });
    let fmt = 'pdb';
    if (!txt || txt.length < 100 || /^<|no.?file/i.test(txt.slice(0, 80))) { txt = await pagoda.fetchExternal('https://files.rcsb.org/download/' + id + '.cif', { as: 'text' }).catch(function () { return null; }); fmt = 'cif'; }
    if (!txt || txt.length < 100) { status('no structure for ' + id); return; }
    const bg = pagoda.cssVar('--panel') || '#111';
    if (!viewer) viewer = $3Dmol.createViewer(view, { backgroundColor: bg });
    viewer.clear(); const model = viewer.addModel(txt, fmt);
    const chains = []; model.selectedAtoms({}).forEach(function (a) { if (a.chain && chains.indexOf(a.chain) < 0) chains.push(a.chain); }); chains.sort();
    const sel = $('#chain'); sel.innerHTML = chains.map(function (c) { return '<option value="' + c + '">Chain ' + c + '</option>'; }).join('') + (chains.length > 1 ? '<option value="*">All chains</option>' : '');
    sel.value = chains[0] || '*';
    draw();
    status(id + ' · ' + chains.length + ' chain' + (chains.length !== 1 ? 's' : ''));
  } catch (e) { status('error: ' + (e && e.message || e)); }
}
$('#go').addEventListener('click', load);
$('#pdb').addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });
$('#rep').addEventListener('change', function () { draw(); pagoda.setParam('rep', $('#rep').value); });   // report the in-widget control's change so the DECLARED value stays in sync (persist / describe_panel / agent)
$('#chain').addEventListener('change', draw);
// 'rep' is a DECLARED param (the agent/voice can set the representation + it persists) that the widget draws ITSELF —
// render:'self' → NO header chip; the <select id="rep"> in the toolbar above IS its control, placed where it belongs.
pagoda.ready({ title: 'Protein Structure', height: 420, params: [{ id: 'rep', label: 'View', type: 'select', value: 'cartoon', render: 'self',
  options: [{ value: 'cartoon', label: 'Cartoon' }, { value: 'stick', label: 'Stick' }, { value: 'sphere', label: 'Sphere' }, { value: 'line', label: 'Line' }] }] });
pagoda.on('param', function (id, v) { if (id === 'rep') { $('#rep').value = v; draw(); } });   // external (agent/voice) set → sync the control + redraw
load();
`;

export const RECIPES: WidgetRecipe[] = [
  { name: "pdb-card", title: "PDB entry card", about: "Fetch a PDB structure's metadata from RCSB (title, method, resolution, atom count) via pagoda.fetchExternal and show a themed card — the worked example of external-data integration.", techniques: ["external", "PDB", "RCSB", "protein", "structure", "fetchExternal", "card", "annotation"], source: PDB_CARD },
  { name: "structure-viewer", title: "3D protein structure viewer", about: "Interactive 3D molecular structure from a PDB id: loadLib('3dmol') + fetchExternal(RCSB), rendered as a clean cartoon. CLEAN DEFAULTS — shows ONE representative chain (not the whole multi-chain assembly), waters/ligands hidden, with chain + representation selectors; .pdb falls back to mmCIF for large entries. Use this when the user wants to SEE a structure (not just its metadata — that's pdb-card).", techniques: ["3D", "structure", "protein", "molecule", "PDB", "RCSB", "3dmol", "loadLib", "fetchExternal", "viewer", "cartoon", "chain", "webgl", "mmCIF", "render"], source: STRUCTURE_VIEWER },
  { name: "ranked-bars", title: "Ranked composition bars", about: "Horizontal bars of a categorical field's composition; click a bar to select; highlights the active selection.", techniques: ["SVG bars", "data('categories')", "click → setSelection", "react to coord"], source: RANKED_BARS },
  { name: "histogram", title: "Histogram + brush", about: "Binned distribution of a numeric field; drag a range to select the cells in it.", techniques: ["SVG histogram", "data('numeric')", "drag-brush", "range → setSelection(cells)"], source: HISTOGRAM },
  { name: "scatter", title: "Canvas scatter", about: "Two numeric fields/genes on a <canvas>; selected cells highlighted; reacts to selection + theme.", techniques: ["canvas 2d + DPR", "data('numeric'/'expr')", "data('selectedCells')", "react to coord+theme"], source: SCATTER },
  { name: "heatmap", title: "Expression heatmap", about: "Mean expression of a gene set across a grouping's groups, with a sequential colour scale.", techniques: ["table grid", "per-group means", "colour ramp", "data('category')+data('expr')"], source: HEATMAP },
  { name: "donut", title: "Proportions donut", about: "Donut chart of a categorical field's proportions (SVG arc paths) with a legend.", techniques: ["SVG arc paths", "data('categories')", "themed palette"], source: DONUT },
  { name: "selection-breakdown", title: "Selection breakdown", about: "Live analytic: breaks the CURRENT selection down by a chosen field — reacts to selections from any panel.", techniques: ["data('selectedCells')", "tally by category", "react to coord"], source: SELECTION_BREAKDOWN },
  { name: "selection-markers", title: "Selection marker genes", about: "Top MARKER genes for whatever is selected in any panel — reacts to the selection and ranks via data('rankGenes') (DE vs rest, ONE fast call). The right pattern for 'top/marker genes for the selection' — never loop per-gene expr or rank by raw mean. Adapt the bar list / count.", techniques: ["react to coord.selection", "data('rankGenes')", "SVG bars", "re-entrancy guard"], source: SELECTION_MARKERS },
];

// The full registry: complete widgets to adapt + reusable snippets to inline.
const ALL: WidgetRecipe[] = RECIPES.map((r) => ({ ...r, kind: r.kind || "widget" })).concat(SNIPPETS);

type RecipeMeta = { name: string; kind: "widget" | "snippet"; title: string; about: string; techniques: string[] };
const meta = (r: WidgetRecipe): RecipeMeta => ({ name: r.name, kind: (r.kind || "widget") as "widget" | "snippet", title: r.title, about: r.about, techniques: r.techniques });

export function listRecipes(): RecipeMeta[] { return ALL.map(meta); }

// LOOK UP recipes/snippets by free-text need (e.g. "scatter hover", "colour scale", "histogram") — ranked by token
// overlap with name/title/about/techniques. Returns metadata; call getRecipe(name) to DELIVER the source to inline.
export function findRecipes(query: string, limit = 6): RecipeMeta[] {
  const toks = String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (!toks.length) return ALL.map(meta);
  const scored = ALL.map((r) => {
    const hay = (r.name + " " + r.title + " " + r.about + " " + r.techniques.join(" ")).toLowerCase();
    let s = 0; for (const t of toks) { if (r.name.toLowerCase().includes(t)) s += 3; else if (hay.includes(t)) s += 1; }
    return { r, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => meta(x.r));
}

// The RAW runnable source for a recipe/snippet (no header comment) — used to SEED an authoring session from a recipe
// so the agent edits it instead of re-emitting the whole body (the dominant authoring cost; see the proxy agent log).
export function recipeSource(name: string): string | null {
  const r = ALL.find((x) => x.name === (name || "").trim());
  return r ? r.source : null;
}
export function getRecipe(name: string): string | null {
  const r = ALL.find((x) => x.name === (name || "").trim());
  if (!r) return null;
  const head = (r.kind === "snippet")
    ? `// SNIPPET "${r.name}" — ${r.title}: ${r.about}\n// Paste these helpers into your widget and call them; self-contained + themed.\n`
    : `// RECIPE "${r.name}" — ${r.title}: ${r.about}\n// Techniques: ${r.techniques.join(", ")}\n// Adapt freely (fields/genes/styling); keep it self-contained + themed via var(--*).\n`;
  return head + r.source;
}
