// EXAMPLE external panel module — the reference for an installable / external-authored panel. It proves the panel
// registry (P1): a panel TYPE defined ENTIRELY OUTSIDE panels.ts that self-registers (registerPanelType) and works
// end-to-end — renders, is agent-addable, answers describe_panel — with ZERO edits to bodyFor / the agent's type list.
// The only "install" step is importing this module (main.ts), exactly as loading a plugin would be. A read-only
// dataset summary; harmless + genuinely handy, and the template for richer external panels.
import { mk } from "./dom.ts";
import { registerPanelType } from "./panel-registry.ts";

registerPanelType({
  type: "DatasetInfo",
  agent: true,
  title: "Dataset info",
  body: (_p: any, ctx: any) => {
    const el = mk("div");
    el.style.cssText = "position:absolute;inset:0;overflow:auto;padding:14px;font-size:12.5px;line-height:1.8";
    const cats: string[] = ctx.categoricalFields ? ctx.categoricalFields() : [];
    const fields: { name: string; kind: string }[] = ctx.metadataFields ? ctx.metadataFields() : [];
    const numerics = fields.filter((f) => f.kind === "numeric").map((f) => f.name);
    const embs: string[] = ctx.embeddings ? [...ctx.embeddings.keys()] : [];
    const groupings: string[] = ctx.groupings ? ctx.groupings() : [];
    const faint = (s: string) => `<span style="color:var(--faint)">${s}</span>`;
    const row = (k: string, v: string) => `<div style="display:flex;gap:10px"><span style="color:var(--faint);min-width:130px">${k}</span><span>${v}</span></div>`;
    el.innerHTML =
      row("cells", `<b>${(ctx.n || 0).toLocaleString()}</b>`) +
      row("categorical fields", `<b>${cats.length}</b> ${faint(cats.slice(0, 10).join(", "))}`) +
      row("numeric fields", `<b>${numerics.length}</b> ${faint(numerics.slice(0, 10).join(", "))}`) +
      row("groupings", `<b>${groupings.length}</b> ${faint(groupings.slice(0, 10).join(", "))}`) +
      row("embeddings", `<b>${embs.length}</b> ${faint(embs.join(", "))}`);
    return { el };
  },
});
