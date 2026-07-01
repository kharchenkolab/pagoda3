import { openLstar, HttpStore } from "./data/store.ts";
import type { LstarStore } from "./data/store.ts";
import { localStore } from "./data/localstore.ts";
import { installOpenLocal } from "./ui/openlocal.ts";
import { showLoading, setLoadingStatus, hideLoading, showLoadError, beginChecklist, setStep, finishChecklist, type OpenProgress } from "./ui/loading.ts";
import { LstarView } from "./data/view.ts";
import { Coord } from "./data/coord.ts";
import { Ctx } from "./data/ctx.ts";
import { App } from "./ui/shell.ts";
import { getProvider, PROVIDER_KEY, type Provider } from "./agent/providers.ts";
import { ComputePool } from "./compute/pool.ts";
import "./ui/example-panel.ts";   // an EXTERNAL panel module that self-registers (proves the panel registry — zero core edits)

// store precedence: an explicit ?store= wins; else a <meta name="pagoda3:store"> baked into the page
// (pagoda3.publish writes this so a published folder opens at a CLEAN bare URL — no ?store= tail); else
// the base-aware demo default so the bare dev/deploy URL still self-loads real.lstar.zarr.
const metaStore = (document.querySelector('meta[name="pagoda3:store"]') as HTMLMetaElement | null)?.content;
const storeParam = new URLSearchParams(location.search).get("store") || metaStore || ((((import.meta as any).env?.BASE_URL) as string) || "/") + "real.lstar.zarr/";
// resolve against the full document URL (not just origin) so a RELATIVE ?store=store/ works when the
// app is hosted under a subpath (e.g. a published folder at https://host/myshare/ — Phase 3b); an
// absolute ?store=https://… still wins, and a root-absolute /path/ still resolves against the origin.
const STORE_URL = new URL(storeParam.endsWith("/") ? storeParam : storeParam + "/", location.href).href;

// pools of the CURRENT dataset — disposed when we re-init onto a new one (open a local file)
let _pools: ComputePool[] = [];

// Build the whole stack (reader → view → coord → ctx → app) around `store` and mount it. Called once
// for the URL/meta store, and again to swap in a dropped local file (Phase 4) — re-init disposes the
// old workers + finalizes the old app so nothing keeps ticking against the replaced DOM.
async function bootStore(store: LstarStore, opts: { applyLinks?: boolean } = {}) {
  // open + prepare the NEW dataset first, while the old app/pools are still alive — only tear the old
  // ones down once the new one is ready (no race against dispose; no blank screen if the open fails).
  const oldPools = _pools;
  const oldApp = (window as any).p2?.app;
  _pools = [];

  const ds = await openLstar(store as any);   // byte-range fast path + consolidated `.zmetadata` open
  const view = new LstarView(ds);
  // persisted user compute settings: per-side DE/HVG sample caps (approx ranking) + the read-cache memory budget.
  // Console: p2.setCompute({deCap:800, hvgCap:3000, cacheBudgetMB:512}). Lower caps = faster/cheaper, coarser ranking.
  try {
    const s = JSON.parse(localStorage.getItem("p2-compute") || "{}");
    view.setSampleCaps({ de: s.deCap, hvg: s.hvgCap });
    if (s.cacheBudgetMB != null) ds.setReadCacheBudget(Math.max(0, s.cacheBudgetMB) * 1048576);
  } catch { /* defaults */ }
  const setCompute = (s: { deCap?: number; hvgCap?: number; cacheBudgetMB?: number }) => {
    view.setSampleCaps({ de: s.deCap, hvg: s.hvgCap });
    if (s.cacheBudgetMB != null) ds.setReadCacheBudget(Math.max(0, s.cacheBudgetMB) * 1048576);
    try { const cur = JSON.parse(localStorage.getItem("p2-compute") || "{}"); localStorage.setItem("p2-compute", JSON.stringify({ ...cur, ...s })); } catch { /* */ }
    return { deCap: view.deCap, hvgCap: view.hvgCap, cacheBudgetMB: Math.round(((ds as any).readCacheStats?.().budget || 0) / 1048576) };
  };
  const computePool = new ComputePool();   // off-main-thread kernel pool; view dispatches to it when cross-origin isolated, else runs the same core inline
  _pools.push(computePool);
  view.setComputePool(computePool);
  if (computePool.isolated) void computePool.ping().catch(() => { /* worker warm-up is best-effort; kernels fall back to the main thread */ });   // spawn + warm the worker at boot so the first real compute isn't cold
  const coord = new Coord();
  const ctx = new Ctx(view, coord);
  await ctx.init();
  // The default colour is `meta:leiden`; if this dataset has no `leiden` field (a dropped .h5ad may have
  // `louvain`, or anything), fall back to a categorical it DOES have — before mount, so the embedding panel
  // renders with the right field selected. A valid colour, or one a session will restore, is left as-is.
  try {
    const cb = coord.state.colorBy, mf = cb.startsWith("meta:") ? cb.slice(5) : "";
    const cats = ctx.categoricalFields();
    if (mf && !cats.includes(mf)) { const target = cats.includes(ctx.defaultGrouping()) ? ctx.defaultGrouping() : cats[0]; if (target) coord.setColor("meta:" + target); }
  } catch { /* */ }
  // the new dataset is read + prepared — now retire the old one (its workers + deck) and take over #app
  for (const p of oldPools) { try { p.dispose(); } catch { /* */ } }
  try { oldApp?.dispose?.(); } catch { /* */ }
  const app = new App(ctx);
  const widgetPool = new ComputePool();   // S5: untrusted widget runCompute code runs in its OWN workers (separate from the app kernel pool), with kernels over the shared SAB
  _pools.push(widgetPool);
  app.widgetPool = widgetPool;
  if (widgetPool.isolated) void widgetPool.ping().catch(() => { /* best-effort warm */ });
  await app.mount(document.getElementById("app")!);
  // Phase 3a deep-links: an explicit ?view= (compact, inline) or ?session=<url> (full, fetched) reopens
  // a shared view — applied AFTER mount so it overrides the auto-restored local session. Only on the
  // first (URL) boot — a freshly dropped local dataset has no link to apply.
  if (opts.applyLinks) {
    const params = new URLSearchParams(location.search);
    const sessionUrl = params.get("session"), viewTok = params.get("view");
    if (sessionUrl) await app.applySessionUrl(new URL(sessionUrl, location.href).href).catch(() => {});
    else if (viewTok) await app.applyViewLink(viewTok).catch(() => {});
  }
  // Dev switch between the Anthropic agent and the local OpenAI-compatible model (vLLM/qwen3). No UI — flip it from
  // the console: p2.setProvider("openai"). getProvider() is read at the start of every ask, so the NEXT ask uses it
  // (no reload needed). See web/src/agent/providers.ts.
  const setProvider = (p: Provider) => { try { localStorage.setItem(PROVIDER_KEY, p === "openai" ? "openai" : "anthropic"); } catch { /* */ } return "agent provider → " + getProvider() + " (applies on next ask)"; };
  // Phase 4: open a local store (a dropped/picked .zip, a folder handle, or a webkitdirectory FileList)
  // by re-initing the whole app onto it — no server, nothing uploaded.
  const openLocal = async (input: any, opts: { force?: boolean } = {}) => {
    const title = input?.name || (input?.[0]?.webkitRelativePath || "").split("/")[0] || "dataset";
    const ac = new AbortController();
    let carded = false;                                  // upgrades small → checklist card the moment real work is reported
    showLoading(title);
    const progress: OpenProgress = {
      stage: (m) => setLoadingStatus(m),
      step: (id, label, status, detail) => {
        if (!carded) { carded = true; beginChecklist("Opening " + title, "Preparing this dataset for viewing", () => ac.abort()); }
        setStep(id, label, status, detail);
      },
      signal: ac.signal,
    };
    const logLoad = (label: string, notes?: string) => { try { (window as any).p2?.app?.checkpoint?.("opened " + label, "Read locally in your browser — nothing was uploaded. " + (notes || "")); } catch { /* */ } };
    try {
      const { store: ls, label, notes } = await localStore(input, progress, opts);
      progress.stage("Opening viewer…");
      await bootStore(ls);
      if (carded) {                                      // a real preparation happened → let the user review the checklist, then click Open
        logLoad(label, notes);
        finishChecklist(() => { try { (window as any).p2?.app?.toast?.("Opened " + label, notes || ""); } catch { /* */ } });
      } else {                                           // trivial open → just dismiss the small panel
        hideLoading();
        logLoad(label, notes);
        try { (window as any).p2?.app?.toast?.("Opened " + label, notes || "Read locally — nothing was uploaded."); } catch { /* */ }
      }
    } catch (e: any) {
      if (ac.signal.aborted || e?.aborted) { hideLoading(); return; }   // user cancelled → silent; the previous dataset is untouched (bootStore never ran)
      // a soft (overridable) guardrail — e.g. the cell-count gate — offers a "Try it anyway" that re-runs forced
      const retry = (e?.overridable && !opts.force) ? { label: "Try it anyway", run: () => void openLocal(input, { force: true }) } : undefined;
      showLoadError(title, String(e?.message || e), retry);   // surface the real reason instead of failing silently
    }
  };
  // Session-wide "ignore these genes" filter (off by default). Applies to markers/DE/variable-genes RANKINGS
  // only — NOT QC measures or gene-set scores. p2.setGeneFilter(["MT-","RPS","RPL"]); p2.setGeneFilter([]) clears.
  const setGeneFilter = async (patterns: string[]) => {
    await view.setGeneFilter(patterns || []);
    try { (app as any).fullRender?.(); (app as any).scheduleSave?.(); } catch { /* */ }
    return `gene filter: ${view.geneFilterPatterns().join(", ") || "(none)"} — ${view.excludedGeneCount()} genes ignored in markers / DE / variable-genes`;
  };
  (window as any).p2 = { ds, view, coord, ctx, app, getProvider, setProvider, setCompute, computePool, widgetPool, openLocal, setGeneFilter };
  return app;
}

async function boot() {
  await bootStore(new HttpStore(STORE_URL), { applyLinks: true });
  installOpenLocal((input) => (window as any).p2.openLocal(input));   // drag a .lstar.zarr(.zip) anywhere to open it
}

boot().catch((e) => {
  console.error(e);
  document.getElementById("app")!.innerHTML = `<pre style="color:#e07a7a;padding:20px;white-space:pre-wrap">${e?.stack || e}</pre>`;
});
