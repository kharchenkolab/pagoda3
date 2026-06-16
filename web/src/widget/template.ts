// Starter widget sources the agent adapts. The kitchen-sink exercises every contract capability — theme-aware
// styling, reading coord, writing back (setSelection/setColor), pulling data on demand, a header control, and a
// little SVG — so the agent can copy the patterns and replace the body with the asked-for behaviour.

export const BLANK_TEMPLATE = `// minimal widget — replace the body. Use var(--*) for colours so it themes.
const root = document.body;
root.innerHTML = '<div class="pg-row"><b>hello</b></div>';
pagoda.on('coord', c => { /* react to selection/colour changes */ });
pagoda.ready({ title: 'My widget' });
`;

export const KITCHEN_SINK = `// Kitchen-sink widget — demonstrates the full contract. Adapt freely.
const root = document.body;
root.innerHTML = \`
  <div class="pg-row"><label>colour by
    <select id="cb"><option value="meta:cell_type">cell type</option><option value="meta:leiden">leiden</option><option value="qc:mito">mito %</option></select>
  </label></div>
  <div class="pg-row"><label>gene <input id="gene" placeholder="type a gene… ↵" style="width:120px"></label><span id="genemean" class="pg-muted"></span></div>
  <div class="pg-row"><label>threshold <input id="thr" type="range" min="0" max="100" value="50" style="width:120px"></label><span id="thrv">50</span></div>
  <div class="pg-row"><button id="selnk">select a value</button> <button id="clear">clear</button></div>
  <div id="cur" class="pg-muted" style="margin:6px 0"></div>
  <div class="pg-muted" style="margin-top:6px">composition</div>
  <svg id="bars" width="100%" height="70" style="display:block"></svg>
\`;

// --- write back into the coordination space ---
root.querySelector('#cb').onchange = (e) => pagoda.setColor(e.target.value);
root.querySelector('#gene').onkeydown = async (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const g = e.target.value.trim(); pagoda.setColor('gene:' + g);
  try { const v = await pagoda.data('expr', { gene: g }); let s = 0; for (let i = 0; i < v.length; i++) s += v[i];
    root.querySelector('#genemean').textContent = '· mean ' + (s / v.length).toFixed(2); }
  catch (err) { root.querySelector('#genemean').textContent = '· ' + err.message; }
};
const thr = root.querySelector('#thr');
thr.oninput = () => { root.querySelector('#thrv').textContent = thr.value; };
root.querySelector('#clear').onclick = () => pagoda.setSelection(null);

// --- pull data: list fields, pick the first categorical, draw its composition + wire the select button ---
let field = 'cell_type', firstValue = null;
(async () => {
  try {
    const f = await pagoda.data('fields'); field = (f.categorical && f.categorical[0]) || field;
    const c = await pagoda.data('categories', { field });
    const max = Math.max(1, ...c.counts), n = c.categories.length, w = 100 / n;
    const svg = root.querySelector('#bars');
    svg.innerHTML = c.categories.map((name, i) => {
      const h = (c.counts[i] / max) * 60; const col = 'var(--cyan,#1f7faf)';
      return '<rect x="' + (i * w) + '%" y="' + (64 - h) + '" width="' + (w - 1) + '%" height="' + h + '" fill="' + col + '"><title>' + name + ': ' + c.counts[i] + '</title></rect>';
    }).join('');
    firstValue = c.categories[0];
    root.querySelector('#selnk').textContent = 'select "' + firstValue + '"';
    root.querySelector('#selnk').onclick = () => pagoda.setSelection({ category: { grouping: field, value: firstValue } });
  } catch (err) { console.error('data error', err.message); }
})();

// --- react to coordination changes (also fires once on init) ---
pagoda.on('coord', (c) => {
  const sel = c.selection ? (c.selection.value || (c.selection.ids ? c.selection.ids.length + ' cells' : 'set')) : 'none';
  root.querySelector('#cur').textContent = 'colour: ' + c.colorBy + ' · selection: ' + sel;
  const cb = root.querySelector('#cb'); if ([...cb.options].some(o => o.value === c.colorBy)) cb.value = c.colorBy;
});
pagoda.on('control', (id) => { if (id === 'reset') { pagoda.setSelection(null); thr.value = 50; root.querySelector('#thrv').textContent = '50'; } });

pagoda.ready({ title: 'Kitchen sink', controls: [{ id: 'reset', label: 'reset' }] });
`;

export function getWidgetTemplate(kind?: string): string {
  return kind === "blank" ? BLANK_TEMPLATE : KITCHEN_SINK;
}
