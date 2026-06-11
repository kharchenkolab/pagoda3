import { openLstar, fetchStore } from "./data/store.ts";
import { LstarView } from "./data/view.ts";
import { Coord } from "./data/coord.ts";
import { Ctx } from "./data/ctx.ts";
import { App } from "./ui/shell.ts";

const STORE_URL = new URL("/sample.lstar.zarr/", location.origin).href;

async function boot() {
  const ds = await openLstar(fetchStore(STORE_URL));
  const view = new LstarView(ds);
  const coord = new Coord();
  const ctx = new Ctx(view, coord);
  await ctx.init();
  const app = new App(ctx);
  await app.mount(document.getElementById("app")!);
  (window as any).p2 = { ds, view, coord, ctx, app };
}

boot().catch((e) => {
  console.error(e);
  document.getElementById("app")!.innerHTML = `<pre style="color:#e07a7a;padding:20px;white-space:pre-wrap">${e?.stack || e}</pre>`;
});
