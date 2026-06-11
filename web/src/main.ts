import { openLstar, fetchStore } from "./data/store.ts";
import { LstarView } from "./data/view.ts";
import { Coord } from "./data/coord.ts";
import { EmbeddingView } from "./render/embedding.ts";
import { colorsFor, focusMaskFor } from "./render/colors.ts";

const STORE_URL = new URL("/sample.lstar.zarr/", location.origin).href;

async function boot() {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="top">
      <div class="logo">pagoda<span>2</span></div>
      <div class="spacer"></div>
      <label class="ctl">color
        <select id="colorBy"></select>
      </label>
      <input id="geneInput" class="ctl gene" placeholder="gene… (e.g. IL6)" />
      <span id="status" class="status"></span>
    </div>
    <div class="stage"><div id="emb" class="embwrap"></div></div>
    <div id="legend" class="legend"></div>`;

  const status = document.getElementById("status")!;
  status.textContent = "loading store…";
  const ds = await openLstar(fetchStore(STORE_URL));
  const view = new LstarView(ds);
  const { data: emb, n } = await view.embedding("umap");
  status.textContent = `${n.toLocaleString()} cells · ${view.nGenes.toLocaleString()} genes`;

  const embView = new EmbeddingView(document.getElementById("emb")!, emb, n);
  const coord = new Coord();

  // populate colorBy options from available label/qc/geneset fields
  const sel = document.getElementById("colorBy") as HTMLSelectElement;
  const opts: [string, string][] = [];
  for (const [name, m] of ds.fields) {
    if (m.role === "label" && m.span.length === 1) opts.push([`meta:${name}`, name === "cell_type" ? "cell type" : name]);
  }
  if (ds.hasField("mito")) opts.push(["qc:mito", "mito %"]);
  if (ds.hasField("n_gene")) opts.push(["qc:n_gene", "genes/cell"]);
  for (const a of await ds.axisLabels("aspects").catch(() => [])) opts.push([`geneset:${a}`, a]);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  sel.value = coord.state.colorBy;
  sel.onchange = () => coord.setColor(sel.value);

  const geneInput = document.getElementById("geneInput") as HTMLInputElement;
  geneInput.onchange = async () => {
    const g = geneInput.value.trim();
    if (!g) return;
    if ((await view.geneCol(g)) === undefined) { status.textContent = `no gene "${g}"`; return; }
    coord.setColor(`gene:${g}`);
  };

  embView.onSelect = (ids) => { coord.setSelection(ids); };

  const legendEl = document.getElementById("legend")!;
  async function repaint() {
    const c = coord.state;
    const mask = await focusMaskFor(view, c.focus, n);
    const { rgba, legend } = await colorsFor(view, c.colorBy, mask);
    embView.setColors(rgba);
    embView.setSelection(c.selection);
    sel.value = c.colorBy.startsWith("meta:") || c.colorBy.startsWith("qc:") || c.colorBy.startsWith("geneset:") ? c.colorBy : sel.value;
    legendEl.innerHTML = `<span class="lt">${legend.title}</span>` +
      legend.items.map((it) => `<span class="li"><span class="sw" style="background:rgb(${it.rgb.join(",")})"></span>${it.label}</span>`).join("");
    status.textContent = `${n.toLocaleString()} cells` + (c.selection ? ` · ${c.selection.length} selected` : "");
  }
  coord.subscribe(() => { repaint(); });
  await repaint();

  (window as any).p2 = { ds, view, coord, embView }; // debug handle
}

boot().catch((e) => {
  console.error(e);
  document.getElementById("app")!.innerHTML = `<pre style="color:#e07a7a;padding:20px;white-space:pre-wrap">${e?.stack || e}</pre>`;
});
