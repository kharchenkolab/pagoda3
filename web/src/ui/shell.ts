import { mk } from "./dom.ts";
import { Ctx } from "../data/ctx.ts";
import { Coord, handleLabel } from "../data/coord.ts";
import { Panel, PanelHooks, bodyFor, paintEmbedding } from "./panels.ts";
import { EmbeddingView } from "../render/embedding.ts";
import { Agent, Scope } from "../agent/agent.ts";
import { checkLive } from "../agent/live.ts";

interface Checkpoint { i: number; q: string; why: string; state: any; }
interface WS { colorBy: string; panels: Partial<Panel>[]; }

const COLOR_OPTS: [string, string][] = [
  ["meta:leiden", "leiden"], ["meta:cell_type", "cell type"], ["meta:condition", "condition"],
  ["meta:sample", "sample"], ["qc:mito", "mito %"], ["gene:IL6", "IL6"], ["gene:CD3D", "CD3D"],
];

export class App {
  ctx: Ctx; coord: Coord; agent!: Agent;
  root: HTMLElement;
  canvas: Panel[] = []; rail: Panel[] = []; proposal: any = null;
  WS: Record<string, WS>; wsOrder: string[]; currentWS = "Overview";
  history: Checkpoint[] = []; viewing = -1; locked = false; uid = 0;
  embeddings: EmbeddingView[] = [];
  // presence
  thread: any = null; threadDocked = false; nudgePending: any = null; apTimer: any = null; apIndex = 0;
  scope: Scope | null = null; hot = 0; filtered: any[] = []; lastSelAnchor = { left: 0, top: 0 };
  proposalWhy = "";

  constructor(ctx: Ctx) {
    this.ctx = ctx; this.coord = ctx.coord;
    this.WS = {
      Overview: { colorBy: "meta:leiden", panels: [
        { type: "Embedding", title: "Embedding", cap: "all cells", bind: "embedding:main" },
        { type: "CompositionBars", title: "Composition by sample", cap: "by condition", bind: "composition:bySample" }] },
      "Markers": { colorBy: "meta:leiden", panels: [
        { type: "Embedding", title: "Embedding", cap: "clusters", bind: "embedding:main" },
        { type: "Heatmap", title: "Cluster marker heatmap", cap: "top genes × cluster", group: "leiden", full: true }] },
      "QC triage": { colorBy: "qc:mito", panels: [
        { type: "Embedding", title: "Embedding", cap: "mito fraction", bind: "embedding:main" },
        { type: "CompositionBars", title: "Composition", cap: "by sample", bind: "composition:bySample" }] },
      "Aspects": { colorBy: "geneset:Inflammatory response", panels: [
        { type: "Embedding", title: "Embedding", cap: "coloured by program", bind: "embedding:main" },
        { type: "Overdispersion", title: "Overdispersed programs", cap: "gene programs", bind: "aspect:overdispersion" }] },
    };
    this.wsOrder = Object.keys(this.WS);
    this.root = mk("div", "app");
  }

  async mount(parent: HTMLElement) {
    this.agent = new Agent(this);
    this.root.innerHTML = `
      <div class="top">
        <div class="logo">pagoda<span>2</span></div>
        <div class="wstabs" id="wstabs"></div>
        <div class="spacer"></div>
        <div class="tb pip" id="askBtn"><span class="dot"></span>Ask<span class="kbd">⌘K</span></div>
        <div class="tb" id="lockBtn">🔓 Layout</div>
        <div class="tb" id="railBtn">Answers</div>
      </div>
      <div class="stage">
        <div class="convo" id="convo"></div>
        <div class="canvas"><div class="workbench" id="workbench"></div></div>
        <div class="rail" id="rail"><div class="railhd"><span class="t">ANSWERS · DISPOSABLE</span><span class="x" id="railX">✕</span></div><div class="railbody" id="railbody"></div></div>
      </div>
      <div class="timeline" id="timeline">
        <div class="thread" id="thread"></div>
        <div class="tlhd" id="tlhd"><span class="t">HISTORY</span><span class="dockbtn" id="dockBtn">⇥ dock chat</span><span class="chev">▾</span></div>
        <div class="ckpts" id="ckpts"></div>
      </div>`;
    parent.innerHTML = "";
    parent.appendChild(this.root);
    // overlays
    for (const html of [`<div class="scrim" id="scrim"></div>`,
      `<div class="palette" id="palette"><div class="scope" id="scope" style="display:none"></div><input id="pin" placeholder="Ask, or describe what you want to see…"><div class="sugs" id="sugs"></div></div>`,
      `<div class="selpop" id="selpop"></div>`, `<div class="ctx" id="ctx"></div>`, `<div class="toasts" id="toasts"></div>`]) {
      const d = document.createElement("div"); d.innerHTML = html; document.body.appendChild(d.firstElementChild!);
    }
    this.wire();
    this.setPip("idle");
    this.switchWS("Overview", false);
    this.checkpoint("session start", "Baseline Overview workspace.");
    setTimeout(() => this.toast("Drag with Shift to select cells · ⌘K to ask · right-click a panel", null), 500);
    // connect the live Anthropic planner if the proxy + token are reachable
    checkLive().then((ok) => { this.agent.live = ok; if (ok) this.toast("Live agent connected · Opus", "The agent is the real Anthropic planner now — it drives the coordination space through tools, at the lowest sufficient rung."); });
    // boot nudge (Mode 5) from a real confound in the data
    setTimeout(() => this.agent.armBootNudge(), 2600);
  }

  $(id: string) { return document.getElementById(id)!; }

  // ---------- workbench ----------
  hooks(): PanelHooks {
    return {
      onGeneClick: (sym) => this.agent.coordinateGene(sym),
      onSelect: (ids, anchor) => { this.coord.setSelection(ids); this.lastSelAnchor = anchor; this.openSelpop(); },
      registerEmbedding: (ev) => this.embeddings.push(ev),
    };
  }

  async fullRender() {
    const wb = this.$("workbench");
    const old: Record<string, DOMRect> = {};
    wb.querySelectorAll<HTMLElement>(".panel[data-pid]").forEach((el) => (old[el.dataset.pid!] = el.getBoundingClientRect()));
    this.embeddings = [];
    wb.innerHTML = "";
    const afters: (() => void)[] = [];
    for (const p of this.canvas) { const { dom, afterAttach } = await this.panelEl(p); wb.appendChild(dom); if (afterAttach) afters.push(afterAttach); }
    // FLIP for surviving panels
    wb.querySelectorAll<HTMLElement>(".panel[data-pid]").forEach((el) => {
      const o = old[el.dataset.pid!]; if (!o) return; const n = el.getBoundingClientRect(); const dx = o.left - n.left, dy = o.top - n.top; if (!dx && !dy) return;
      el.style.animation = "none"; el.style.transition = "none"; el.style.transform = `translate(${dx}px,${dy}px)`;
      requestAnimationFrame(() => { el.style.transition = "transform .32s cubic-bezier(.2,.8,.2,1)"; el.style.transform = ""; });
    });
    afters.forEach((f) => f());
    await this.repaint();
    this.renderRail(); this.renderWS();
  }

  async panelEl(p: Panel): Promise<{ dom: HTMLElement; afterAttach?: () => void }> {
    const d = mk("div", "panel" + (p.full ? " full" : "") + (p.type === "Embedding" ? " embpanel" : ""));
    d.dataset.pid = String(p.id);
    const h = mk("div", "ph");
    const grip = mk("span", "grip", "⠿"); h.appendChild(grip);
    h.appendChild(Object.assign(mk("span", "pt"), { textContent: p.title }));
    if (p.cap) h.appendChild(Object.assign(mk("span", "pc"), { textContent: "· " + p.cap }));
    const sp = mk("div", "sp");
    if (p.type === "Embedding") {
      const s = document.createElement("select"); s.className = "inline";
      const cur = this.coord.state.colorBy;
      const opts = [...COLOR_OPTS]; if (!opts.find((o) => o[0] === cur)) opts.unshift([cur, handleLabel(cur)]);
      s.innerHTML = opts.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`).join("");
      s.onchange = () => this.coord.setColor(s.value);
      sp.appendChild(s);
    }
    const span = Object.assign(mk("button", "mini", p.full ? "◫" : "▦"), { title: "resize" }) as HTMLButtonElement;
    span.onclick = () => { p.full = !p.full; this.fullRender(); this.checkpoint((p.full ? "widen · " : "narrow · ") + p.title, "You resized a panel — the layout is yours to shape."); };
    const close = Object.assign(mk("button", "mini", "✕"), { title: "remove" }) as HTMLButtonElement;
    close.onclick = () => { this.canvas = this.canvas.filter((z) => z.id !== p.id); this.fullRender(); this.checkpoint("remove " + p.title, "You removed a panel — direct edits to your own layout always win."); };
    sp.appendChild(span); sp.appendChild(close);
    h.appendChild(sp); d.appendChild(h);
    const H = this.ctx.handleOf(p.bind);
    if (H?.caveat) { const cv = mk("div", "caveat"); cv.innerHTML = `<b>⚠ caveat</b><span>${H.caveat}</span>`; d.appendChild(cv); }
    const b = mk("div", "pbody");
    const built = await bodyFor(p, this.ctx, this.hooks());
    b.appendChild(built.el); d.appendChild(b);
    const prov = H?.prov || (this.ctx.handleOf(p.bind)?.prov);
    if (prov) d.appendChild(Object.assign(mk("div", "prov"), { textContent: "◆ " + prov }));
    // drag reorder
    h.setAttribute("draggable", "true");
    h.addEventListener("dragstart", (e) => { (this as any)._drag = p.id; (e as DragEvent).dataTransfer!.effectAllowed = "move"; d.classList.add("dragging"); });
    h.addEventListener("dragend", () => { (this as any)._drag = null; d.classList.remove("dragging"); document.querySelectorAll(".panel.dragover").forEach((x) => x.classList.remove("dragover")); });
    d.addEventListener("dragover", (e) => { const dr = (this as any)._drag; if (dr != null && dr !== p.id) { e.preventDefault(); d.classList.add("dragover"); } });
    d.addEventListener("dragleave", () => d.classList.remove("dragover"));
    d.addEventListener("drop", (e) => { e.preventDefault(); d.classList.remove("dragover"); this.reorder((this as any)._drag, p.id); });
    d.oncontextmenu = (e) => { e.preventDefault(); this.openCtx(e.clientX, e.clientY, p); };
    return { dom: d, afterAttach: built.afterAttach };
  }

  reorder(fromId: number, toId: number) {
    if (fromId == null || fromId === toId) return;
    const from = this.canvas.findIndex((z) => z.id === fromId), to = this.canvas.findIndex((z) => z.id === toId);
    if (from < 0 || to < 0) return; const [m] = this.canvas.splice(from, 1); this.canvas.splice(to, 0, m);
    this.fullRender(); this.checkpoint("reorder · " + m.title, "You dragged a panel — direct edits to your own layout always win.");
  }

  async repaint() { for (const ev of this.embeddings) await paintEmbedding(ev, this.ctx); this.$("railBtn").innerHTML = "Answers" + (this.rail.length ? ` <span class="badge">${this.rail.length}</span>` : ""); }

  newPanel(p: Partial<Panel>): Panel { return { id: ++this.uid, type: p.type!, title: p.title || p.type!, cap: p.cap, full: p.full, bind: p.bind, text: p.text, q: p.q, group: p.group, gene: p.gene, rows: p.rows }; }

  // ---------- rail ----------
  setRail(open: boolean) { this.$("rail").classList.toggle("open", open); }
  async renderRail() {
    const rb = this.$("railbody"); rb.innerHTML = "";
    if (this.proposal) {
      const d = mk("div", "rcard proposal");
      d.innerHTML = `<div class="rch"><span class="rt">NEEDS YOUR OK</span></div><div class="body"><h4>${this.proposal.title}</h4><div class="diff">${this.proposal.diff}</div></div>`;
      const acts = mk("div", "acts");
      const ap = mk("button", "apply", "Apply"); ap.onclick = () => { const lbl = this.proposal.label, fn = this.proposal.apply; this.proposal = null; fn(); this.checkpoint(lbl, this.proposalWhy); this.fullRender(); };
      const dc = mk("button", "dismiss", "Discard"); dc.onclick = () => { this.proposal = null; this.renderRail(); this.toast("Proposal discarded", "Your workbench is exactly as it was — proposals never change anything until you apply them."); };
      acts.appendChild(ap); acts.appendChild(dc); d.querySelector(".body")!.appendChild(acts); rb.appendChild(d);
    }
    for (const p of this.rail) {
      const d = mk("div", "rcard"); const h = mk("div", "rch");
      h.appendChild(Object.assign(mk("span", "rt"), { textContent: "EPHEMERAL" }));
      const sp = mk("div", "sp");
      const valid = this.agent.validate(p).ok;
      if (p.type !== "Note" && valid) { const pin = mk("button", "pin", "⤴ pin"); pin.onclick = () => { this.rail = this.rail.filter((z) => z.id !== p.id); this.canvas.push(this.newPanel(p)); this.fullRender(); if (!this.rail.length) this.setRail(false); this.checkpoint("pin " + p.title, "You promoted a disposable answer into your workbench — generation accretes only by your hand."); }; sp.appendChild(pin); }
      const ds = mk("button", "dismiss", "✕"); ds.onclick = () => { this.rail = this.rail.filter((z) => z.id !== p.id); this.renderRail(); this.repaint(); if (!this.rail.length && !this.proposal) this.setRail(false); };
      sp.appendChild(ds); h.appendChild(sp); d.appendChild(h);
      if (p.q) d.appendChild(Object.assign(mk("div", "rq"), { textContent: "“" + p.q + "”" }));
      const H = this.ctx.handleOf(p.bind);
      if (H?.caveat) { const cv = mk("div", "caveat"); cv.innerHTML = `<b>⚠ caveat</b><span>${H.caveat}</span>`; d.appendChild(cv); }
      const b = mk("div", "pbody"); const built = await bodyFor(p, this.ctx, this.hooks()); b.appendChild(built.el); d.appendChild(b);
      if (H?.prov) d.appendChild(Object.assign(mk("div", "prov"), { textContent: "◆ " + H.prov }));
      rb.appendChild(d); if (built.afterAttach) built.afterAttach();
    }
    if (this.rail.length || this.proposal) this.setRail(true);
    await this.repaint();
  }

  renderWS() {
    const t = this.$("wstabs"); t.innerHTML = "";
    for (const n of this.wsOrder) {
      const b = mk("span", "ws" + (n === this.currentWS ? " on" : ""), n);
      b.onclick = () => this.switchWS(n, true);
      b.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.openWsCtx(e.clientX, e.clientY, n); };
      t.appendChild(b);
    }
    const add = Object.assign(mk("span", "ws wsadd", "+"), { title: "save current layout" }); add.onclick = () => this.startSaveWS(); t.appendChild(add);
  }

  switchWS(name: string, user: boolean) {
    const ws = this.WS[name]; if (!ws) return;
    this.currentWS = name; this.coord.set({ colorBy: ws.colorBy, selection: null });
    this.canvas = ws.panels.map((p) => this.newPanel(p));
    this.fullRender();
    if (user) { this.toast("Switched to " + name, "A workspace is a named, reversible layout — your previous one is a step back in History."); this.checkpoint("workspace → " + name, "Deliberate workspace switch."); }
  }

  captureLayout(): Partial<Panel>[] { return this.canvas.map((p) => ({ type: p.type, title: p.title, cap: p.cap, full: p.full, bind: p.bind, group: p.group, gene: p.gene })); }
  startSaveWS() {
    const t = this.$("wstabs"); const inp = document.createElement("input"); inp.className = "wsinput"; inp.placeholder = "name workspace…"; t.appendChild(inp); inp.focus();
    let done = false; const commit = (ok: boolean) => { if (done) return; done = true; const name = inp.value.trim(); if (ok && name && !this.WS[name]) { this.WS[name] = { colorBy: this.coord.state.colorBy, panels: this.captureLayout() }; this.wsOrder.push(name); this.currentWS = name; this.renderWS(); this.checkpoint("save workspace · " + name, "You saved your current layout as a named workspace."); this.toast("Saved workspace “" + name + "”", null); } else this.renderWS(); };
    inp.onkeydown = (e) => { if (e.key === "Enter") commit(true); else if (e.key === "Escape") commit(false); }; inp.onblur = () => commit(true);
  }
  openWsCtx(x: number, y: number, n: string) {
    const c = this.$("ctx"); c.innerHTML = `<div class="it" data-a="dup">Duplicate</div><div class="it" data-a="update">Update to current layout</div>` + (this.wsOrder.length > 1 ? `<div class="it" data-a="del">Delete</div>` : "");
    c.style.left = Math.min(x, innerWidth - 190) + "px"; c.style.top = y + "px"; c.classList.add("show");
    c.querySelectorAll<HTMLElement>(".it").forEach((it) => it.onclick = () => { const a = it.dataset.a; c.classList.remove("show");
      if (a === "dup") { let nn = n + " copy", k = 2; while (this.WS[nn]) nn = n + " copy " + (k++); this.WS[nn] = { colorBy: this.WS[n].colorBy, panels: this.WS[n].panels.map((p) => ({ ...p })) }; this.wsOrder.splice(this.wsOrder.indexOf(n) + 1, 0, nn); this.renderWS(); }
      else if (a === "update") { this.WS[n].panels = this.captureLayout(); this.WS[n].colorBy = this.coord.state.colorBy; this.toast("Updated “" + n + "”", null); }
      else if (a === "del") { delete this.WS[n]; this.wsOrder = this.wsOrder.filter((z) => z !== n); if (this.currentWS === n) this.switchWS(this.wsOrder[0], false); else this.renderWS(); } });
  }

  // ---------- checkpoints ----------
  snap() { return { colorBy: this.coord.state.colorBy, focus: this.coord.state.focus, ws: this.currentWS, canvas: JSON.parse(JSON.stringify(this.canvas)), rail: JSON.parse(JSON.stringify(this.rail)) }; }
  checkpoint(q: string, why: string) { this.history.push({ i: this.history.length, q, why, state: this.snap() }); this.viewing = -1; this.renderSpine(); if (this.threadDocked) this.renderThread(); }
  renderSpine() {
    const c = this.$("ckpts"); c.innerHTML = "";
    this.history.forEach((h) => { const d = mk("div", "ckpt" + (h.i === this.viewing ? " on" : "")); d.title = h.why || ""; d.innerHTML = `<div class="cq">${h.q}</div><div class="cw">${h.why ? h.why.replace(/<[^>]+>/g, "") : ""}</div>`; d.onclick = () => this.restore(h.i); c.appendChild(d); });
    c.scrollLeft = c.scrollWidth;
  }
  restore(i: number) { const h = this.history[i]; this.viewing = i; this.coord.set({ colorBy: h.state.colorBy, focus: h.state.focus, selection: null }); this.currentWS = h.state.ws; this.canvas = JSON.parse(JSON.stringify(h.state.canvas)); this.rail = JSON.parse(JSON.stringify(h.state.rail)); this.proposal = null; this.fullRender(); this.renderSpine(); this.toast(`Returned to “${h.q}”`, "Every state is a checkpoint — nothing is lost to a change."); }

  // ---------- toasts ----------
  toast(text: string, why: string | null) {
    const t = mk("div", "toast"); t.appendChild(mk("span", undefined, text));
    if (why) { const w = mk("span", "why", "why?"); const det = mk("div", "det", why); w.onclick = () => t.classList.toggle("open"); t.appendChild(w); t.appendChild(det); }
    this.$("toasts").appendChild(t);
    setTimeout(() => { if (!t.classList.contains("open")) t.remove(); }, 4600); setTimeout(() => t.remove(), 12000);
  }

  // ---------- pip + thread (presence) : delegated to agent's view methods below ----------
  setPip(state: string, label?: string) {
    const b = this.$("askBtn"); b.className = "tb pip" + (state && state !== "idle" ? " " + state : "");
    const main = state === "working" ? "Working" + (label ? " · " + label : "") : state === "listening" ? "Listening…" : "Ask";
    const right = state === "nudge" ? `<span class="nbadge">${label || "!"}</span>` : (!state || state === "idle" || state === "listening") ? `<span class="kbd">⌘K</span>` : "";
    b.innerHTML = `<span class="dot"></span>${main}${right}`;
  }

  // ---------- selection popover ----------
  openSelpop() {
    const ids = this.coord.state.selection; if (!ids || !ids.length) return;
    this.ctx.metaOf("cell_type").then((m: any) => {
      const cts: Record<string, number> = {}; for (const i of ids) cts[m.categories[m.codes[i]]] = (cts[m.categories[m.codes[i]]] || 0) + 1;
      const top = Object.entries(cts).sort((a, b) => b[1] - a[1])[0];
      this.scope = { type: "selection", ids: Array.from(ids), summary: `${ids.length} cells (mostly ${top?.[0] || "?"})` };
      const sp = this.$("selpop");
      sp.innerHTML = `<div class="head">${ids.length} cells · mostly ${top?.[0] || "?"}</div>` +
        `<div class="it" data-a="ask"><span class="ic">⌘K</span>Ask about these…</div>` +
        `<div class="it" data-a="de"><span class="ic">≢</span>Run DE on selection</div>` +
        `<div class="it" data-a="clear"><span class="ic">✕</span>Clear selection</div>`;
      sp.style.left = Math.min(this.lastSelAnchor.left + 8, innerWidth - 210) + "px"; sp.style.top = this.lastSelAnchor.top + "px"; sp.classList.add("show");
      sp.querySelectorAll<HTMLElement>(".it").forEach((it) => it.onclick = () => { const a = it.dataset.a; this.hideSelpop();
        if (a === "ask") this.openPalette(this.scope!); else if (a === "de") this.agent.ask("run de", this.scope); else { this.coord.setSelection(null); this.scope = null; } });
    });
  }
  hideSelpop() { this.$("selpop").classList.remove("show"); }

  // ---------- context menu on panel ----------
  openCtx(x: number, y: number, p: Panel) {
    const c = this.$("ctx"); c.innerHTML = `<div class="it" data-a="ask">Ask about this panel…</div>` + (p.type !== "Note" ? `<div class="it" data-a="copy">Send a copy to the rail</div>` : "") + `<div class="it" data-a="rm">Remove from workbench</div>`;
    c.style.left = Math.min(x, innerWidth - 190) + "px"; c.style.top = y + "px"; c.classList.add("show");
    c.querySelectorAll<HTMLElement>(".it").forEach((it) => it.onclick = () => { const a = it.dataset.a; c.classList.remove("show");
      if (a === "ask") this.openPalette({ type: "panel", summary: `the ${p.title} panel` } as Scope);
      else if (a === "copy") { this.rail.unshift(this.newPanel({ ...p, title: p.title + " (copy)" })); this.renderRail(); }
      else { this.canvas = this.canvas.filter((z) => z.id !== p.id); this.fullRender(); this.checkpoint("remove " + p.title, "You removed a panel."); } });
  }

  // ---------- command palette ----------
  SUGS = [
    { t: "Colour cells by IL6", q: "show il6", ic: "◐" },
    { t: "Colour by cell type", q: "colour by cell type", ic: "◐" },
    { t: "What are the markers of this cluster?", q: "what genes changed", ic: "≢" },
    { t: "Show overdispersed gene programs", q: "show overdispersed programs", ic: "▤" },
    { t: "Show composition across samples", q: "show composition", ic: "▥" },
    { t: "Help me interpret a finding", q: "help me interpret this", ic: "✦" },
    { t: "Set everything up to compare conditions", q: "set everything up to compare conditions", ic: "⚙" },
  ];
  openPalette(scope?: Scope) {
    this.scope = scope || this.scope; this.$("scrim").classList.add("show"); this.$("palette").classList.add("show");
    if (!this.thread) this.setPip("listening"); this.renderScope(); (this.$("pin") as HTMLInputElement).value = ""; this.filter(""); (this.$("pin") as HTMLInputElement).focus();
  }
  closePalette() { this.$("scrim").classList.remove("show"); this.$("palette").classList.remove("show"); if (!this.thread) this.setPip(this.nudgePending ? "nudge" : "idle", this.nudgePending ? "1" : undefined); }
  renderScope() { const s = this.$("scope"); if (this.scope) { s.style.display = ""; s.innerHTML = `<span>↳ about ${this.scope.summary}</span><span class="x" id="scx">clear</span>`; this.$("scx").onclick = () => { this.scope = null; this.renderScope(); this.filter((this.$("pin") as HTMLInputElement).value); }; } else s.style.display = "none"; }
  scopedSugs() { return this.scope ? [{ t: "Run differential expression on this selection", q: "run de", ic: "≢" }, { t: "What cell types are these?", q: "what are these", ic: "?" }, { t: "Colour by condition", q: "colour by condition", ic: "◐" }] : this.SUGS; }
  filter(v: string) { const base = this.scopedSugs(); this.filtered = base.filter((s) => s.t.toLowerCase().includes(v.toLowerCase())); if (v && !this.filtered.length) this.filtered = [{ t: `Ask: “${v}”`, q: v, ic: "➤", free: true }]; this.hot = 0; this.renderSugs(); }
  renderSugs() { const c = this.$("sugs"); c.innerHTML = ""; this.filtered.forEach((s, i) => { const d = mk("div", "sug" + (i === this.hot ? " hot" : "")); d.innerHTML = `<span class="ic">${s.ic || "➤"}</span><span class="lab">${s.t}</span>` + (s.free ? "" : `<span class="hint">enter</span>`); d.onclick = () => { this.closePalette(); this.agent.ask(s.q, this.scope); }; c.appendChild(d); }); }

  // ---------- wiring ----------
  wire() {
    this.$("askBtn").onclick = () => { if (this.nudgePending) this.agent.openNudge(); else this.openPalette(); };
    this.$("lockBtn").onclick = () => { this.locked = !this.locked; this.$("lockBtn").classList.toggle("on", this.locked); this.$("lockBtn").textContent = this.locked ? "🔒 Layout" : "🔓 Layout"; this.toast(this.locked ? "Layout locked" : "Layout unlocked", this.locked ? "The agent will route bigger changes to the rail instead of touching your workbench." : null); };
    this.$("railBtn").onclick = () => this.setRail(!this.$("rail").classList.contains("open"));
    this.$("railX").onclick = () => this.setRail(false);
    this.$("tlhd").onclick = () => this.$("timeline").classList.toggle("collapsed");
    this.$("dockBtn").onclick = (e) => { e.stopPropagation(); this.agent.setThreadDock(!this.threadDocked); };
    this.$("scrim").onclick = () => this.closePalette();
    (this.$("pin") as HTMLInputElement).addEventListener("input", (e) => this.filter((e.target as HTMLInputElement).value));
    (this.$("pin") as HTMLInputElement).addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { this.hot = Math.min(this.hot + 1, this.filtered.length - 1); this.renderSugs(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { this.hot = Math.max(this.hot - 1, 0); this.renderSugs(); e.preventDefault(); }
      else if (e.key === "Enter") { const s = this.filtered[this.hot]; if (s) { this.closePalette(); this.agent.ask(s.q, this.scope); } }
    });
    document.addEventListener("click", (e) => { if (!this.$("selpop").contains(e.target as Node)) this.hideSelpop(); if (!this.$("ctx").contains(e.target as Node)) this.$("ctx").classList.remove("show"); });
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); this.openPalette(); }
      else if (e.key === "Escape") { this.closePalette(); this.hideSelpop(); this.$("ctx").classList.remove("show"); }
    });
    this.coord.subscribe(() => { this.repaint(); this.syncColorSelects(); });
  }
  syncColorSelects() { const v = this.coord.state.colorBy; document.querySelectorAll<HTMLSelectElement>("select.inline").forEach((s) => { if ([...s.options].some((o) => o.value === v)) s.value = v; }); }

  // expose thread rendering for the agent
  renderThread() { this.agent.renderThread(); }
}
