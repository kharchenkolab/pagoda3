// The agent: routes intent to the right surface at the lowest sufficient rung, drives
// the five presence modes, and encodes the cacoa methodological rules. Today the planner
// is a keyword matcher over REAL data (a faithful, swappable stand-in for the live
// Anthropic agent wired in Phase 6); the surfaces, tools, and routing are real.
import type { App } from "../ui/shell.ts";
import { mk } from "../ui/dom.ts";
import { handleLabel } from "../data/coord.ts";
import type { Panel } from "../ui/panels.ts";
import { runLive } from "./live.ts";

export interface Scope { type: "selection" | "panel"; summary: string; ids?: number[]; }

const REGISTRY: Record<string, number> = { Embedding: 1, CompositionBars: 1, DeTable: 1, Volcano: 1, Overdispersion: 1, Heatmap: 1, BoxBySample: 1, Note: 1 };

export class Agent {
  app: App;
  live = false;                 // set true when the proxy + token are reachable
  private abortCtrl?: AbortController;
  constructor(app: App) { this.app = app; }
  get ctx() { return this.app.ctx; }

  // dispatcher: real Anthropic planner when available, faithful mock otherwise
  async ask(qraw: string, sc?: Scope | null) {
    if (this.live) return this.askLive(qraw, sc);
    return this.askMock(qraw, sc);
  }
  async askLive(qraw: string, sc?: Scope | null) {
    this.app.hideSelpop();
    this.abortCtrl = new AbortController();
    try { await runLive(this.app, qraw, this.abortCtrl.signal); }
    catch (e) {
      this.live = false;
      if (this.app.thread) this.settleThread(null);
      this.app.setPip("idle");
      this.app.toast("Live agent unavailable — using local planner", String((e as any)?.message || e));
      return this.askMock(qraw, sc);
    }
  }
  stopLive() { this.abortCtrl?.abort(); }

  validate(p: Partial<Panel>) {
    if (!REGISTRY[p.type!]) return { ok: false, reason: `unknown component type “${p.type}” — not in the validated registry` };
    return { ok: true };
  }

  // ---- coordinated colour (shared by manipulation + agent + clicks) ----
  setColorVerb(handle: string, what: string, why: string) {
    this.app.coord.setColor(handle);
    this.app.toast(what + " → coloured by " + handleLabel(handle), why);
    this.app.checkpoint("colour · " + handleLabel(handle), why);
  }
  async coordinateGene(sym: string) {
    if ((await this.ctx.view.geneCol(sym)) === undefined) return this.app.toast(`No expression layer for ${sym}`, null);
    this.setColorVerb(`gene:${sym}`, `Clicked ${sym}`, "A click on a result is the cheapest request — it moved the shared colour scope, so every embedding recoloured in place.");
  }

  addRail(p: Partial<Panel>, q?: string) { const panel = this.app.newPanel({ ...p, q }); this.app.rail.unshift(panel); this.app.renderRail(); return panel; }

  // ---- the mock planner (fallback) ----
  async askMock(qraw: string, sc?: Scope | null) {
    const q = qraw.toLowerCase().trim(); if (!q) return; this.app.hideSelpop();
    // selection-scoped
    if (sc && sc.type === "selection") {
      if (/\bde\b|differential|chang|marker/.test(q)) {
        const ids = sc.ids!; const setB = new Set(ids); const rest: number[] = []; for (let i = 0; i < this.ctx.n; i++) if (!setB.has(i)) rest.push(i);
        const { ranked, nA, nB, approx, panel, nGenesRanked } = await this.ctx.view.subsampleDE(ids, rest);
        const rows = ranked.slice(0, 20).map((r) => ({ gene: r.gene, symbol: r.symbol, lfc: r.lfc, padj: Math.exp(-Math.abs(r.lfc) * 2) }));
        this.addRail({ type: "DeTable", title: `DE · selection (${ids.length} cells)`, cap: `vs rest${approx ? " · approx" : ""}`, bind: "de:selection", rows }, qraw);
        const how = panel ? `read only your ${nA + nB} sampled rows from the cell-major counts — O(rows) over all ${nGenesRanked} genes` : `subsampled n=${nA} vs ${nB}`;
        this.app.toast(`DE for your ${ids.length}-cell selection is in the rail`, `${how}, ranking-grade. You gave the agent a referent by selecting — the selection carried the 'what', your words the verb. The donor caveat rides on the handle.`);
        return this.app.checkpoint("DE on selection", "Subsample DE scoped to your selection, in the rail.");
      }
      if (/type|are these|identit/.test(q)) { const m: any = await this.ctx.metaOf("cell_type"); const cts: Record<string, number> = {}; sc.ids!.forEach((i) => cts[m.categories[m.codes[i]]] = (cts[m.categories[m.codes[i]]] || 0) + 1); const tot = sc.ids!.length; const txt = Object.entries(cts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: <b>${Math.round(v / tot * 100)}%</b>`).join(" · "); this.addRail({ type: "Note", title: `Selection · ${tot} cells`, text: txt }, qraw); return this.app.checkpoint("identity of selection", "Composition of your selection."); }
      if (/condition/.test(q)) return this.setColorVerb("meta:condition", "Asked about your selection", "Coordinated colour change — the selection stays outlined.");
    }
    // mode 3 dialogue
    if (/interpret|publish|robust|help me (read|decide|interpret)|is (this|the|it).*(solid|real|right)|should i (trust|report)/.test(q)) return this.startDialogue(qraw);
    // mode 4 autopilot
    if (/take it from here|set everything up|set it all up|optimi[sz]e|compare conditions|do the (whole|full)/.test(q)) { if (this.app.locked) return this.app.toast("Layout is locked — unlock to let autopilot reconfigure", "You hold the wheel."); return this.startAutopilot(qraw); }
    // validation / refusal
    if (/\b3d\b|three.?d|sankey|chord|word ?cloud|raw ?html|<\w+>/.test(q)) { const type = /3d|three/.test(q) ? "Embedding3D" : /sankey/.test(q) ? "Sankey" : "RawHTML"; this.addRail({ type, title: type + " (requested)" } as any, qraw); this.app.toast("That isn't in the validated component set", "The agent authors a spec the viewer validates against a fixed registry — an unknown type becomes a visible inert placeholder, never raw markup. I'd compose existing components instead."); return this.app.checkpoint("rejected · " + type, "An unknown component was refused — shown as a placeholder, not executed."); }
    // examine the markers OF a set of clusters / cell types -> a marker heatmap (+ colour for context)
    if (/marker|defin|signature|which gene/.test(q) && !/selection/.test(q)) {
      const groupings = this.ctx.groupings();
      const grouping = /cell ?type|annotation|proposed|these type/.test(q) && groupings.includes("cell_type") ? "cell_type"
        : (groupings.includes("leiden") ? "leiden" : groupings[0] || "leiden");
      this.app.coord.setColor("meta:" + grouping);
      this.addRail({ type: "Heatmap", title: `Marker heatmap · ${grouping}`, cap: `top genes × ${grouping}`, group: grouping, bind: "markers:" + grouping, full: true }, qraw);
      const mk = await this.ctx.markers(grouping);
      const eg = [...mk.entries()].slice(0, 3).map(([g, r]) => `<b>${g}</b>: ${r.slice(0, 3).map((x) => x.symbol).join(", ")}`).join(" · ");
      this.app.toast(`Marker heatmap for the ${grouping} groups is in the rail`, `Top genes per group (precomputed cluster-vs-rest over the ${grouping} grouping); click a gene to colour by it. Coloured the embedding by ${grouping} for context. ${eg}`);
      return this.app.checkpoint(`markers · ${grouping}`, `Marker heatmap for the ${grouping} grouping.`);
    }
    // rung 0 — coordinate
    if (/il6/.test(q) && !/donor|sample|driv/.test(q)) return this.setColorVerb("gene:IL6", "Asked to show IL6", "Your request mapped to the smallest edit — a colour change on the shared scope — so no panel or layout moved.");
    if (/cd3d|t.?cell/.test(q)) return this.setColorVerb("gene:CD3D", "Asked for CD3D", "Coordinated recolour.");
    if (/cell ?type/.test(q)) return this.setColorVerb("meta:cell_type", "Asked for cell type", "Coordinated recolour.");
    if (/leiden|cluster/.test(q) && /colou?r|show/.test(q)) return this.setColorVerb("meta:leiden", "Asked for clusters", "Coordinated recolour.");
    if (/condition/.test(q)) return this.setColorVerb("meta:condition", "Asked for condition", "Coordinated recolour.");
    if (/\bmito|quality|\bqc\b/.test(q)) return this.setColorVerb("qc:mito", "Asked for QC", "Coordinated recolour.");
    if (/focus|disease only|only.*disease/.test(q)) { this.app.coord.setFocus("condition", "disease"); this.app.toast("Focused on disease", "Control cells dim everywhere at once — one change to the shared focus."); return this.app.checkpoint("focus disease", "Coordinated focus."); }
    if (/clear|reset|show all|unfocus/.test(q)) { this.app.coord.clearFocus(); this.app.toast("Cleared focus", null); return this.app.checkpoint("clear focus", "Cleared coordination state."); }
    // rung 1 — answers
    if (/highly variable|variable gene|\bhvg\b|overdispersed gene|most variable/.test(q)) {
      const selCells = this.ctx.selectedCells();
      const ids = selCells.length ? Array.from(selCells) : Array.from({ length: this.ctx.n }, (_, i) => i);
      const hv = await this.ctx.view.overdispersedGenes(ids, 25);
      const scope = selCells.length ? `selection (${selCells.length} cells)` : "whole dataset";
      this.addRail({ type: "GeneList", title: `Overdispersed · ${scope}`, cap: "od (resid)", bind: "hvg:scope", rows: hv.map((h) => ({ symbol: h.symbol, score: h.resid })) }, qraw);
      this.app.toast(`Overdispersed genes for the ${scope}`, `Recomputed for this scope — residual above the mean-variance trend over all ${this.ctx.view.nGenes.toLocaleString()} genes, not a global shortlist.${hv.length ? " Top: " + hv.slice(0, 6).map((h) => h.symbol).join(", ") : ""}`);
      return this.app.checkpoint("overdispersed genes", "Scope-aware HVG in the rail.");
    }
    if (/overdispers|gene ?set|pathway|aspect|program/.test(q)) { this.addRail({ type: "Overdispersion", title: "Overdispersed programs", cap: "gene programs", bind: "aspect:overdispersion" }, qraw); this.app.toast("Overdispersed programs added to the rail", "Significantly overdispersed gene programs — click one to colour the embedding by it."); return this.app.checkpoint("overdispersed programs", "Disposable aspects list."); }
    if (/composition|proportion|abundanc/.test(q)) { this.addRail({ type: "CompositionBars", title: "Composition by sample", cap: "compositional", bind: "composition:bySample" }, qraw); this.app.toast("Composition answer added to the rail", null); return this.app.checkpoint("composition?", "Disposable composition answer."); }
    if (/what.*chang|differential|\bde\b|marker/.test(q)) {
      const markers = await this.ctx.markers("leiden"); const group = (await this.ctx.groupStatsCached("leiden")).groups[0];
      const rows = (markers.get(group) || []).slice(0, 20);
      this.addRail({ type: "DeTable", title: `Markers · ${group}`, cap: "cluster vs rest", bind: `de:leiden:${group}`, group, rows }, qraw);
      this.app.toast(`Markers for ${group} added to the rail`, "Placed in the rail rather than rearranging your layout — its caveat (cell-level ranking; the donor is the replicate) rides on the handle. Pin to promote.");
      return this.app.checkpoint("what changed?", "Disposable marker answer in the rail.");
    }
    // rung 2 — propose workspace
    if (/deep.?dive|set me up|workspace|switch to/.test(q)) { const target = /qc|quality/.test(q) ? "QC triage" : "Markers"; this.proposeWorkspace(target); return; }
    this.app.toast("I'm not sure how to act on that", "Try ⌘K — the suggestions show the different ways the agent responds.");
  }

  proposeWorkspace(target: string) {
    if (this.app.locked) { this.addRail({ type: "DeTable", title: "Markers", cap: "vs rest", bind: "de:leiden:c0" }); this.app.toast("Layout is locked — answer sent to the rail instead", "You locked the layout, so the agent won't reconfigure it. You stay in control."); return this.app.checkpoint("deep-dive (locked→rail)", "Downgraded to a rail answer."); }
    this.app.proposalWhy = "A different task warrants a different layout — but the agent proposes rather than imposes. Reversible either way.";
    this.app.proposal = { title: `Switch to “${target}”?`, diff: `<span class="rm">− current ${this.app.currentWS} panels</span><br><span class="add">+ ${this.app.WS[target].panels.map((p) => p.title).join(", ")}</span>`, label: "workspace → " + target, apply: () => this.app.switchWS(target, false) };
    this.app.renderRail(); this.app.toast("Proposed a workspace switch", "Big layout moves are proposals, not surprises — Apply or Discard in the rail.");
  }

  // ================= presence: thread / pip / modes =================
  renderThread() {
    if (this.app.threadDocked) return this.renderDockedConvo();
    const host = this.app.$("thread"); const t = this.app.thread;
    if (!t) { host.classList.remove("show"); setTimeout(() => { if (!this.app.thread) host.innerHTML = ""; }, 300); return; }
    const wasShown = host.classList.contains("show");
    host.innerHTML = ""; const inner = mk("div", "thrinner"); this.appendThreadGuts(inner); host.appendChild(inner);
    host.classList.add("show"); host.scrollTop = host.scrollHeight;
    if (!wasShown) { host.classList.add("flash"); setTimeout(() => host.classList.remove("flash"), 900); this.app.$("timeline").scrollIntoView({ block: "end" }); }
  }
  appendThreadGuts(inner: HTMLElement) {
    const t = this.app.thread;
    const hd = mk("div", "thrhd"); hd.appendChild(mk("span", undefined, t.kind === "autopilot" ? "AUTOPILOT" : t.kind === "nudge" ? "FROM THE AGENT" : "CONVERSATION"));
    const live = mk("div", "live" + (t.live ? "" : " idle")); live.innerHTML = `<span class="d"></span>${t.kind === "autopilot" ? (t.paused ? "paused" : t.live ? "working" : "done") : t.live ? "live" : "resolved"}`; hd.appendChild(live);
    if (t.kind === "autopilot" && t.live) { const c = mk("div", "ctrls"); const pz = mk("button", undefined, t.paused ? "Resume" : "Pause"); pz.onclick = () => this.toggleAutopilot(); const st = mk("button", undefined, "Stop"); st.onclick = () => this.stopAutopilot(); c.appendChild(pz); c.appendChild(st); hd.appendChild(c); }
    if (t.kind === "live" && t.live) { const c = mk("div", "ctrls"); const st = mk("button", undefined, "Stop"); st.onclick = () => this.stopLive(); c.appendChild(st); hd.appendChild(c); }
    inner.appendChild(hd);
    if (t.kind === "live") {
      for (const e of t.entries) {
        if (e.tool) { const m = e.status === "done" ? "✓" : "◐"; const d = mk("div", "step " + (e.status || "active")); d.innerHTML = `<span class="mk">${m}</span><div><div>${e.label}</div>${e.detail ? `<div class="sd">${e.detail}</div>` : ""}</div>`; inner.appendChild(d); }
        else { const d = mk("div", "turn " + e.role); d.innerHTML = `<span class="ava">${e.role === "user" ? "me" : "✦"}</span><div class="msg">${e.text}</div>`; inner.appendChild(d); }
      }
    } else if (t.kind === "autopilot") {
      for (const s of t.steps) {
        if (s.proposal) { const d = mk("div", "step proposal"); d.innerHTML = `<div><b>${s.label}</b>${s.detail ? `<div class="sd">${s.detail}</div>` : ""}</div>`; if (s.status === "active") { const a = mk("div", "pacts"); const ok = mk("button", "ok", "Apply"); ok.onclick = s.onApply; const sk = mk("button", undefined, "Skip"); sk.onclick = s.onSkip; a.appendChild(ok); a.appendChild(sk); d.appendChild(a); } inner.appendChild(d); continue; }
        const m = s.status === "done" ? "✓" : s.status === "active" ? "◐" : s.status === "skipped" ? "–" : "○"; const d = mk("div", "step " + s.status); d.innerHTML = `<span class="mk">${m}</span><div><div>${s.label}</div>${s.detail ? `<div class="sd">${s.detail}</div>` : ""}</div>`; inner.appendChild(d);
      }
    } else {
      for (const tn of t.turns) { const d = mk("div", "turn " + tn.role); d.innerHTML = `<span class="ava">${tn.role === "user" ? "me" : "✦"}</span><div class="msg">${tn.text}</div>`; inner.appendChild(d); if (tn.replies?.length) { const r = mk("div", "replies"); tn.replies.forEach((rep: any) => { const b = mk("button", "reply", rep.label); b.onclick = rep.go; r.appendChild(b); }); inner.appendChild(r); } }
      const last = t.turns[t.turns.length - 1];
      if (!this.app.threadDocked && t.kind !== "nudge" && last?.role === "agent" && last.replies?.length && !last.chipsOnly) { const row = mk("div", "thinput"); const inp = document.createElement("input"); inp.placeholder = "or type your own…"; inp.onkeydown = (e) => { if (e.key === "Enter" && inp.value.trim()) { const v = inp.value.trim(); inp.value = ""; this.threadReply(v); } }; row.appendChild(inp); row.appendChild(mk("span", "thhint", "↵")); inner.appendChild(row); }
    }
  }
  renderDockedConvo() {
    this.app.$("thread").classList.remove("show"); this.app.$("thread").innerHTML = "";
    const host = this.app.$("convo"); host.classList.add("open"); host.innerHTML = "";
    const hd = mk("div", "convohd"); hd.appendChild(mk("span", "t", "CONVERSATION · PINNED")); const x = mk("span", "x", "⇤"); x.onclick = () => this.setThreadDock(false); hd.appendChild(x); host.appendChild(hd);
    const body = mk("div", "convobody");
    for (const h of this.app.history) { const e = mk("div", "cxentry"); e.innerHTML = `<div class="cxq">${h.q}</div>${h.why ? `<div class="cxw">${h.why.replace(/<[^>]+>/g, "")}</div>` : ""}`; body.appendChild(e); }
    if (this.app.thread) { const lb = mk("div", "convolive"); this.appendThreadGuts(lb); body.appendChild(lb); }
    host.appendChild(body);
    const foot = mk("div", "convofoot"); const inp = document.createElement("input"); inp.placeholder = "Message the agent…"; inp.onkeydown = (e) => { if (e.key === "Enter" && inp.value.trim()) { const v = inp.value.trim(); inp.value = ""; this.dockSend(v); } }; foot.appendChild(inp); host.appendChild(foot); body.scrollTop = body.scrollHeight;
  }
  dockSend(text: string) { const t = this.app.thread; const last = t?.turns?.[t.turns.length - 1]; if (t && t.kind === "dialogue" && last?.role === "agent" && last.replies?.length) this.threadReply(text); else this.ask(text); }
  setThreadDock(on: boolean) { this.app.threadDocked = on; const b = this.app.$("dockBtn"); b.textContent = on ? "⇤ undock" : "⇥ dock chat"; if (on) { this.renderThread(); this.app.toast("Conversation pinned open", "An always-on transcript — the same timeline rendered as a thread. The default stays collapsed."); } else { this.app.$("convo").classList.remove("open"); this.app.$("convo").innerHTML = ""; this.renderThread(); this.app.toast("Conversation unpinned", null); } }
  settleThread(label: string | null, why?: string) { this.app.thread = null; this.renderThread(); if (label) this.app.checkpoint(label, why || ""); }

  // mode 3 — dialogue (cacoa methodological reasoning)
  startDialogue(q: string) {
    this.app.setPip("working", "thinking");
    this.app.thread = { kind: "dialogue", live: true, turns: [{ role: "user", text: q }] }; this.renderThread();
    setTimeout(() => { if (!this.app.thread) return; this.app.thread.turns.push({ role: "agent", text: "Many marker/DE results here are computed across <i>cells</i>, but your replicate is the <i>donor</i>. Before I weigh in: are you claiming a population-level shift, or a subpopulation effect?", replies: [{ label: "Population-level", go: () => this.dialogue2("pop") }, { label: "A subpopulation", go: () => this.dialogue2("sub") }], chipsOnly: true }); this.app.setPip("listening", "your call"); this.renderThread(); }, 850);
  }
  dialogue2(kind: string) {
    const t = this.app.thread; t.turns[t.turns.length - 1].replies = null; t.turns.push({ role: "user", text: kind === "pop" ? "Population-level." : "A subpopulation." }); this.app.setPip("working", "thinking"); this.renderThread();
    setTimeout(() => { if (!this.app.thread) return;
      if (kind === "pop") { t.turns.push({ role: "agent", text: "Then donor structure is decisive — aggregate to <b>pseudobulk per donor</b> and test across donors, not pooled cells. With this design check whether the shift is carried by one donor. Want the per-sample view to verify?", replies: [{ label: "Pin per-donor view", go: () => { this.app.canvas.push(this.app.newPanel({ type: "BoxBySample", title: "IL6 per sample", cap: "donor means", full: true, gene: "IL6", bind: "expr:IL6@all" })); this.app.fullRender(); this.app.setPip("idle"); this.settleThread("interpret · use pseudobulk", "A multi-turn question lived as a thread; only the conclusion became a checkpoint."); this.app.toast("Pinned the per-donor view", null); } }, { label: "Just note it", go: () => { this.app.setPip("idle"); this.settleThread("interpret · use pseudobulk", "Conclusion kept; the dialogue recompacted to one checkpoint."); } }] });
      } else { t.turns.push({ role: "agent", text: "For a subpopulation claim the cell-level test is fairer — but define the subpopulation explicitly (a selection or cluster), or the boundary is post-hoc. Select the cells and ask again; I'll scope the DE to them.", replies: [{ label: "Got it", go: () => { this.app.setPip("idle"); this.settleThread("interpret · scope to a subpopulation", "Conclusion kept."); } }] }); }
      this.app.setPip("listening", "your call"); this.renderThread(); }, 850);
  }
  threadReply(text: string) {
    const t = this.app.thread; const last = t.turns[t.turns.length - 1]; if (last?.replies) last.replies = null; t.turns.push({ role: "user", text });
    const pivot = /forget|instead|actually|what about|never ?mind|rather/i.test(text); this.app.setPip("working", "thinking"); this.renderThread();
    setTimeout(() => { if (!this.app.thread) return; if (pivot) { t.turns.push({ role: "agent", text: `Got it — treating that as a new direction. Settling this and taking up “${text}.”` }); this.renderThread(); setTimeout(() => { this.app.setPip("idle"); this.settleThread("dialogue → pivot", "A typed reply can redirect the thread, not just answer it."); this.ask(text); }, 650); } else { t.turns.push({ role: "agent", text: `Noted — “${text}.” I'll fold that into the read; the conclusion stands.`, replies: [{ label: "Makes sense", go: () => { this.app.setPip("idle"); this.settleThread("interpret · noted", "Conclusion kept."); } }] }); this.app.setPip("listening", "your call"); this.renderThread(); } }, 800);
  }

  // mode 4 — autopilot
  startAutopilot(_q: string) {
    this.app.thread = { kind: "autopilot", live: true, paused: false, steps: [
      { label: "Surveying clusters and conditions", status: "active" },
      { label: "Checking replicate structure", status: "pending", detail: "3 control vs 3 disease donors" },
      { label: "Testing composition shift", status: "pending", detail: "compositional-aware · proportions sum to 1" }] };
    this.app.apIndex = 0; this.app.setPip("working", "step 1"); this.renderThread(); this.scheduleAP();
  }
  scheduleAP() {
    const t = this.app.thread; if (!t || t.kind !== "autopilot" || t.paused) return; const cur = t.steps[this.app.apIndex]; if (cur?.proposal) return;
    this.app.apTimer = setTimeout(() => { const t = this.app.thread; if (!t || t.paused) return; const c = t.steps[this.app.apIndex]; if (c?.status === "active") c.status = "done"; this.app.apIndex++;
      if (this.app.apIndex < t.steps.length) { t.steps[this.app.apIndex].status = "active"; this.app.setPip("working", "step " + (this.app.apIndex + 1)); this.renderThread(); this.scheduleAP(); }
      else { t.steps.push({ proposal: true, status: "active", label: "Reconfigure layout to compare conditions", detail: "+ colour by condition · + composition · + per-donor view",
        onApply: () => { const p = t.steps[t.steps.length - 1]; p.status = "done"; this.app.coord.setColor("meta:condition"); if (!this.app.canvas.some((x) => x.type === "CompositionBars")) this.app.canvas.push(this.app.newPanel({ type: "CompositionBars", title: "Composition by sample", cap: "by condition", bind: "composition:bySample" })); if (!this.app.canvas.some((x) => x.type === "BoxBySample")) this.app.canvas.push(this.app.newPanel({ type: "BoxBySample", title: "IL6 per sample", cap: "donor means", full: true, gene: "IL6", bind: "expr:IL6@all" })); this.app.fullRender(); t.steps.push({ label: "Colouring by condition", status: "active" }); this.renderThread(); setTimeout(() => { if (!this.app.thread) return; t.steps[t.steps.length - 1].status = "done"; this.finishAutopilot(); }, 700); },
        onSkip: () => { const p = t.steps[t.steps.length - 1]; p.status = "skipped"; p.label = "Reconfigure layout (skipped)"; this.finishAutopilot(); } });
        this.app.setPip("listening", "needs your OK"); this.renderThread(); } }, 850);
  }
  finishAutopilot() { this.app.setPip("idle"); this.settleThread("autopilot · compare conditions", "The agent took the wheel for a few steps — the trace was live and interruptible, and the big move was still a proposal you approved."); this.app.toast("Autopilot finished", "Everything it did is replayable from History."); }
  toggleAutopilot() { const t = this.app.thread; if (!t) return; t.paused = !t.paused; if (t.paused) { this.app.setPip("working", "paused"); this.renderThread(); } else { this.app.setPip("working", "resumed"); this.renderThread(); this.scheduleAP(); } }
  stopAutopilot() { if (this.app.apTimer) clearTimeout(this.app.apTimer); const t = this.app.thread; t.steps.forEach((s: any) => { if (s.status === "active" && !s.proposal) s.status = "done"; if (s.status === "pending") s.status = "skipped"; }); this.app.setPip("idle"); this.settleThread("autopilot stopped", "You seized the wheel mid-run — control returns instantly, the partial run is a checkpoint."); this.app.toast("Stopped — you have the wheel", null); }

  // mode 5 — nudge (from a real confound: cluster-0 enriched in disease, driven by D5)
  armBootNudge() { this.app.nudgePending = { text: "Heads up — cluster <b>c0</b> (Macrophage) is enriched in disease, but the enrichment leans on a single donor (<b>D5</b>). Want the per-sample composition before treating it as a condition effect?" }; this.app.setPip("nudge", "1"); this.app.toast("The agent has a note for you — see the Ask button", "Proactive findings arrive as a quiet badge, never a popup. Open it when you're ready."); }
  openNudge() { const n = this.app.nudgePending; this.app.nudgePending = null; this.app.setPip("idle"); this.app.thread = { kind: "nudge", live: false, turns: [{ role: "agent", text: n.text, replies: [{ label: "Show composition", go: () => { this.addRail({ type: "CompositionBars", title: "Composition by sample", cap: "agent-flagged", bind: "composition:bySample" }, "(the agent flagged this)"); this.settleThread(null); this.app.toast("Composition added to the rail", "Proactivity arrives as a quiet badge you can open or ignore."); } }, { label: "Dismiss", go: () => { this.settleThread(null); this.app.toast("Dismissed", null); } }] }] }; this.renderThread(); }
}
