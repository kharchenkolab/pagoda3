import { openLstar, fetchStore } from "./data/store.ts";
import { LstarView } from "./data/view.ts";
import { Coord } from "./data/coord.ts";
import { Ctx } from "./data/ctx.ts";
import { App } from "./ui/shell.ts";
import { getProvider, PROVIDER_KEY, type Provider } from "./agent/providers.ts";

const storeParam = new URLSearchParams(location.search).get("store") || "/sample.lstar.zarr/";
const STORE_URL = new URL(storeParam.endsWith("/") ? storeParam : storeParam + "/", location.origin).href;

async function boot() {
  const ds = await openLstar(fetchStore(STORE_URL));
  const view = new LstarView(ds);
  const coord = new Coord();
  const ctx = new Ctx(view, coord);
  await ctx.init();
  const app = new App(ctx);
  await app.mount(document.getElementById("app")!);
  // Dev switch between the Anthropic agent and the local OpenAI-compatible model (vLLM/qwen3). No UI — flip it from
  // the console: p2.setProvider("openai"). getProvider() is read at the start of every ask, so the NEXT ask uses it
  // (no reload needed). See web/src/agent/providers.ts.
  const setProvider = (p: Provider) => { try { localStorage.setItem(PROVIDER_KEY, p === "openai" ? "openai" : "anthropic"); } catch { /* */ } return "agent provider → " + getProvider() + " (applies on next ask)"; };
  (window as any).p2 = { ds, view, coord, ctx, app, getProvider, setProvider };
}

boot().catch((e) => {
  console.error(e);
  document.getElementById("app")!.innerHTML = `<pre style="color:#e07a7a;padding:20px;white-space:pre-wrap">${e?.stack || e}</pre>`;
});
