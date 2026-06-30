import { openLstar, HttpStore } from "./data/store.ts";
import { LstarView } from "./data/view.ts";
import { Coord } from "./data/coord.ts";
import { Ctx } from "./data/ctx.ts";
import { App } from "./ui/shell.ts";
import { getProvider, PROVIDER_KEY, type Provider } from "./agent/providers.ts";
import { ComputePool } from "./compute/pool.ts";
import "./ui/example-panel.ts";   // an EXTERNAL panel module that self-registers (proves the panel registry — zero core edits)

const storeParam = new URLSearchParams(location.search).get("store") || ((((import.meta as any).env?.BASE_URL) as string) || "/") + "real.lstar.zarr/";   // base-aware so the bare URL self-loads a real demo store under a subpath deploy (e.g. /peterk/pagoda3/)
const STORE_URL = new URL(storeParam.endsWith("/") ? storeParam : storeParam + "/", location.origin).href;

async function boot() {
  const ds = await openLstar(new HttpStore(STORE_URL));   // byte-range fast path + consolidated `.zmetadata` open
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
  view.setComputePool(computePool);
  if (computePool.isolated) void computePool.ping().catch(() => { /* worker warm-up is best-effort; kernels fall back to the main thread */ });   // spawn + warm the worker at boot so the first real compute isn't cold
  const coord = new Coord();
  const ctx = new Ctx(view, coord);
  await ctx.init();
  const app = new App(ctx);
  const widgetPool = new ComputePool();   // S5: untrusted widget runCompute code runs in its OWN workers (separate from the app kernel pool), with kernels over the shared SAB
  app.widgetPool = widgetPool;
  if (widgetPool.isolated) void widgetPool.ping().catch(() => { /* best-effort warm */ });
  await app.mount(document.getElementById("app")!);
  // Phase 3a deep-links: an explicit ?view= (compact, inline) or ?session=<url> (full, fetched) reopens
  // a shared view — applied AFTER mount so it overrides the auto-restored local session for this store.
  const params = new URLSearchParams(location.search);
  const sessionUrl = params.get("session"), viewTok = params.get("view");
  if (sessionUrl) await app.applySessionUrl(new URL(sessionUrl, location.href).href).catch(() => {});
  else if (viewTok) await app.applyViewLink(viewTok).catch(() => {});
  // Dev switch between the Anthropic agent and the local OpenAI-compatible model (vLLM/qwen3). No UI — flip it from
  // the console: p2.setProvider("openai"). getProvider() is read at the start of every ask, so the NEXT ask uses it
  // (no reload needed). See web/src/agent/providers.ts.
  const setProvider = (p: Provider) => { try { localStorage.setItem(PROVIDER_KEY, p === "openai" ? "openai" : "anthropic"); } catch { /* */ } return "agent provider → " + getProvider() + " (applies on next ask)"; };
  (window as any).p2 = { ds, view, coord, ctx, app, getProvider, setProvider, setCompute, computePool, widgetPool };
}

boot().catch((e) => {
  console.error(e);
  document.getElementById("app")!.innerHTML = `<pre style="color:#e07a7a;padding:20px;white-space:pre-wrap">${e?.stack || e}</pre>`;
});
