import { openLstar, storeForUrl } from "./data/store.ts";
import type { LstarStore } from "./data/store.ts";
import { localStore } from "./data/localstore.ts";
import { installOpenLocal } from "./ui/openlocal.ts";
import { showLoading, setLoadingStatus, hideLoading, showLoadError, beginChecklist, setStep, finishChecklist, showPicker, type OpenProgress } from "./ui/loading.ts";
import { finalizeSpec, storeToSpec } from "./data/intake.ts";
import { invalidateColor, colorsFor } from "./render/colors.ts";
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
// a `.zip` store (a range-read `*.lstar.zarr.zip`) is a FILE, not a directory — don't append a trailing "/".
const isZipStore = /\.zip($|\?)/i.test(storeParam);
const STORE_URL = new URL(isZipStore || storeParam.endsWith("/") ? storeParam : storeParam + "/", location.href).href;

// pools of the CURRENT dataset — disposed when we re-init onto a new one (open a local file)
let _pools: ComputePool[] = [];

// True once the ACTIVE dataset came from a local file (openLocal) — an in-memory store with no URL to re-fetch it and
// no persistable File handle, so a reload/close silently drops it. A `?store=` / default dataset re-loads identically
// on reload, so it's NOT guarded. Used by the beforeunload guard installed in boot().
let localDatasetOpen = false;

// The first-paint splash (index.html #boot) covers the cold-start bundle download + the initial store read so
// a slow open isn't a blank dark screen. We advance its status line during the open, then retire it once the
// app is up (or a checklist card / error overlay has taken over). Idempotent + null-safe (it's gone after the
// first open, and absent in embed/test contexts).
const bootMsg = (m: string) => { const el = document.getElementById("boot-msg"); if (el) el.textContent = m; };
const bootBar = (pct: number) => { const f = document.querySelector<HTMLElement>("#boot-bar > i"); if (f) f.style.width = pct + "%"; };

// Counts in-flight store reads so the boot path can hold the splash until the first workspace's panels have
// actually READ their data — not just mounted. On a slow link the panels paint async (facets read a field per
// histogram, the dotplot reads its stats), so without this the layout reveals as empty frames while fields
// download. Wrapping at the STORE boundary keeps this general (covers whatever a workspace pulls) and modular
// (the boot path never learns panel specifics). `whenIdle` resolves once reads have been settled for `quietMs`
// (to bridge between read waves), capped so a genuinely stuck read can't hold the splash forever.
class TrackedStore {
  inflight = 0;
  get: (key: string) => Promise<Uint8Array | undefined>;
  getRange?: (key: string, start: number, end: number) => Promise<Uint8Array | undefined>;
  constructor(inner: LstarStore) {
    this.get = (k) => this.track(inner.get(k));
    if (inner.getRange) this.getRange = (k, a, b) => this.track(inner.getRange!(k, a, b));
  }
  private track<T>(p: Promise<T>): Promise<T> { this.inflight++; return p.finally(() => { this.inflight--; }); }
  async whenIdle(quietMs = 300, capMs = 45000): Promise<void> {
    const t0 = performance.now(); let quietSince = 0;
    for (;;) {
      if (performance.now() - t0 >= capMs) return;   // safety net — reveal rather than hang on a stuck read
      await new Promise((r) => setTimeout(r, 80));
      if (this.inflight === 0) { if (!quietSince) quietSince = performance.now(); else if (performance.now() - quietSince >= quietMs) return; }
      else quietSince = 0;
    }
  }
}
const dropBootSplash = () => { const b = document.getElementById("boot"); if (b) { bootBar(100); b.classList.add("hide"); setTimeout(() => b.remove(), 300); } };

// Build the whole stack (reader → view → coord → ctx → app) around `store` and mount it. Called once
// for the URL/meta store, and again to swap in a dropped local file (Phase 4) — re-init disposes the
// old workers + finalizes the old app so nothing keeps ticking against the replaced DOM.
async function bootStore(store: LstarStore, opts: { applyLinks?: boolean; freshSession?: boolean; progress?: OpenProgress; force?: boolean } = {}) {
  // open + prepare the NEW dataset first, while the old app/pools are still alive — only tear the old
  // ones down once the new one is ready (no race against dispose; no blank screen if the open fails).
  const oldPools = _pools;
  const oldApp = (window as any).p2?.app;
  _pools = [];

  invalidateColor();   // drop the module-level colour caches (metadata snapshots + winsor bounds) from the PREVIOUS dataset — a same-named field must not reuse the old cells' codes/bounds (the view-keying in md() is the primary guard; this also clears the numeric winsor cache)
  const tracked = new TrackedStore(store);   // count reads so we can hold the reveal until the first workspace's data lands (below)
  opts.progress?.stage("Reading the dataset…");
  let ds = await openLstar(tracked as any);   // byte-range fast path + consolidated `.zmetadata` open
  // A store with NO embedding (a bare convert_anndata output, or a dropped .lstar.zarr with only counts +
  // labels) can't be plotted as-is. Compute a default layout in-browser — the SAME QC → PCA → UMAP → Louvain
  // → markers pipeline a dropped .h5ad gets — driving the SAME load checklist (opts.progress) so the user is
  // informed and can cancel. Without this, ctx.init's embedding fallback throws an opaque zarrita error.
  if (ds.field("counts") && !ds.fieldNames().some((n: string) => (ds.field(n) as any)?.role === "embedding")) {
    opts.progress?.stage("No embedding in this store — reading counts to compute a layout…");   // immediate feedback (raises the card) before the counts read
    const spec = await storeToSpec(ds);
    const augmented = await finalizeSpec(spec, opts.progress, { force: opts.force });
    ds = await openLstar(augmented as any);
    store = augmented as any;
  }
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
  opts.progress?.stage("Reading the embedding…");   // the layout coords are the big read on a hosted open
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
  app.freshSession = !!opts.freshSession;   // a dropped local file starts CLEAN — never inherits the previous dataset's annotation/panels/results/chat (all dropped files share the "default" session slot; the fingerprint alone is too weak to tell two same-size files apart)
  const widgetPool = new ComputePool();   // S5: untrusted widget runCompute code runs in its OWN workers (separate from the app kernel pool), with kernels over the shared SAB
  _pools.push(widgetPool);
  app.widgetPool = widgetPool;
  if (widgetPool.isolated) void widgetPool.ping().catch(() => { /* best-effort warm */ });
  // Make the view READY before it's shown — not just mounted. The embedding panel `await`s colorsFor() (a
  // field-metadata read) before it can setColors, so on a slow link the canvas paints GREY, then recolours once
  // that read lands — after the splash has already lifted. Prime the default colour here (warms mdCache) so the
  // panel's own colorsFor() hits cache and the first paint is complete. Best-effort: a failure just falls back to
  // the progressive fill. (The layout coords were already read in ctx.init above.)
  opts.progress?.stage("Preparing the view…");
  try { await colorsFor(view, coord.state.colorBy); } catch { /* non-fatal — colour fills in as before */ }
  opts.progress?.stage("Rendering…");
  await app.mount(document.getElementById("app")!);
  // mount() only BUILDS the first workspace — its panels then read their fields async (facets: a field per
  // histogram; a dotplot: its stats). On a slow link that's the gap where the layout showed as empty frames.
  // Hold here until those reads settle (store idle), so the app is revealed with data, not skeletons. Capped so
  // a stuck read can't hang the splash; a same-origin/fast store settles in a tick, so this is a no-op there.
  opts.progress?.stage("Loading the workspace…");
  await tracked.whenIdle();
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
  const openLocal = async (input: any, opts: { force?: boolean; sample?: string } = {}) => {
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
      await bootStore(ls, { freshSession: true, progress, force: opts.force });   // deliberate new dataset → clean slate; `progress` lets a bare (embedding-less) dropped store compute its layout inside this same card
      localDatasetOpen = true;   // now on an in-memory local dataset → arm the reload guard (a reload can't re-open it)
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
      if (e?.pickTriplet && Array.isArray(e.samples)) {   // a folder with several samples → let the user choose, then re-open that one
        showPicker("This folder has several samples", "Pick the one to open", e.samples,
          (key) => void openLocal(input, { ...opts, sample: key }), () => hideLoading());
        return;
      }
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
  // The bare-URL / ?store= open is normally instant (a prepped store), so no card. But if the store has NO
  // embedding, bootStore computes a layout in-browser — surface that through the SAME load checklist (raised
  // lazily on the first progress event, so a prepped store still opens with no dialog), with a cancel and a
  // "compute it anyway" override for the cell-count gate.
  const title = decodeURIComponent(STORE_URL.replace(/\/+$/, "").split("/").pop() || "dataset");
  const openHosted = async (force: boolean) => {
    const ac = new AbortController();
    let carded = false;
    const onSplash = () => !!document.getElementById("boot");   // the first-paint splash is covering us (first open)
    // The splash's thin bar ratchets forward one notch per stage (Reading dataset → embedding → Rendering),
    // then dropBootSplash fills it to 100%. Monotonic + count-based, so it stays sensible regardless of the
    // exact stage messages or how many fire.
    let barStep = 0; const BAR = [16, 36, 56, 74, 90];
    const bumpBar = () => { bootBar(BAR[Math.min(barStep, BAR.length - 1)]); barStep++; };
    // A store with NO embedding computes a layout in-browser — that non-trivial work upgrades to the CHECKLIST
    // card (retiring the splash). A normal open never `step()`s, so it stays on the splash's status line.
    const raise = () => { if (!carded) { carded = true; dropBootSplash(); showLoading(title); beginChecklist("Opening " + title, "Preparing this dataset for viewing", () => ac.abort()); } };
    const progress: OpenProgress = {
      stage: (m) => { if (carded) return; if (onSplash()) { bootMsg(m); bumpBar(); } else setLoadingStatus(m); },   // advance the splash (first open) or the small overlay (a re-open, once the splash is gone)
      step: (id, label, status, detail) => { raise(); setStep(id, label, status, detail); },
      signal: ac.signal,
    };
    if (!onSplash()) showLoading(title, "Opening…");   // a retry/re-open after the splash is gone → give it its own spinner so a slow open still isn't blank
    try {
      const store = await storeForUrl(STORE_URL);   // a `.zip` URL → lstar's STORED range-read ZipStore (reads the central dir here); else the directory HttpStore
      await bootStore(store, { applyLinks: true, progress, force });
      if (carded) finishChecklist(() => { dropBootSplash(); });   // computed a layout → let the user review the checklist, then Open reveals the app
      else { hideLoading(); dropBootSplash(); }   // normal open → reveal the app (retire the splash / small overlay)
    } catch (e: any) {
      dropBootSplash();
      if (ac.signal.aborted || e?.aborted) { showLoadError(title, "Cancelled — this store has no embedding, so there is nothing to display.", { label: "Retry", run: () => void openHosted(false) }); return; }
      const retry = (e?.overridable && !force) ? { label: "Compute it anyway", run: () => void openHosted(true) } : undefined;
      console.error(e);
      // lstar's ZipStore errors already say the fix (repack STORED / check the URL) but can't know pagoda3's
      // escape hatch — a hosted .zip that won't open can always be dragged in to read locally. Add that hint.
      const hint = isZipStore ? " — or drag the .lstar.zarr.zip into the page to open it locally." : "";
      showLoadError(title, String(e?.message || e) + hint, retry);
    }
  };
  await openHosted(false);
  installOpenLocal((input) => (window as any).p2.openLocal(input));   // drag a .lstar.zarr(.zip) anywhere to open it
  // Reload/close silently drops an in-memory LOCAL dataset (no URL to re-fetch, the File is gone) — warn before that
  // happens, but ONLY for a local dataset (a `?store=`/default dataset re-loads identically, so no nag there). The
  // browser shows its own generic "Leave site? / Reload site?" confirmation; the returned string is ignored by modern
  // browsers but still required to trigger the prompt.
  window.addEventListener("beforeunload", (e) => { if (!localDatasetOpen) return; e.preventDefault(); e.returnValue = ""; });
}

boot().catch((e) => {
  console.error(e);
  dropBootSplash();   // a top-level failure — retire the splash so the error is visible, not hidden behind it
  document.getElementById("app")!.innerHTML = `<pre style="color:#e07a7a;padding:20px;white-space:pre-wrap">${e?.stack || e}</pre>`;
});
