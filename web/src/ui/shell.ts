import { mk } from "./dom.ts";
import { Ctx } from "../data/ctx.ts";
import { Coord, handleLabel, EntityRef } from "../data/coord.ts";
import { Panel, PanelView, PanelHooks, CompReactor, BuiltBody, bodyFor, paintEmbedding } from "./panels.ts";
import { EmbeddingView } from "../render/embedding.ts";
import { Agent, Scope, REGISTRY } from "../agent/agent.ts";
import { checkLive } from "../agent/live.ts";
import { normalizeViewPatch, RawViewPatch, World, PanelSpec, PanelPatch } from "../agent/viewpatch.ts";
import { validateCellSet, resolveCellSet, describeCellSet, CellSet, CellWorld, CellEnv } from "../agent/cellset.ts";
import { validateComputeResult, runInWorker } from "../agent/codeapi.ts";
import { setCodeValues, setConfValues, invalidateColor } from "../render/colors.ts";
import { setThemeColors } from "../render/theme.ts";
import { installOverflow } from "./overflow.ts";
import { makeWidgetHost } from "../widget/apphost.ts";
import type { WidgetHost, WidgetHandle } from "../widget/runtime.ts";
import { SESSION_KEY, WIDGETS_KEY, SavedWidget, SerAnnoLayer, Fingerprint, serializeSession, parseSession, serializeBundle, parseBundle, fingerprintMismatch, upsertWidget, loadWidgets } from "./persist.ts";
import { paletteNames, normalizePalette } from "../render/palettes.ts";
import { AnnotationLayer, seedLayer, setLabel, reconcile, compact, hierarchyDepth, rollupToLevel } from "../anno/model.ts";
import { PBMC_MARKERS, MarkerDB } from "../anno/markerdb.ts";
import { zscoreByGroup, scoreClusters, assignClusters, MarkerIdx } from "../anno/sctype.ts";
import { LRModel, lrFinalize } from "../anno/celltypist.ts";

interface Checkpoint { i: number; q: string; why: string; state: any; kind?: "ask" | "act"; exchange?: { kind: string; entries?: any[]; turns?: any[] }; }
interface WS { colorBy: string; panels: Partial<Panel>[]; }

const COLOR_OPTS: [string, string][] = [
  ["meta:leiden", "leiden"], ["meta:cell_type", "cell type"], ["meta:condition", "condition"],
  ["meta:sample", "sample"], ["qc:mito", "mito %"], ["gene:IL6", "IL6"], ["gene:CD3D", "CD3D"],
];

export class App {
  ctx: Ctx; coord: Coord; agent!: Agent;
  root: HTMLElement;
  canvas: Panel[] = []; rail: Panel[] = []; proposal: any = null;
  WS: Record<string, WS>; wsOrder: string[]; currentWS = "";   // "" until the first switchWS loads one (so it doesn't clobber a def on startup)
  history: Checkpoint[] = []; viewing = -1; locked = false; uid = 0;
  suspendRender = false;   // set while applyViewPatch batches a multi-op patch into a single render
  renderToken = 0;         // guards fullRender against concurrent re-entry (async panel build → stale double-append)
  liveMessages: any[] = [];   // the running Anthropic conversation (persists across asks so follow-ups keep context)
  annoLayers = new Map<string, AnnotationLayer>();   // rich annotation layers (records/provenance); codes also mirrored into ctx as categoricals
  embeddings: EmbeddingView[] = [];
  compReactors: CompReactor[] = [];   // vocabulary-bound panels that highlight a category on a coord hint
  coordSubs: (() => void)[] = [];     // managed coord subscriptions (panels' onCoord) — unsubscribed each fullRender
  teardowns: (() => void)[] = [];     // per-panel cleanup (e.g. a widget iframe + its host subscription) — run each fullRender
  widgetHandles = new Map<number, WidgetHandle>();   // live mounted widget iframes by panel id (for inspect_widget); cleared each fullRender
  themeSubs = new Set<() => void>();  // theme-change listeners (widgets re-theme their iframes); fired in applyTheme
  builtinWS!: Set<string>;            // code-defined workspace names (the rest are user-saved → persisted)
  widgetLib: SavedWidget[] = [];      // the custom-widget LIBRARY (authored widgets, re-addable from the menu); persisted
  private _saveTimer: any = null;     // debounce for session persistence
  private lastSel: any;               // last selection dispatched to reactors — skip re-dispatch on colour-only repaints
  private reactorsStale = true;       // set when reactors are rebuilt (fullRender) → force one dispatch
  geneHoverSinks: ((sym: string | null) => void)[] = [];   // panels that highlight a gene's row on a coord geneHint
  colorChoices: [string, string][] = [...COLOR_OPTS];   // colour-by dropdown options, capped per class (see noteColor)
  caveatsCollapsed = new Set<string>();   // caveat handles the user clicked to collapse (stay collapsed across renders)
  // presence
  thread: any = null; threadDocked = false; nudgePending: any = null; apTimer: any = null; apIndex = 0;
  scope: Scope | null = null; hot = 0; filtered: any[] = []; lastSelAnchor: { left: number; top: number; right?: number } = { left: 0, top: 0 };
  proposalWhy = "";

  constructor(ctx: Ctx) {
    this.ctx = ctx; this.coord = ctx.coord;
    // Preferred grouping (annotation > cell_type > clusters): the embedding colour AND the marker/composition
    // groupings all open on the SAME named partition, so the panels describe one biology by default.
    const defGrp = ctx.defaultGrouping();
    const defGroup = "meta:" + defGrp;
    this.coord.set({ colorBy: defGroup });
    this.WS = {
      Metadata: { colorBy: defGroup, panels: [
        { type: "Embedding", title: "Embedding", cap: "all cells", bind: "embedding:main" },
        { type: "MetadataFacets", title: "Metadata", cap: "browse facets", bind: "facets:all" }] },
      "Markers": { colorBy: defGroup, panels: [
        { type: "Embedding", title: "Embedding", cap: "clusters", bind: "embedding:main" },
        { type: "Heatmap", title: "Marker genes", cap: "top genes per group", group: defGrp }] },
      "Annotate": { colorBy: defGroup, panels: [
        { type: "Embedding", title: "Embedding", bind: "embedding:main", view: { colorBy: "meta:annotation" } },
        { type: "Reconcile", title: "Reconcile labels", group: "leiden" }] },
      "QC triage": { colorBy: "qc:mito", panels: [
        { type: "Embedding", title: "Embedding", cap: "mito fraction", bind: "embedding:main" },
        { type: "CompositionBars", title: "Composition", cap: "by sample", bind: "composition:bySample" }] },
      "Aspects": { colorBy: "geneset:Inflammatory response", panels: [
        { type: "Embedding", title: "Embedding", cap: "coloured by program", bind: "embedding:main" },
        { type: "Overdispersion", title: "Overdispersed programs", cap: "gene programs", bind: "aspect:overdispersion" }] },
    };
    // don't offer a workspace whose data this store lacks — Aspects needs precomputed gene programs (aspects),
    // which many stores (e.g. this PBMC set) don't carry. Keeps every visible tab functional.
    if (!ctx.view.ds.axisNames().includes("aspects")) delete (this.WS as Record<string, unknown>)["Aspects"];
    this.wsOrder = Object.keys(this.WS);
    this.builtinWS = new Set(this.wsOrder);   // the code-defined workspaces — user-saved ones (the rest) get persisted
    this.root = mk("div", "app");
  }

  async mount(parent: HTMLElement) {
    this.agent = new Agent(this);
    this.root.innerHTML = `
      <div class="top">
        <div class="logo">pagoda<span>2</span></div>
        <div class="wstabs" id="wstabs"></div>
        <div class="focuschip" id="focuschip" style="display:none"></div>
        <div class="spacer"></div>
        <div class="tb pip" id="askBtn"><span class="dot"></span>Ask<span class="kbd">⌘K</span></div>
        <div class="tb" id="lockBtn">🔓 Layout</div>
        <div class="tb" id="convoBtn" title="show / hide the Chat column">Chat</div>
        <div class="tb" id="railBtn" title="show / hide the Answers column">Answers</div>
        <div class="tb acct" id="acctBtn" title="account, theme & custom widgets"><span class="acdot">G</span></div>
      </div>
      <div class="stage">
        <div class="convo" id="convo"></div>
        <div class="canvas"><div class="workbench" id="workbench"></div></div>
        <div class="rail" id="rail"><div class="railgrip" id="railgrip"></div><div class="railhd"><span class="t">ANSWERS · DISPOSABLE</span><span class="x" id="railX" title="collapse">⇥</span></div><div class="railbody" id="railbody"></div></div>
      </div>
      <div class="timeline collapsed" id="timeline">
        <div class="thread" id="thread"></div>
        <div class="tlhd" id="tlhd"><span class="t">HISTORY</span><span class="dockbtn" id="dockBtn">⇥ dock chat</span><span class="chev">▶</span></div>
        <div class="ckpts" id="ckpts"></div>
      </div>`;
    parent.innerHTML = "";
    parent.appendChild(this.root);
    // overlays
    for (const html of [`<div class="scrim" id="scrim"></div>`,
      `<div class="palette" id="palette"><div class="scope" id="scope" style="display:none"></div><input id="pin" placeholder="Ask, or describe what you want to see…"><div class="sugs" id="sugs"></div></div>`,
      `<div class="selpop" id="selpop"></div>`, `<div class="ctx" id="ctx"></div>`, `<div class="acmenu" id="acct"></div>`, `<div class="toasts" id="toasts"></div>`]) {
      const d = document.createElement("div"); d.innerHTML = html; document.body.appendChild(d.firstElementChild!);
    }
    this.wire();
    this.setPip("idle");
    this.switchWS("Metadata", false);
    this.checkpoint("session start", "Baseline Metadata workspace.");
    this.restoreSession();   // restore the last session (layout incl. widget panels) + load the custom-widget library
    setTimeout(() => this.toast("Drag with Shift to select cells · ⌘K to ask · right-click a panel", null), 500);
    // connect the live Anthropic planner if the proxy + token are reachable
    checkLive().then((ok) => { this.agent.live = ok; if (ok) this.toast("Live agent connected · Opus", "The agent is the real Anthropic planner now — it drives the coordination space through tools, at the lowest sufficient rung."); });
    // boot nudge (Mode 5) from a real confound in the data
    setTimeout(() => this.agent.armBootNudge(), 2600);
  }

  $(id: string) { return document.getElementById(id)!; }

  // Theme-change subscription for widget iframes (re-push CSS vars on a light/dark flip). Returns an unsubscribe.
  onTheme(cb: () => void): () => void { this.themeSubs.add(cb); return () => this.themeSubs.delete(cb); }
  // The shared WidgetHost bridge (coord/ctx/theme) — built once, reused by every widget panel + the preview tool.
  private _widgetHost?: WidgetHost;
  widgetHost(): WidgetHost { return (this._widgetHost ||= makeWidgetHost(this)); }

  // ---- persistence: the current session (layout incl. widget source) + the custom-widget library ----
  // Identity of the loaded dataset — the ?store= param (default = the demo). Sessions are scoped to this so a session
  // saved for one dataset is never restored onto another (which would clobber its view with a stale colorBy/scope/widget).
  currentStore(): string { try { return new URLSearchParams(location.search).get("store") || "default"; } catch { return "default"; } }
  scheduleSave() { if (this._saveTimer) return; this._saveTimer = setTimeout(() => { this._saveTimer = null; this.persistSession(); }, 400); }
  // dataset IDENTITY for the persistence guard — cell count is decisive (annotation codes are cell-indexed), field
  // names are informational. A session/annotation only safely reapplies where these align.
  datasetFingerprint(): Fingerprint { try { return { n: this.ctx.n, fields: this.ctx.categoricalFields().slice().sort() }; } catch { return { n: 0, fields: [] }; } }
  // AUTHORED data → materialized in full: every annotation layer's per-cell codes + label names + CAP records.
  serializeAnnotation(): SerAnnoLayer[] { return [...this.annoLayers.values()].map((L) => ({ name: L.name, source: L.source, categories: L.categories.slice(), codes: Array.from(L.codes as Int32Array), records: L.records, provenance: L.provenance })); }
  restoreAnnotation(layers: SerAnnoLayer[]): void { for (const s of layers) { try { this.commitLayer({ name: s.name, source: s.source as any, codes: Int32Array.from(s.codes), categories: s.categories.slice(), records: s.records || {}, provenance: s.provenance } as AnnotationLayer, false); } catch { /* a malformed layer must not abort the rest */ } } }

  // The CHAT LOG: the agent's raw context (liveMessages — bounded ~40 turns, lets it CONTINUE after reopen) + the
  // user-visible timeline (history — drives the HISTORY rail + docked chat). Part of the session → saved/restored.
  serializeConversation() { return { messages: Array.isArray(this.liveMessages) ? this.liveMessages : [], history: this.history }; }
  restoreConversation(conv?: { messages: any[]; history: any[] }): void {
    if (!conv) return;
    if (Array.isArray(conv.messages)) this.liveMessages = conv.messages;
    if (Array.isArray(conv.history) && conv.history.length) { this.history = conv.history.map((h: any, i: number) => ({ ...h, i })); this.viewing = -1; this.renderSpine(); if (this.threadDocked) this.agent.renderThread(); }
  }
  persistSession() {
    const userWS = this.wsOrder.filter((n) => !this.builtinWS.has(n) && this.WS[n]).map((n) => ({ name: n, ws: this.WS[n] }));
    const base = { store: this.currentStore(), fingerprint: this.datasetFingerprint(), currentWS: this.currentWS, colorBy: this.coord.state.colorBy, canvas: this.captureLayout(), userWS, annotation: this.serializeAnnotation() };
    // Try the full doc (incl. the chat log); if it busts the ~5MB quota, retry WITHOUT the conversation so views +
    // annotation still persist (the chat is the biggest + most droppable part — it's also in the exportable file).
    try { localStorage.setItem(SESSION_KEY, serializeSession({ ...base, conversation: this.serializeConversation() })); }
    catch { try { localStorage.setItem(SESSION_KEY, serializeSession(base)); } catch { /* private mode / still over — non-fatal */ } }
  }
  restoreSession() {
    this.widgetLib = loadWidgets(localStorage.getItem(WIDGETS_KEY));   // the widget LIBRARY is dataset-agnostic — always load it
    const doc = parseSession(localStorage.getItem(SESSION_KEY));
    if (!doc || doc.store !== this.currentStore()) return;   // no session, or one from a DIFFERENT dataset → keep this store's default layout (no redundant re-render)
    this.applySessionViews(doc);
    if (doc.annotation && !fingerprintMismatch(doc.fingerprint, this.datasetFingerprint())) this.restoreAnnotation(doc.annotation);   // cell-indexed → only when the dataset still aligns
    this.restoreConversation(doc.conversation);   // the chat log survives a reload (not cell-indexed → no fingerprint gate)
    this.fullRender();
  }
  // Apply the VIEW layer of a session doc (workspaces + current WS + colour + canvas). Shared by localStorage restore
  // and file import; recompute-free (panels re-derive their data from these specs on the next render).
  private applySessionViews(doc: { userWS: { name: string; ws: any }[]; currentWS: string; colorBy: string; canvas: any[] }): void {
    for (const u of doc.userWS) if (u && u.name && !this.WS[u.name]) { this.WS[u.name] = u.ws; this.wsOrder.push(u.name); }   // re-add user workspaces
    if (doc.currentWS && this.WS[doc.currentWS]) this.currentWS = doc.currentWS;
    if (doc.colorBy) this.coord.set({ colorBy: doc.colorBy });
    if (Array.isArray(doc.canvas)) this.canvas = doc.canvas.map((p) => this.newPanel(p));   // widget panels carry their source
  }

  // ---- the portable session DOCUMENT (file) — see persist.ts. A bundle = the session + the widget library it uses.
  buildBundle(): string {
    const userWS = this.wsOrder.filter((n) => !this.builtinWS.has(n) && this.WS[n]).map((n) => ({ name: n, ws: this.WS[n] }));
    const session = parseSession(serializeSession({ store: this.currentStore(), fingerprint: this.datasetFingerprint(), currentWS: this.currentWS, colorBy: this.coord.state.colorBy, canvas: this.captureLayout(), userWS, annotation: this.serializeAnnotation(), conversation: this.serializeConversation() }))!;
    return serializeBundle({ session, widgets: this.widgetLib, savedAt: Date.now() });
  }
  applyBundle(raw: string): { ok: boolean; msg: string } {
    const b = parseBundle(raw);
    if (!b) return { ok: false, msg: "Not a pagoda session file." };
    const mism = fingerprintMismatch(b.session.fingerprint, this.datasetFingerprint());
    let added = 0;   // widgets are dataset-agnostic → always merge into the library (upsert by name)
    for (const w of b.widgets) { const before = this.widgetLib.length; this.widgetLib = upsertWidget(this.widgetLib, { name: w.name, source: w.source, controls: w.controls }, w.createdAt || Date.now(), w.id || "w" + Date.now().toString(36) + added); if (this.widgetLib.length > before) added++; }
    if (b.widgets.length) try { localStorage.setItem(WIDGETS_KEY, JSON.stringify({ widgets: this.widgetLib })); } catch { /* */ }
    this.applySessionViews(b.session);
    if (b.session.annotation && !mism) this.restoreAnnotation(b.session.annotation);
    this.restoreConversation(b.session.conversation);   // chat log travels with the file (not cell-indexed)
    this.fullRender(); this.renderWS(); this.scheduleSave();
    const parts = [`opened — ${b.session.canvas.length} panel(s)`];
    if (added) parts.push(`${added} widget(s)`);
    if (b.session.annotation?.length) parts.push(mism ? `annotation NOT applied (${mism})` : "annotation restored");
    if (b.session.conversation?.history?.length) parts.push(`${b.session.conversation.history.length} chat exchange(s)`);
    return { ok: true, msg: parts.join(" · ") };
  }
  async exportSessionToFile(): Promise<void> {
    const data = this.buildBundle();
    const base = this.currentStore().replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "session";
    const name = `pagoda-${base}.json`;
    try {
      const w = window as any;
      if (w.showSaveFilePicker) { const h = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: "pagoda session", accept: { "application/json": [".json"] } }] }); const ws = await h.createWritable(); await ws.write(data); await ws.close(); this.toast("Session saved", null); return; }
    } catch (e) { if ((e as any)?.name === "AbortError") return; /* else fall through to download */ }
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.toast("Session downloaded", "A portable .json — reopen it here or on another machine, or share it.");
  }
  async importSessionFromFile(): Promise<void> {
    const read = (text: string) => { const r = this.applyBundle(text); this.toast(r.ok ? "Session " + r.msg : "Couldn't open session", r.ok ? null : r.msg); };
    try {
      const w = window as any;
      if (w.showOpenFilePicker) { const [h] = await w.showOpenFilePicker({ types: [{ description: "pagoda session", accept: { "application/json": [".json"] } }] }); const f = await h.getFile(); read(await f.text()); return; }
    } catch (e) { if ((e as any)?.name === "AbortError") return; /* else fall through to file input */ }
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/json,.json";
    inp.onchange = async () => { const f = inp.files?.[0]; if (f) read(await f.text()); };
    inp.click();
  }
  // The custom-widget library (menu): upsert an authored widget, delete one, persist.
  saveWidgetToLibrary(name: string, source: string, controls?: { id: string; label: string }[]) {
    this.widgetLib = upsertWidget(this.widgetLib, { name: name || "Widget", source, controls }, Date.now(), "w" + Date.now().toString(36));
    try { localStorage.setItem(WIDGETS_KEY, JSON.stringify({ widgets: this.widgetLib })); } catch { /* */ }
  }
  deleteWidgetFromLibrary(id: string) {
    this.widgetLib = this.widgetLib.filter((w) => w.id !== id);
    try { localStorage.setItem(WIDGETS_KEY, JSON.stringify({ widgets: this.widgetLib })); } catch { /* */ }
  }

  // ---------- workbench ----------
  hooks(): PanelHooks {
    return {
      onGeneClick: (sym) => this.agent.coordinateGene(sym),
      onSelect: (ids, anchor) => { this.coord.setSelection({ kind: "cells", ids }); this.lastSelAnchor = anchor; this.openSelpop(); },   // brush has no category — raw cells
      registerEmbedding: (ev) => this.embeddings.push(ev),
      onCellHover: (idx) => this.onCellHover(idx),
      onCellClick: (idx, anchor) => this.onCellClick(idx, anchor),
      registerComposition: (r) => this.compReactors.push(r),
      onCoord: (fn) => { const u = this.coord.subscribe(fn); this.coordSubs.push(u); },   // managed coord subscription — torn down on fullRender (no leak)
      focusCategory: (field, value) => { const r = this.focusFromOp({ dim: field, value }); if (!r.error) { this.fullRender(); this.checkpoint(`focus · ${field}=${value}`, "Restricted the workspace to a metadata value — release with the focus chip."); } },
      addPanel: (spec) => { this.addPanel(spec); this.fullRender(); },
      openSelectionMenu: (anchor) => { this.lastSelAnchor = anchor; this.openSelpop(); },   // ops menu for the current selection (facet/lasso/etc.)
      onConfigurePanel: (id, patch) => this.configurePanel(id, patch),
      registerGeneHover: (fn) => this.geneHoverSinks.push(fn),
      annotate: (ids, label, layer) => this.labelCells(ids, label, layer),
      annoLayer: (name) => this.annoLayers.get(name),
      saveRecord: (layerName, record) => { const L = this.annoLayers.get(layerName); if (L) { L.records = L.records || {}; const prev = L.records[record.label]; L.records[record.label] = record; if (layerName === "annotation" && prev?.category !== record.category) { this.refreshHierarchyLevels(L); this.repaint(); this.syncColorSelects(); } } },   // lineage changed → rebuild the L1/L2 rollups
      adoptSource: (name) => { this.adoptSource(name); },
      renameLabel: (layerName, from, to) => { this.renameLabel(layerName, from, to); },
      proposeRecord: (layerName, label) => { this.proposeRecord(label, layerName); },
      proposeAllNames: (layerName) => { this.proposeAllNames(layerName); },
      splitLabel: (label) => { this.splitLabel(label); },
      widgetHost: () => this.widgetHost(),
      onTeardown: (fn) => { this.teardowns.push(fn); },   // run + cleared each fullRender (like coordSubs) — no iframe leak
      registerWidget: (id, handle) => { this.widgetHandles.set(id, handle); },   // so inspect_widget can read a live widget's state
    };
  }

  // embedding hover → emit the CELL under the cursor (not its category). Receivers interpret: the embedding
  // marks it with crosshairs; a category panel finds which of its categories the cell falls in.
  onCellHover(index: number | null) {
    this.coord.setHint(index == null ? null : { kind: "cells", ids: Int32Array.of(index) });
  }
  // embedding click → select the clicked cell's whole cluster (the same cell-set a panel click makes);
  // a click on empty space clears the selection. Origin-independent: any "select cluster" → one reaction.
  onCellClick(index: number | null, anchor?: { left: number; top: number }) {
    if (index == null) { this.coord.setSelection(null); this.hideSelpop(); return; }
    const g = this.ctx.keyGrouping(), v = this.ctx.categoryAt(g, index);
    this.coord.setSelection(v ? { kind: "category", grouping: g, value: v } : null);   // emit the category, not cells
    if (v && anchor) { this.lastSelAnchor = anchor; this.openSelpop(); }                // affordance: show what you can do with it
  }

  async fullRender() {
    const wb = this.$("workbench");
    const token = ++this.renderToken;   // panelEl is async; if a newer render starts mid-build, drop this one (no double-append)
    // During the async build the OLD panels stay visible — but a click on a stale row would act on stale state
    // (e.g. select the wrong cluster → the card/rename lands on the wrong label). Freeze input until the swap.
    wb.style.pointerEvents = "none";
    const old: Record<string, DOMRect> = {};
    wb.querySelectorAll<HTMLElement>(".panel[data-pid]").forEach((el) => (old[el.dataset.pid!] = el.getBoundingClientRect()));
    const built: { dom: HTMLElement; afterAttach?: () => void }[] = [];
    for (const p of this.canvas) built.push(await this.panelEl(p));   // build off-DOM first; old panels stay visible meanwhile
    if (token !== this.renderToken) return;   // superseded by a newer fullRender → it owns pointerEvents; discard this build
    this.coordSubs.forEach((u) => u()); this.coordSubs = [];   // tear down old panels' coord subscriptions before rebuilding
    this.teardowns.forEach((f) => { try { f(); } catch { /* a widget iframe destroy must not abort the render */ } }); this.teardowns = []; this.widgetHandles.clear();   // destroy old widget iframes + their host subscriptions; drop stale handles (re-registered on build)
    this.embeddings = []; this.compReactors = []; this.geneHoverSinks = []; this.reactorsStale = true;   // new reactors → repaint must dispatch the selection to them once
    wb.innerHTML = "";
    const afters: (() => void)[] = [];
    for (const b of built) { wb.appendChild(b.dom); if (b.afterAttach) afters.push(b.afterAttach); }
    this.layoutCanvas(wb);   // place panels into two columns (row-major by default; per-panel col pins override)
    // FLIP for surviving panels
    wb.querySelectorAll<HTMLElement>(".panel[data-pid]").forEach((el) => {
      const o = old[el.dataset.pid!]; if (!o) return; const n = el.getBoundingClientRect(); const dx = o.left - n.left, dy = o.top - n.top; if (!dx && !dy) return;
      el.style.animation = "none"; el.style.transition = "none"; el.style.transform = `translate(${dx}px,${dy}px)`;
      requestAnimationFrame(() => { el.style.transition = "transform .32s cubic-bezier(.2,.8,.2,1)"; el.style.transform = ""; });
    });
    afters.forEach((f) => f());
    await this.repaint();
    this.renderRail(); this.renderWS();
    wb.style.pointerEvents = "";   // re-enable input now that the new panels + selection are in place
  }

  async panelEl(p: Panel): Promise<{ dom: HTMLElement; afterAttach?: () => void }> {
    // a lone panel fills the canvas (no point keeping it in one half of a 2-col grid)
    const isFull = p.full || this.canvas.length === 1;
    const d = mk("div", "panel" + (isFull ? " full" : "") + (p.type === "Embedding" ? " embpanel" : "") + (p.type === "Widget" ? " wpanel" : ""));
    d.dataset.pid = String(p.id);
    const h = mk("div", "ph");
    const grip = mk("span", "grip", "⠿"); h.appendChild(grip);
    // scope CHIP: the facet value (e.g. day0) as a protected, non-shrinking badge so it stays legible even when
    // the title truncates in a narrow header. Distinguishes stacked/side-by-side facets at a glance.
    const scopeVal = (p.view?.scope as any)?.value;
    if (scopeVal) h.appendChild(Object.assign(mk("span", "scopechip"), { textContent: scopeVal, title: scopeVal }));
    h.appendChild(Object.assign(mk("span", "pt"), { textContent: p.title, title: p.title }));   // tooltip: full title when the header truncates it
    // An embedding's colouring is shown live by its colour dropdown, so a static cap (e.g. "clusters") only goes
    // stale on recolour. For embeddings the caption tracks SCOPE instead (the dropdown can't show that): the
    // scoped population when scoped, nothing when showing all cells. Other panels keep their descriptive cap.
    const capText = p.type === "Embedding" ? "" : p.cap;   // embeddings convey scope via the chip; no stale static caption
    if (capText) h.appendChild(Object.assign(mk("span", "pc"), { textContent: "· " + capText }));
    const sp = mk("div", "sp");
    if (p.type === "Embedding" || p.type === "CompositionBars") {
      // per-panel handle picker — controls THIS panel only (configure_panel), so it still works when the agent
      // or another panel uses a different colour. Embedding: any handle; Composition: which grouping it stacks by.
      const isEmb = p.type === "Embedding";
      const s = document.createElement("select"); s.className = "inline"; s.dataset.pid = String(p.id);
      const cur = p.view?.colorBy ?? (isEmb ? this.coord.state.colorBy : "meta:" + this.ctx.defaultGrouping());
      s.innerHTML = isEmb
        ? this.colorOptionsHtml(cur)
        : this.ctx.groupings().map((g) => `<option value="meta:${g}"${"meta:" + g === cur ? " selected" : ""}>${handleLabel("meta:" + g)}</option>`).join("");
      s.onchange = () => this.configurePanel(p.id, { colorBy: s.value });
      sp.appendChild(s);
      if (isEmb) {   // colour-map picker — only meaningful for NUMERIC colourings (genes/qc/scores); hidden for categoricals
        const cm = document.createElement("select"); cm.className = "inline cm"; cm.dataset.pid = String(p.id); cm.title = "colour map (numeric colourings)";
        cm.innerHTML = paletteNames().map((nm) => `<option value="${nm}"${(p.view?.colormap || "amber") === nm ? " selected" : ""}>${nm}</option>`).join("");
        cm.onchange = () => this.configurePanel(p.id, { colormap: cm.value });
        cm.style.display = this.isNumericColoring(cur) ? "" : "none";
        sp.appendChild(cm);
      }
    }
    if (p.type === "Embedding") {
      // view-option toggles — PER-PANEL display (this embedding only; panels are independent). data-pid lets
      // syncToggles() refresh each button against its own panel; the closures read the live value so repeated
      // clicks toggle correctly. coord.display is just the starting default a panel overrides.
      const pcat = !this.isNumericColoring(p.view?.colorBy ?? this.coord.state.colorBy);
      const pdisp = { ...this.coord.state.display, ...(p.view?.display || {}) };
      const setPDisp = (patch: { labels?: boolean; legend?: boolean; winsor?: number }) => { p.view = { ...p.view, display: { ...(p.view?.display || {}), ...patch } }; this.repaint(); this.syncToggles(); };
      const lblBtn = Object.assign(mk("button", "mini" + (pdisp.labels && pcat ? " on" : ""), "labels"), { title: "toggle on-plot labels (this panel)" }) as HTMLButtonElement;
      lblBtn.dataset.tg = "labels"; lblBtn.dataset.pid = String(p.id);
      lblBtn.onclick = () => setPDisp({ labels: !((p.view?.display?.labels) ?? this.coord.state.display.labels) });
      const legBtn = Object.assign(mk("button", "mini" + ((pdisp.legend ?? !pcat) ? " on" : ""), "legend"), { title: "toggle colour legend (this panel)" }) as HTMLButtonElement;
      legBtn.dataset.tg = "legend"; legBtn.dataset.pid = String(p.id);
      legBtn.onclick = () => setPDisp({ legend: !((p.view?.display?.legend) ?? this.coord.state.display.legend ?? !pcat) });
      // Winsorize the numeric colour scale — clip a % off each tail so outlier cells don't wash out the rest.
      // Only meaningful for numeric colourings (hidden for categoricals, like the colour-map picker); folds into
      // the ⋯ menu when the header is narrow. Default tracks coord.display.winsor (1%).
      const winSel = document.createElement("select"); winSel.className = "inline wins"; winSel.dataset.pid = String(p.id);
      winSel.title = "Winsorize the colour scale: clip this % off each tail so a few outlier cells don't compress the rest into the pale end";
      const curWin = (p.view?.display?.winsor) ?? this.coord.state.display.winsor ?? 0;
      winSel.innerHTML = ([["0", "off"], ["0.005", "0.5%"], ["0.01", "1%"], ["0.02", "2%"], ["0.05", "5%"]] as [string, string][])
        .map(([v, l]) => `<option value="${v}"${Number(v) === curWin ? " selected" : ""}>winsor ${l}</option>`).join("");
      winSel.onchange = () => setPDisp({ winsor: Number(winSel.value) });
      winSel.style.display = pcat ? "none" : "";
      sp.appendChild(lblBtn);   // always present (no-op for numeric colourings) so it can't vanish on recolour
      sp.appendChild(legBtn);
      sp.appendChild(winSel);
    }
    const span = Object.assign(mk("button", "mini", isFull ? "◫" : "▦"), { title: "maximize" }) as HTMLButtonElement;
    span.onclick = () => { p.full = !isFull; this.fullRender(); this.checkpoint((p.full ? "maximize · " : "restore · ") + p.title, "You resized a panel — the layout is yours to shape."); };
    const close = Object.assign(mk("button", "mini", "✕"), { title: "remove" }) as HTMLButtonElement;
    close.onclick = () => { this.canvas = this.canvas.filter((z) => z.id !== p.id); this.fullRender(); this.checkpoint("remove " + p.title, "You removed a panel — direct edits to your own layout always win."); };
    sp.appendChild(span); sp.appendChild(close);
    h.appendChild(sp); d.appendChild(h);
    const H = this.ctx.handleOf(p.bind);
    if (H?.caveat) d.appendChild(this.caveatEl(p.bind, H.caveat));
    const b = mk("div", "pbody");
    // A panel body that throws (e.g. data this dataset lacks) must NOT abort the whole render — that would
    // leave the previous workspace's DOM stale. Catch it and show an in-panel notice instead.
    let built: BuiltBody;
    try { built = await bodyFor(p, this.ctx, this.hooks()); }
    catch (err) { const m = mk("div", "panelerr"); m.textContent = `⚠ couldn't render this panel — ${(err as Error)?.message || err}`; built = { el: m }; }
    if (built.headerControls) sp.insertBefore(built.headerControls, sp.firstChild);   // e.g. a gene filter, in the header
    b.appendChild(built.el); d.appendChild(b);
    const prov = H?.prov || (this.ctx.handleOf(p.bind)?.prov);
    if (prov) d.appendChild(Object.assign(mk("div", "prov"), { textContent: "◆ " + prov }));
    // drag reorder
    h.setAttribute("draggable", "true");
    h.addEventListener("dragstart", (e) => { (this as any)._drag = p.id; (e as DragEvent).dataTransfer!.effectAllowed = "move"; d.classList.add("dragging"); });
    h.addEventListener("dragend", () => { (this as any)._drag = null; d.classList.remove("dragging"); document.querySelectorAll(".panel.dragover").forEach((x) => x.classList.remove("dragover")); });
    d.addEventListener("dragover", (e) => { const dr = (this as any)._drag; if (dr != null && dr !== p.id) { e.preventDefault(); d.classList.add("dragover"); } });
    d.addEventListener("dragleave", () => d.classList.remove("dragover"));
    d.addEventListener("drop", (e) => { e.preventDefault(); d.classList.remove("dragover");
      const r = d.getBoundingClientRect(); const after = (e as DragEvent).clientY > r.top + r.height / 2;   // lower half → drop UNDER the target
      const col = d.dataset.col === "1" ? 1 : d.dataset.col === "0" ? 0 : undefined;                          // join the target's column
      this.reorderTo((this as any)._drag, p.id, after, col); });
    d.oncontextmenu = (e) => { e.preventDefault(); this.openCtx(e.clientX, e.clientY, p); };
    return { dom: d, afterAttach: () => {
      built.afterAttach?.();
      if (p.type === "Widget" && built.widget) this.wireWidgetControls(p, h, sp, span, built.widget);   // the widget's declared toolbar controls (fold like the rest)
      installOverflow(h, sp);
    } };   // fold header controls into a ⋯ menu when the panel is too narrow
  }

  // Render a Widget panel's declared header controls as standard mini buttons (before the maximize button so they
  // fold from the end like every panel's controls). Controls known from a prior render appear synchronously (managed
  // by installOverflow); ones that arrive later (the iframe's first manifest) are added via _ovfAdd so they fold too.
  private wireWidgetControls(p: Panel, h: HTMLElement, sp: HTMLElement, beforeEl: HTMLElement, handle: { sendControl: (id: string) => void; onManifest: (cb: (m: any) => void) => void }) {
    const rendered = new Set<string>();
    const addBtn = (c: { id: string; label: string }, late: boolean) => {
      if (!c || !c.id || rendered.has(c.id)) return; rendered.add(c.id);
      const btn = Object.assign(mk("button", "mini", c.label), { title: c.label }) as HTMLButtonElement;
      btn.dataset.wcid = c.id; btn.onclick = () => handle.sendControl(c.id);
      if (late) (h as any)._ovfAdd?.(btn, beforeEl); else sp.insertBefore(btn, beforeEl);
    };
    (p.controls || []).forEach((c) => addBtn(c, false));   // before installOverflow → managed normally
    handle.onManifest((m) => { p.controls = (m?.controls || []); p.controls.forEach((c) => addBtn(c, true)); });   // first/updated manifest
  }

  // Place the canvas into a two-column grid. Default is row-major (panel i → column i%2); a panel's `col` pins it
  // to a column, so you can stack two panels in one column (e.g. 3 panels = 1 left + 2 right). The shorter
  // column's last panel spans the leftover rows so there's never an empty hole. `full` panels span both columns.
  layoutCanvas(wb: HTMLElement) {
    let rowL = 1, rowR = 1; let lastLeft: HTMLElement | null = null, lastRight: HTMLElement | null = null;
    const lone = this.canvas.length === 1;
    for (const p of this.canvas) {
      const el = wb.querySelector<HTMLElement>(`.panel[data-pid="${p.id}"]`); if (!el) continue;
      if (p.full || lone) { const r = Math.max(rowL, rowR); el.style.gridColumn = "1 / -1"; el.style.gridRow = String(r); delete el.dataset.col; rowL = rowR = r + 1; lastLeft = lastRight = null; continue; }
      // pinned → its column; unpinned → the SHORTER column so panels stay balanced (a new panel doesn't pile onto
      // an already-full column and scroll off — the stacked-dotplots-plus-UMAP case).
      const col = p.col === 0 || p.col === 1 ? p.col : (rowL <= rowR ? 0 : 1);
      if (col === 0) { el.style.gridColumn = "1"; el.style.gridRow = String(rowL++); el.dataset.col = "0"; lastLeft = el; }
      else { el.style.gridColumn = "2"; el.style.gridRow = String(rowR++); el.dataset.col = "1"; lastRight = el; }
    }
    const maxRow = Math.max(rowL, rowR) - 1;
    if (lastLeft && rowL - 1 < maxRow) lastLeft.style.gridRow = lastLeft.style.gridRow + " / " + (maxRow + 1);
    if (lastRight && rowR - 1 < maxRow) lastRight.style.gridRow = lastRight.style.gridRow + " / " + (maxRow + 1);
  }

  // Move a dragged panel next to a target, into the target's column (so you can drop a panel UNDER another to
  // stack it in that column). `after` = dropped on the lower half of the target.
  reorderTo(fromId: number, toId: number, after: boolean, col?: 0 | 1) {
    if (fromId == null || fromId === toId) return;
    const from = this.canvas.findIndex((z) => z.id === fromId); if (from < 0) return;
    const [m] = this.canvas.splice(from, 1);
    if (col === 0 || col === 1) m.col = col;
    let to = this.canvas.findIndex((z) => z.id === toId); if (to < 0) to = this.canvas.length;
    if (after) to++;
    this.canvas.splice(to, 0, m);
    this.fullRender(); this.checkpoint("move · " + m.title, "You dragged a panel — direct edits to your own layout always win.");
  }

  async repaint() {
    // REACTORS FIRST (card + table highlight) — cheap and synchronous-ish, so the UI responds immediately.
    // The embedding recolour below can be slow (a gene colouring re-derives expression); don't make the card
    // wait behind it. committed selection → each vocabulary-bound panel reads the ref in ITS grouping (direct
    // when the selection is a category of that grouping; else translated via cells).
    // Re-dispatch only when the selection actually CHANGED (or reactors were just rebuilt) — a colour-only
    // repaint leaves the selection untouched, so re-firing reactors would pointlessly re-render the card.
    const sel = this.coord.state.selection;
    if (this.reactorsStale || sel !== this.lastSel) {
      for (const r of this.compReactors) r.setSelect(sel ? new Set(this.ctx.refToCategories(sel, r.grouping).filter((t) => t.frac >= 0.08).map((t) => t.value)) : null);
      this.lastSel = sel; this.reactorsStale = false;
    }
    this.$("railBtn").innerHTML = "Answers" + (this.rail.length ? ` <span class="badge">${this.rail.length}</span>` : "");
    this.renderFocus();   // keep the global focus chip (the release control) in sync
    // embeddings AFTER — the recolour/highlight catches up a frame later (imperceptible for categorical; for a
    // gene colouring the expression is cached so a selection-only change is just a focus-mask recompute).
    for (const ev of this.embeddings) await paintEmbedding(ev, this.ctx);
  }

  // Deep per-panel view control — the agent's configure_panel verb (and the path the per-panel UI will use).
  // Merges a view patch into ONE panel's spec and repaints in place; other panels untouched. A per-panel
  // override wins over the global coord default AND over the agent's set_color (explicit/user authority).
  configurePanel(panelId: number, patch: Partial<PanelView> & { heatMode?: "heat" | "dot"; genes?: string[] }) {
    const p = this.canvas.find((z) => z.id === panelId) || this.rail.find((z) => z.id === panelId);
    if (!p) return;
    const rebuild = this.applyPanelModel(p, { colorBy: patch.colorBy, scope: patch.scope, embedding: patch.embedding, colormap: patch.colormap, heatMode: patch.heatMode, genes: patch.genes });
    if (rebuild) this.fullRender(); else { this.repaint(); this.syncColorSelects(); this.syncToggles(); }   // keep every control in step
  }

  // Mutate ONE panel's model from a patch (no render). colorBy/scope/embedding live on .view; heatMode/genes/title
  // are top-level. Returns whether the change needs a body REBUILD (vs a cheap repaint). Shared by the per-panel
  // dropdown and the declarative patcher, so both treat a panel identically.
  applyPanelModel(p: Panel, patch: { title?: string; col?: 0 | 1; full?: boolean; colorBy?: string; scope?: EntityRef | null; embedding?: string; colormap?: string; heatMode?: "heat" | "dot"; genes?: string[]; group?: string }): boolean {
    let rebuild = false;
    if (patch.title != null && patch.title !== p.title) { p.title = patch.title; rebuild = true; }   // title shows in the header (panelEl) → rebuild
    if (patch.col === 0 || patch.col === 1) { if (patch.col !== p.col) rebuild = true; p.col = patch.col;
      if (patch.full === undefined && p.full) { p.full = false; rebuild = true; } }   // a column pin means NOT full-width — clear full (it would otherwise override col and the pin would silently no-op)
    if (typeof patch.full === "boolean" && patch.full !== p.full) { p.full = patch.full; rebuild = true; }   // full-width → re-layout
    if (patch.colorBy != null) { this.noteColor(patch.colorBy); if (p.type !== "Embedding") rebuild = true; }   // recolouring a non-embedding (e.g. composition restack) needs a rebuild
    if (patch.embedding != null && patch.embedding !== p.view?.embedding) rebuild = true;
    if (patch.heatMode != null && patch.heatMode !== p.heatMode) { p.heatMode = patch.heatMode; rebuild = true; }
    if (patch.group != null && patch.group !== p.group) { p.group = patch.group; if (p.type === "Heatmap") p.bind = "markers:" + patch.group; rebuild = true; }   // re-group a Heatmap (markers/columns) or a Reconcile base
    if (patch.genes != null) { p.genes = patch.genes; rebuild = true; }
    if (patch.scope !== undefined) rebuild = true;   // scope reframes the embedding AND drives its header caption → rebuild so both update
    const v: PanelView = { ...p.view };
    if (patch.colorBy != null) v.colorBy = patch.colorBy;
    if (patch.embedding != null) v.embedding = patch.embedding;
    if (patch.colormap != null) v.colormap = patch.colormap;   // numeric palette; a recolour (repaint), no rebuild
    if (patch.scope !== undefined) { if (patch.scope === null) delete v.scope; else v.scope = patch.scope; }
    p.view = v;
    return rebuild;
  }

  // ----- declarative view patcher: the single agent surface for "what to show" -----
  // Validates the patch against the live world, executes the resulting ops, and renders ONCE. New view knobs
  // are FIELDS in the patch (see viewpatch.ts), never new methods/tools. Returns applied/rejected/notes.
  async applyViewPatch(patch: RawViewPatch): Promise<{ applied: string[]; rejected: string[]; notes: string[] }> {
    const geneSet = new Set(await this.ctx.view.genes());   // warm + snapshot the gene index so geneExists is sync
    const all = () => [...this.canvas, ...this.rail];
    const world: World = {
      panelTypes: Object.keys(REGISTRY),
      categoricals: this.ctx.categoricalFields(),
      groupings: this.ctx.groupings(),
      valuesOf: (f) => this.ctx.categoricalValues(f),
      geneExists: (s) => geneSet.has(s),
      embeddings: this.ctx.embeddingNames(),
      panelExists: (id) => all().some((p) => p.id === id),
      panelType: (id) => all().find((p) => p.id === id)?.type,
      panelGenes: (id) => all().find((p) => p.id === id)?.genes || [],
      colormaps: paletteNames(),
      normalizeColormap: normalizePalette,
    };
    const { ops, rejected, notes } = normalizeViewPatch(patch, world);
    const applied: string[] = [];
    let needFull = false, needRepaint = false;
    this.suspendRender = true;
    try {
      for (const op of ops) {
        if (op.kind === "color") { for (const p of this.canvas) if (p.type === "Embedding" && p.view?.colorBy) delete p.view.colorBy; this.noteColor(op.handle); this.coord.setColor(op.handle); applied.push(`colour → ${handleLabel(op.handle)}`); needRepaint = true; }
        else if (op.kind === "focus") { const r = this.focusFromOp(op); if (r.error) rejected.push(r.error); else { applied.push(`focus → ${r.label}`); needFull = true; } }   // needFull: the reconcile table re-filters to the focus
        else if (op.kind === "clearFocus") { this.coord.clearFocus(); applied.push("released focus"); needFull = true; }
        else if (op.kind === "select") { this.coord.setSelection({ kind: "category", grouping: op.dim!, value: op.value! }); applied.push(`select → ${op.dim} = ${op.value}`); needRepaint = true; }
        else if (op.kind === "clearSelect") { this.coord.setSelection(null); applied.push("cleared selection"); needRepaint = true; }
        else if (op.kind === "display") {   // display is per-panel — a top-level display patch fans out to every embedding (so "show labels" applies to all, with no global coupling)
          for (const p of this.canvas) if (p.type === "Embedding") p.view = { ...p.view, display: { ...(p.view?.display || {}), ...op.patch } };
          applied.push(`display ${JSON.stringify(op.patch)}`); needRepaint = true;
        }
        else if (op.kind === "addPanel") { const id = this.addPanelModel(op.spec); applied.push(`+#${id} ${op.spec.type}${op.spec.heatMode === "dot" ? " · dotplot" : ""}`); needFull = true; }
        else if (op.kind === "configPanel") { const p = all().find((z) => z.id === op.id); if (p) { if (this.applyPanelModel(p, this.patchToModel(op.patch))) needFull = true; needRepaint = true; applied.push(`#${op.id} ${Object.keys(op.patch).join("/")}`); } }
        else if (op.kind === "removePanel") { this.removePanel(op.id); applied.push(`–#${op.id}`); needFull = true; }
        else if (op.kind === "facet") {
          // Split ONE panel into N copies that differ ONLY in scope — identical group/genes/mode (Heatmap) or
          // the same projection reframed (Embedding). The agent can't diverge the facets the way hand-built
          // scoped panels can. Source: explicit id (workbench), else the most recent Heatmap, else Embedding.
          let src: Panel | undefined;
          if (op.panel != null) { src = this.canvas.find((p) => p.id === op.panel); if (!src) notes.push(`facet: panel #${op.panel} is not on the workbench`); }
          else src = [...this.canvas].reverse().find((p) => p.type === "Heatmap") || [...this.canvas].reverse().find((p) => p.type === "Embedding");
          if (!src) { if (op.panel == null) notes.push("facet: add a Heatmap or Embedding first"); }
          else {
            const idx = this.canvas.findIndex((p) => p.id === src!.id);
            // The facet value is shown by a protected scope CHIP in the header (derived from view.scope), so the
            // title stays the clean base name — the distinguishing value never falls victim to title truncation.
            const base = src.title;
            const layout = op.layout === "auto" ? (src.type === "Embedding" ? "side" : "stack") : op.layout;
            const facets = op.values.map((val, k) => {
              const view: PanelView = { ...(src!.view || {}) };
              view.scope = { kind: "category", grouping: op.by, value: val } as EntityRef;
              const spec: Partial<Panel> = { type: src!.type, title: base, cap: src!.cap, group: src!.group, heatMode: src!.heatMode, genes: src!.genes ? [...src!.genes] : undefined, bind: src!.bind, view };
              if (layout === "stack") spec.full = true; else { spec.col = (k % 2) as 0 | 1; spec.full = false; }
              return this.newPanel(spec);
            });
            this.canvas.splice(idx, 1, ...facets);
            applied.push(`facet ${base} by ${op.by} → ${op.values.join(", ")}`); needFull = true;
          }
        }
        else if (op.kind === "arrange") {
          // pure rearrangement: reposition EXISTING panels (col/full + order) — never recreates a panel, so it
          // can't drop or duplicate a scope the way the agent did when it rebuilt panels to "rearrange".
          const byId = new Map(this.canvas.map((p) => [p.id, p]));
          const placed: Panel[] = [];
          for (const pl of op.place) { const p = byId.get(pl.id); if (!p) continue; p.col = pl.col; p.full = pl.full; placed.push(p); byId.delete(pl.id); }
          this.canvas = [...placed, ...this.canvas.filter((p) => byId.has(p.id))];   // grid order first, any unmentioned panels after
          applied.push(`arrange ${placed.length} panels`); needFull = true;
        }
      }
    } finally { this.suspendRender = false; }
    if (needFull) this.fullRender(); else if (needRepaint) { this.repaint(); this.syncColorSelects(); this.syncToggles(); }
    return { applied, rejected, notes };
  }

  // ----- annotation layers -----
  // Register/refresh a rich layer: mirror its codes into ctx (so it's a first-class categorical everywhere)
  // and keep the rich object (records/provenance) app-side. Re-renders so panels keyed to it update.
  commitLayer(layer: AnnotationLayer, render = true): void {
    compact(layer);   // any edit can empty a category (relabel its last cells, merge) — drop empties so no
    this.annoLayers.set(layer.name, layer);   // phantom 0-cell label lingers anywhere it's listed
    this.ctx.setAnnotationLayer(layer.name, layer.codes, layer.categories);
    invalidateColor(layer.name);   // the overlay changed (often a new category) → drop the stale colour-cache snapshot
    if (layer.name === "annotation") this.refreshHierarchyLevels(layer);   // derive coarser-level groupings from the lineage
    if (render) this.fullRender();
  }
  // Derive the coarser hierarchy levels of the working draft (rolled up by each label's lineage path in
  // record.category, e.g. "Myeloid > Monocyte") and register them as groupings "annotation: L1 …". Base case
  // (no lineage anywhere) → depth 1 → no derived groupings, so a flat one-level annotation stays clutter-free.
  refreshHierarchyLevels(layer: AnnotationLayer): void {
    this.ctx.clearDerivedGroupings();
    const depth = hierarchyDepth(layer.categories, layer.records);
    for (let lvl = 1; lvl < depth; lvl++) {   // level 1 = coarsest … depth = the finest (the layer itself)
      const r = rollupToLevel(layer.codes, layer.categories, layer.records, lvl);
      this.ctx.setDerivedGrouping(`annotation: L${lvl}`, r.codes, r.categories);
      invalidateColor(`annotation: L${lvl}`);
    }
  }
  // Begin a working annotation draft by seeding the `annotation` layer from an existing categorical
  // (cell_type if present, else clusters) — non-destructive; the base grouping is untouched. Colours by it.
  async startAnnotation(from?: string): Promise<{ ok?: string; error?: string }> {
    const src = from || (this.ctx.groupings().includes("cell_type") ? "cell_type" : "leiden");
    let m: any; try { m = await this.ctx.view.metadata(src); } catch { return { error: `no field "${src}"` }; }
    if (m.kind !== "categorical") return { error: `"${src}" is not categorical` };
    const layer = seedLayer("annotation", "derived", { codes: m.codes, categories: m.categories });
    layer.provenance = { method: "seed", params: { from: src } };
    this.commitLayer(layer, false);
    this.noteColor("meta:annotation"); this.coord.setColor("meta:annotation");
    this.fullRender();
    return { ok: `started annotation draft from ${src} (${layer.categories.length} labels)` };
  }
  // Run scType-style marker scoring over the base clustering → a new annotation SOURCE layer ("scType").
  // Serverless: reuses the group means we already compute; resolves the bundled marker DB to gene indices,
  // z-scores across clusters, assigns each cluster its top cell type, broadcasts to cells (confidence = margin).
  async runScType(opts?: { base?: string; db?: MarkerDB }): Promise<{ ok?: string; error?: string }> {
    const base = opts?.base || (this.ctx.groupings().includes("leiden") ? "leiden" : this.ctx.defaultGrouping());
    const baseMeta: any = await this.ctx.view.metadata(base);
    if (baseMeta.kind !== "categorical") return { error: `base "${base}" is not categorical` };
    const gs = await this.ctx.groupStatsCached(base);
    await this.ctx.view.genes();
    const db = opts?.db || PBMC_MARKERS;
    const markerIdx: Record<string, MarkerIdx> = {};
    for (const [ct, set] of Object.entries(db)) {
      const pos: number[] = [], neg: number[] = [];
      for (const s of set.positive) { const gi = await this.ctx.view.geneCol(s); if (gi != null) pos.push(gi); }
      for (const s of (set.negative || [])) { const gi = await this.ctx.view.geneCol(s); if (gi != null) neg.push(gi); }
      if (pos.length) markerIdx[ct] = { positive: pos, negative: neg };
    }
    if (!Object.keys(markerIdx).length) return { error: "no marker genes from the DB are present in this dataset" };
    const assigned = assignClusters(scoreClusters(zscoreByGroup(gs.mean, gs.groups.length, gs.nGenes), gs.groups.length, gs.nGenes, markerIdx));
    const cats: string[] = []; const catIdx = new Map<string, number>();
    const groupToCat = assigned.map((a) => { let i = catIdx.get(a.cellType); if (i == null) { i = cats.length; cats.push(a.cellType); catIdx.set(a.cellType, i); } return i; });
    const codes = new Int32Array(baseMeta.codes.length), conf = new Float32Array(baseMeta.codes.length);
    for (let i = 0; i < codes.length; i++) { const g = baseMeta.codes[i]; if (g >= 0 && g < groupToCat.length) { codes[i] = groupToCat[g]; conf[i] = assigned[g].margin; } else codes[i] = -1; }
    const layer: AnnotationLayer = { name: "scType", source: "sctype", codes, categories: cats, confidence: conf, records: {}, provenance: { method: "scType", params: { base, db: opts?.db ? "custom" : "PBMC_MARKERS" } } };
    setConfValues("scType", conf);   // colour by conf:scType to see low-confidence (ambiguous) cells
    this.commitLayer(layer);
    return { ok: `scType labeled ${gs.groups.length} ${base} clusters → ${cats.length} cell types (${cats.slice(0, 5).join(", ")}${cats.length > 5 ? "…" : ""})` };
  }

  // Run a CellTypist (logistic-regression) model IN-BROWSER → a per-cell "CellTypist" source layer. Sparse
  // accumulation (gene-by-gene into logits) so a real multi-thousand-gene model never materializes a dense X.
  // A trained model (genes/classes/W/b) must be provided — converting CellTypist's .pkl is a pending asset.
  async runCellTypist(model: LRModel): Promise<{ ok?: string; error?: string }> {
    if (!model?.genes?.length || !model?.classes?.length) return { error: "invalid model (need genes, classes, W, b)" };
    const C = model.classes.length, N = this.ctx.n;
    const logits = new Float64Array(N * C);
    for (let i = 0; i < N; i++) { const lb = i * C; for (let c = 0; c < C; c++) logits[lb + c] = model.b[c] || 0; }
    let present = 0;
    for (let g = 0; g < model.genes.length; g++) {
      const gi = await this.ctx.view.geneCol(model.genes[g]); if (gi == null) continue; present++;
      const { values } = await this.ctx.view.geneExpression(model.genes[g]); const wb = g * C;
      for (let i = 0; i < N; i++) { const x = values[i]; if (!x) continue; const lb = i * C; for (let c = 0; c < C; c++) logits[lb + c] += x * model.W[wb + c]; }
    }
    if (!present) return { error: "none of the model's genes are present in this dataset" };
    const { codes, conf } = lrFinalize(logits, N, C);
    const layer: AnnotationLayer = { name: "CellTypist", source: "celltypist", codes, categories: model.classes.slice(), confidence: conf, records: {}, provenance: { method: "CellTypist", params: { genes: `${present}/${model.genes.length}` } } };
    setConfValues("CellTypist", conf);
    this.commitLayer(layer);
    return { ok: `CellTypist labeled ${N} cells using ${present}/${model.genes.length} model genes → ${new Set(codes).size} classes` };
  }

  // Ensure the Annotate workspace has something to work with: a working draft (seeded from cell_type/clusters,
  // non-destructive, no colour change) + at least one computed source (scType). Re-renders when ready.
  async ensureAnnotation(): Promise<void> {
    if (!this.annoLayers.has("annotation")) {
      const src = this.ctx.groupings().includes("cell_type") ? "cell_type" : "leiden";
      const m: any = await this.ctx.view.metadata(src);
      if (m.kind === "categorical") { const layer = seedLayer("annotation", "derived", { codes: m.codes, categories: m.categories }); layer.provenance = { method: "seed", params: { from: src } }; this.commitLayer(layer, true); }   // render NOW — the table + card appear immediately
    }
    // compute scType in the BACKGROUND (it re-renders to add its column when ready) — don't block the first paint
    if (!this.annoLayers.has("scType")) this.runScType();
    // pre-warm the working draft's per-label markers (a ~2s DE) in the background, so the FIRST record card's
    // marker-evidence chips appear instantly instead of sitting on "computing…" after the first row click.
    if (this.annoLayers.has("annotation")) this.ctx.markers("annotation").catch(() => {});
  }

  // Adopt a source as the WORKING draft: set every base cluster to that source's dominant label, in ONE
  // commit (no orphan labels, no per-cluster render churn). The fast "start from scType / from cell_type".
  async adoptSource(sourceName: string, base?: string): Promise<{ ok?: string; error?: string }> {
    const ctx = this.ctx;
    const b = base || (ctx.groupings().includes("leiden") ? "leiden" : ctx.defaultGrouping());
    let baseMeta: any, srcMeta: any;
    try { baseMeta = await ctx.view.metadata(b); srcMeta = await ctx.view.metadata(sourceName); } catch { return { error: `unknown field "${sourceName}"` }; }
    if (baseMeta.kind !== "categorical" || srcMeta.kind !== "categorical") return { error: "base/source not categorical" };
    const rows = reconcile({ codes: baseMeta.codes, categories: baseMeta.categories }, [{ name: sourceName, codes: srcMeta.codes, categories: srcMeta.categories }]);
    const cats: string[] = []; const idx = new Map<string, number>();
    const groupToCat = rows.map((r) => { const l = r.sources[0].label; if (l == null) return -1; let i = idx.get(l); if (i == null) { i = cats.length; cats.push(l); idx.set(l, i); } return i; });
    const codes = new Int32Array(baseMeta.codes.length);
    for (let i = 0; i < codes.length; i++) { const g = baseMeta.codes[i]; codes[i] = (g >= 0 && g < groupToCat.length) ? groupToCat[g] : -1; }
    const layer: AnnotationLayer = { name: "annotation", source: "derived", codes, categories: cats, records: this.annoLayers.get("annotation")?.records || {}, provenance: { method: "adopt", params: { from: sourceName, base: b } } };
    this.commitLayer(layer);
    return { ok: `adopted ${sourceName} → working draft (${cats.length} labels over ${rows.length} ${b} clusters)` };
  }

  // Import an EXTERNAL cluster-level labeling as a new source layer (CellTypist/Azimuth output, a colleague's
  // annotation pasted in chat) — so sources aren't limited to what's pre-baked in the store. labels maps base
  // cluster values → cell-type labels; broadcast to cells.
  async importLabeling(opts: { name?: string; base?: string; labels: Record<string, string> }): Promise<{ ok?: string; error?: string }> {
    if (!opts.labels || typeof opts.labels !== "object") return { error: "labels (a {cluster: label} map) is required" };
    const base = opts.base && this.ctx.groupings().includes(opts.base) ? opts.base : (this.ctx.groupings().includes("leiden") ? "leiden" : this.ctx.defaultGrouping());
    let baseMeta: any; try { baseMeta = await this.ctx.view.metadata(base); } catch { return { error: `unknown base "${base}"` }; }
    if (baseMeta.kind !== "categorical") return { error: `base "${base}" is not categorical` };
    const cats: string[] = []; const idx = new Map<string, number>();
    const groupToCat = baseMeta.categories.map((cl: string) => { const lab = opts.labels[cl]; if (lab == null) return -1; let i = idx.get(lab); if (i == null) { i = cats.length; cats.push(lab); idx.set(lab, i); } return i; });
    const matched = groupToCat.filter((x: number) => x >= 0).length;
    if (!matched) return { error: `no ${base} clusters matched the provided keys (base has: ${baseMeta.categories.slice(0, 10).join(", ")}…)` };
    const codes = new Int32Array(baseMeta.codes.length);
    for (let i = 0; i < codes.length; i++) { const g = baseMeta.codes[i]; codes[i] = (g >= 0 && g < groupToCat.length) ? groupToCat[g] : -1; }
    const name = (opts.name || "imported").replace(/[^\w .+-]/g, "").slice(0, 24) || "imported";
    const layer: AnnotationLayer = { name, source: "imported", codes, categories: cats, records: {}, provenance: { method: "import", params: { base } } };
    this.commitLayer(layer);
    return { ok: `imported "${name}": ${matched}/${baseMeta.categories.length} ${base} clusters → ${cats.length} labels (${cats.slice(0, 5).join(", ")}${cats.length > 5 ? "…" : ""})` };
  }

  // Resolve a cell-set expression (the same algebra as compute) to indices — used by the annotate tool.
  resolveCells(spec: CellSet): { ids: Int32Array; error?: string } {
    const ctx = this.ctx;
    const world: CellWorld = { categoricals: ctx.categoricalFields(), valuesOf: (f) => ctx.categoricalValues(f), hasSelection: ctx.selectedCells().length > 0, hasFocus: !!ctx.coord.state.focus };
    const e = validateCellSet(spec, world, "cells"); if (e) return { ids: new Int32Array(0), error: e };
    const env: CellEnv = { n: ctx.n, category: (g, v) => ctx.cellsOfCategory(g, v), selection: () => ctx.selectedCells(), focus: () => ctx.coord.state.focus?.ids ?? [] };
    return { ids: Int32Array.from(resolveCellSet(spec, env)) };
  }

  // Resolve a focus op (a category dim=value OR a cell-set) into the committed focus restriction.
  focusFromOp(op: { dim?: string; value?: string; set?: any; label?: string }): { label?: string; error?: string } {
    let ids: Int32Array, spec: any, label = op.label || "subset";
    if (op.set) { const r = this.resolveCells(op.set); if (r.error) return { error: `focus: ${r.error}` }; if (!r.ids.length) return { error: "focus: that set is empty" }; ids = r.ids; spec = op.set; }
    else if (op.dim && op.value) { ids = Int32Array.from(this.ctx.cellsOfCategory(op.dim, op.value)); spec = { category: { grouping: op.dim, value: op.value } }; label = op.label || `${op.dim} = ${op.value}`; }
    else return { error: "focus: need dim+value or a set" };
    this.coord.setFocus({ label, ids, spec }); return { label };
  }
  // Release the focus restriction (the UI control + agent clearFocus both land here).
  releaseFocus(): void { if (this.coord.state.focus) { this.coord.clearFocus(); this.fullRender(); } }

  // SPLIT a working label: isolate its cells (focus), so the user can brush a sub-population in the embedding
  // and label it (the existing brush → "Label as…" flow) — the rest keep the original label. Reuses focus +
  // selection rather than a bespoke mechanism. (Merge is the inverse — rename-to-existing, in the card.)
  splitLabel(label: string): void {
    const ids = this.ctx.cellsOfCategory("annotation", label);
    if (!ids.length) { this.toast(`“${label}” has no cells to split`, null); return; }
    this.coord.setFocus({ label, ids: Int32Array.from(ids), spec: { category: { grouping: "annotation", value: label } } });
    this.fullRender();
    this.toast(`Splitting “${label}” (${ids.length.toLocaleString()} cells)`, `Shift-drag a subset in the embedding and "Label as…" to break it out — the rest stay “${label}”. "show all" when done.`);
  }

  // A compact reconciliation read-out for the agent: per base cluster, every source's dominant label, plus
  // which clusters the sources DISAGREE on (string-wise — vocabulary differences included; the agent judges).
  async reconciliationSummary(input?: { base?: string }): Promise<string> {
    const ctx = this.ctx;
    const base = input?.base && ctx.groupings().includes(input.base) ? input.base : (ctx.groupings().includes("leiden") ? "leiden" : ctx.defaultGrouping());
    const baseMeta: any = await ctx.view.metadata(base);
    const srcNames = ctx.annotationSources();
    if (!srcNames.length) return "no annotation sources yet — run_annotation (e.g. scType) or add a labeling first.";
    const sources: { name: string; codes: ArrayLike<number>; categories: string[] }[] = [];
    for (const n of srcNames) { const m: any = await ctx.view.metadata(n); if (m.kind === "categorical") sources.push({ name: n, codes: m.codes, categories: m.categories }); }
    const rows = reconcile({ codes: baseMeta.codes, categories: baseMeta.categories }, sources);
    const lines = rows.map((r) => `${base} ${r.group} (${r.n}): ${r.sources.map((s) => `${s.name}=${s.label ?? "—"}${s.frac < 0.7 && s.alt ? `(${(s.frac * 100).toFixed(0)}%, also ${s.alt} ${((s.altFrac || 0) * 100).toFixed(0)}%)` : ""}`).join(", ")}`);
    const diff = rows.filter((r) => { const o = r.sources.map((s) => s.label).filter(Boolean); return o.length > 1 && !o.every((l) => l === o[0]); });
    const split = rows.filter((r) => r.sources.some((s) => s.frac < 0.7 && s.alt));
    return `base=${base}, sources=${srcNames.join("/")}.\n${lines.join("\n")}\n\n${diff.length} clusters where sources differ (often just VOCABULARY — weigh the matrix + markers): ${diff.map((r) => r.group).join(", ") || "none"}.\n${split.length} clusters a source SPLITS (labels don't map 1:1 to this clustering): ${split.map((r) => r.group).join(", ") || "none"} — for those, the cluster table can't fully resolve it; use the confusion matrix and label the sub-population (annotate with an intersect cell-set, or the user brushes it), or reconcile against a finer clustering.`;
  }

  // Classify obs fields (agent-inferred / user override): which are annotation sources, partitions, covariates,
  // QC. Changes which fields the reconcile panel offers as sources. Re-renders so the panel updates.
  setFieldRoles(patch: { annotation?: string[]; partition?: string[]; covariate?: string[]; qc?: string[] }): string {
    const applied: string[] = [];
    for (const role of ["annotation", "partition", "covariate", "qc"] as const) {
      for (const n of (patch[role] || [])) { if (this.ctx.categoricalFields().includes(n) || this.ctx.annotationLayers().includes(n)) { this.ctx.setFieldRole(n, role); applied.push(`${n}=${role}`); } }
    }
    if (applied.length) this.fullRender();
    return applied.length ? `roles set: ${applied.join(", ")}` : "no valid fields in the patch";
  }

  // Rename a label (rename-in-place keeps its colour/index stable). Renaming to an EXISTING label MERGES
  // the two (the core "two of my labels are the same cell type" action). Carries the CAP record.
  renameLabel(layerName: string, from: string, to: string): { ok?: string; error?: string } {
    const layer = this.annoLayers.get(layerName); if (!layer) return { error: `no layer "${layerName}"` };
    to = (to || "").trim(); if (!to) return { error: "empty label" };
    if (layer.categories.indexOf(from) < 0) return { error: `no label "${from}"` };
    if (from === to) return { ok: "unchanged" };
    const merged = layer.categories.indexOf(to) >= 0;
    this.applyRename(layer, from, to);
    this.commitLayer(layer);   // commitLayer compacts → a merge's emptied "from" slot is dropped
    return { ok: merged ? `merged "${from}" into "${to}"` : `renamed "${from}" → "${to}"` };
  }
  // Rename/merge on the layer object WITHOUT committing (so batch ops can apply many, then render once).
  // Returns the resulting label name, or null if `from` is missing. Renaming to an existing label MERGES.
  private applyRename(layer: AnnotationLayer, from: string, to: string): string | null {
    to = (to || "").trim(); if (!to) return from;
    const fi = layer.categories.indexOf(from); if (fi < 0) return null;
    if (from === to) return to;
    layer.records = layer.records || {};
    const ti = layer.categories.indexOf(to);
    if (ti >= 0) {   // MERGE from → to (codes reassigned; emptied slot compacted at commit)
      for (let i = 0; i < layer.codes.length; i++) if (layer.codes[i] === fi) layer.codes[i] = ti;
      if (layer.records[from] && !layer.records[to]) layer.records[to] = { ...layer.records[from], label: to };
      delete layer.records[from];
      return to;
    }
    layer.categories[fi] = to;   // RENAME in place (keeps colour index stable)
    if (layer.records[from]) { layer.records[to] = { ...layer.records[from], label: to }; delete layer.records[from]; }
    return to;
  }

  // AGENT-ASSIST: write an agent's proposed CAP record onto a working-draft label (merge over any existing
  // fields). Optionally renames the label (name) — the core "the agent suggests a clean name" action. The
  // record card re-renders and badges it ✨ as a reviewable suggestion the user can edit/keep. (propose_label tool.)
  proposeLabel(input: any): { ok?: string; error?: string } {
    const layerName = "annotation";
    let layer = this.annoLayers.get(layerName); if (!layer) return { error: "no working annotation draft — adopt a source or label some cells first" };
    let label = String(input?.label || "").trim();
    if (!label || !layer.categories.includes(label)) return { error: `no label "${label}" in the working draft (labels: ${layer.categories.slice(0, 12).join(", ")})` };
    const newName = input?.name && String(input.name).trim();
    if (newName && newName !== label) { this.renameLabel(layerName, label, newName); label = newName; layer = this.annoLayers.get(layerName)!; }
    layer.records = layer.records || {};
    const prev = layer.records[label] || { label };
    const arr = (v: any) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;
    layer.records[label] = { ...prev, label,
      fullName: input.fullName ?? prev.fullName,
      synonyms: arr(input.synonyms) ?? prev.synonyms,
      category: input.category ?? prev.category,
      ontologyTermId: input.ontologyTermId ?? prev.ontologyTermId,
      ontologyTerm: input.ontologyTerm ?? prev.ontologyTerm,
      canonicalMarkers: arr(input.canonicalMarkers) ?? prev.canonicalMarkers,
      rationale: input.rationale ?? prev.rationale,
      suggested: true,
    };
    // select the resulting label so the record card reliably FOLLOWS the suggestion (and survives the rename) —
    // a valid current label, not a stale name. This is the single source of truth the card reads after re-render.
    this.coord.setSelection({ kind: "category", grouping: "annotation", value: label });
    this.fullRender();   // refresh the open record card so the suggestion shows
    return { ok: `proposed “${label}”${newName && newName !== input.label ? ` (renamed from “${input.label}”)` : ""}` };
  }

  // BATCH agent-assist — apply MANY proposed records in ONE call (the reliable path for "name all my clusters":
  // a single tool call beats hoping the model fans out N separate propose_label calls). Renames are applied
  // without per-item render; one commit at the end compacts + re-renders.
  proposeLabels(proposals: any[]): { ok?: string; error?: string } {
    const layer = this.annoLayers.get("annotation"); if (!layer) return { error: "no working annotation draft — adopt a source or label some cells first" };
    layer.records = layer.records || {};
    const arr = (v: any) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;
    let applied = 0; const skipped: string[] = [];
    for (const p of proposals || []) {
      let label = String(p?.label || "").trim();
      if (!label || !layer.categories.includes(label)) { if (label) skipped.push(label); continue; }
      const newName = p?.name && String(p.name).trim();
      if (newName && newName !== label) { const r = this.applyRename(layer, label, newName); if (r) label = r; }
      const prev = layer.records[label] || { label };
      layer.records[label] = { ...prev, label,
        fullName: p.fullName ?? prev.fullName, synonyms: arr(p.synonyms) ?? prev.synonyms,
        category: p.category ?? prev.category, ontologyTermId: p.ontologyTermId ?? prev.ontologyTermId,
        ontologyTerm: p.ontologyTerm ?? prev.ontologyTerm, canonicalMarkers: arr(p.canonicalMarkers) ?? prev.canonicalMarkers,
        rationale: p.rationale ?? prev.rationale, suggested: true };
      applied++;
    }
    if (!applied) return { error: `no proposals applied${skipped.length ? ` (unknown labels: ${skipped.slice(0, 6).join(", ")})` : ""}` };
    this.commitLayer(layer);   // one render + compact + colour-cache invalidate
    return { ok: `proposed ${applied} label${applied > 1 ? "s" : ""}${skipped.length ? ` (skipped ${skipped.length} unknown)` : ""}` };
  }

  // UI → agent: ask the agent to propose a CAP record for ONE working label, marker-grounded. Scopes the
  // request to that label's cells and seeds the prompt with its top DE markers, so the agent reasons from
  // THIS dataset, not priors alone. Its propose_label call populates the record card.
  async proposeRecord(label: string, layerName = "annotation"): Promise<void> {
    const layer = this.annoLayers.get(layerName); if (!layer) return;
    const idx = layer.categories.indexOf(label); if (idx < 0) return;
    let n = 0; for (const c of layer.codes) if (c === idx) n++;
    let markers: string[] = [];
    try { const mm = await this.ctx.markers(layerName); markers = (mm.get(label) || []).slice(0, 14).map((m: any) => m.symbol); } catch {}
    const ids = this.ctx.cellsOfCategory(layerName, label);
    const scope = { type: "selection", ids: Array.from(ids), summary: `${label} (${n} cells)` } as any;
    this.agent.ask(`Propose a CAP cell-type record for the working-draft label "${label}" (${n} cells). Top differentially-expressed markers for these cells in THIS dataset: ${markers.join(", ") || "(none computed — compute markers if useful)"}. Suggest a clean cell-type NAME (rename if "${label}" is a cluster id or vague), a fullName, a parent CATEGORY, the best Cell-Ontology term (ontologyTermId CL:xxxx + ontologyTerm), canonicalMarkers, and a 1–2 sentence RATIONALE grounded in those markers. Call propose_label once with the fields. Be concise.`, scope);
  }

  // UI → agent: batch — propose names + short rationales for every populated working-draft cluster at once,
  // grounded in each cluster's markers. The fast "name my clusters" pass after adopt_source.
  async proposeAllNames(layerName = "annotation"): Promise<void> {
    const layer = this.annoLayers.get(layerName); if (!layer) { this.toast("No working annotation draft yet", "Adopt a source or label some cells first."); return; }
    const counts = new Int32Array(layer.categories.length); for (const c of layer.codes) if (c >= 0) counts[c]++;
    const targets = layer.categories.filter((_, i) => counts[i] > 0);
    if (!targets.length) return;
    let mm: any; try { mm = await this.ctx.markers(layerName); } catch {}
    const lines = targets.map((c) => `- "${c}": ${mm ? (mm.get(c) || []).slice(0, 10).map((m: any) => m.symbol).join(", ") : ""}`);
    this.agent.ask(`Propose clean cell-type names with 1-line marker-grounded rationales for the working annotation draft's clusters. Call propose_labels ONCE with a proposals array — one entry per cluster: {label (the current name, verbatim), name (clean cell type — rename cluster-ids/vague labels; keep good ones), rationale, category, ontologyTermId (CL:xxxx if confident)}. Do NOT make separate calls or write prose first — emit the single propose_labels call. Clusters and their top markers:\n${lines.join("\n")}`);
  }

  // Label a cell set in a layer (default the working draft). Last-write-wins; re-renders.
  labelCells(cellIds: ArrayLike<number>, label: string, layerName = "annotation"): void {
    let layer = this.annoLayers.get(layerName);
    if (!layer) { layer = seedLayer(layerName, "manual", { codes: new Int32Array(this.ctx.view.nCells).fill(-1), categories: [] }); }
    setLabel(layer, cellIds, label);
    this.commitLayer(layer);
  }

  // Build a Panel from a normalized PanelSpec — view fields into .view, bind/group set per type.
  private specToPanel(spec: PanelSpec): Partial<Panel> {
    const view: PanelView = {};
    if (spec.colorBy) view.colorBy = spec.colorBy;
    if (spec.scope) view.scope = { kind: "category", grouping: spec.scope.grouping, value: spec.scope.value };
    if (spec.embedding) view.embedding = spec.embedding;
    if (spec.colormap) view.colormap = spec.colormap;
    const isHeat = spec.type === "Heatmap";
    const grp = isHeat ? (spec.group || this.ctx.defaultGrouping()) : undefined;
    return { type: spec.type, title: spec.title || spec.type, col: spec.col, full: spec.full, group: grp, heatMode: spec.heatMode, genes: spec.genes,
      bind: spec.type === "Embedding" ? "embedding:main" : (isHeat ? "markers:" + grp : undefined),
      view: Object.keys(view).length ? view : undefined };
  }
  addPanelModel(spec: PanelSpec): number { const p = this.newPanel(this.specToPanel(spec)); this.canvas.push(p); return p.id; }
  removePanel(id: number): boolean { const n = this.canvas.length + this.rail.length; this.canvas = this.canvas.filter((z) => z.id !== id); this.rail = this.rail.filter((z) => z.id !== id); return this.canvas.length + this.rail.length < n; }
  private patchToModel(patch: PanelPatch) {
    return { title: patch.title, col: patch.col, full: patch.full, colorBy: patch.colorBy, embedding: patch.embedding, colormap: patch.colormap, heatMode: patch.heatMode, genes: patch.genes, group: patch.group,
      scope: patch.scope === undefined ? undefined : (patch.scope === null ? null : { kind: "category", grouping: patch.scope.grouping, value: patch.scope.value } as EntityRef) };
  }

  // ----- compute primitive: a statistic over CELL-SET expressions (the "what to derive" narrow waist) -----
  // de(A, B=complement(A)) or overdispersion(A). A/B are CellSet exprs (category/selection/focus/all + boolean
  // ops), so the agent can test ANY set it can describe — not just the pre-baked selection-vs-rest etc. Binds
  // the result to the rail (or canvas with toCanvas) and returns a summary / error for the agent.
  async runCompute(input: { stat?: string; A?: CellSet; B?: CellSet; toCanvas?: boolean; title?: string }): Promise<{ ok?: string; error?: string }> {
    const ctx = this.ctx;
    if (input.stat !== "de" && input.stat !== "overdispersion") return { error: `unknown stat "${input.stat}" — use "de" or "overdispersion"` };
    if (!input.A) { if (input.stat === "overdispersion") input.A = { all: true } as CellSet; else return { error: "A (a cell set) is required" }; }   // global variable genes when no scope given
    const world: CellWorld = { categoricals: ctx.categoricalFields(), valuesOf: (f) => ctx.categoricalValues(f), hasSelection: ctx.selectedCells().length > 0, hasFocus: !!ctx.coord.state.focus };
    const eA = validateCellSet(input.A, world, "A"); if (eA) return { error: eA };
    const Bexpr: CellSet | undefined = input.stat === "de" ? (input.B ?? ({ complement: input.A } as CellSet)) : undefined;
    if (Bexpr) { const eB = validateCellSet(Bexpr, world, "B"); if (eB) return { error: eB }; }
    const env: CellEnv = { n: ctx.n, category: (g, v) => ctx.cellsOfCategory(g, v), selection: () => ctx.selectedCells(), focus: () => ctx.coord.state.focus?.ids ?? [] };
    const Aids = [...resolveCellSet(input.A, env)];
    if (!Aids.length) return { error: `A (${describeCellSet(input.A)}) resolves to no cells` };
    await ctx.view.genes();
    const place = (spec: Partial<Panel>) => { if (input.toCanvas) this.addPanel(spec); else this.agent.addRail(spec); };

    if (input.stat === "overdispersion") {
      const hv = await ctx.view.overdispersedGenes(Aids, 1e9);   // ALL scored genes (topN caps the return; scoring is over every gene) — the panel filters/searches the full list
      if (!hv.length) return { error: "no overdispersion (store has no cell-major counts panel)" };
      const label = describeCellSet(input.A);
      place({ type: "GeneList", title: input.title || `Variable genes · ${label}`, cap: "overdispersion", bind: "hvg:scope", rows: hv.map((h) => ({ symbol: h.symbol, score: h.resid })) });
      return { ok: `top variable genes in ${label} (${Aids.length} cells), recomputed for this scope: ${hv.slice(0, 10).map((h) => h.symbol).join(", ")}` };
    }
    // de
    const Bids = [...resolveCellSet(Bexpr!, env)];
    if (!Bids.length) return { error: `B (${describeCellSet(Bexpr!)}) resolves to no cells` };
    const { ranked, panel } = await ctx.view.subsampleDE(Aids, Bids);
    const rows = ranked.map((r: any) => ({ gene: r.gene, symbol: r.symbol, lfc: r.lfc, meanA: r.meanA, meanB: r.meanB }));   // ALL tested genes — the panel filters/searches the full list (render is capped)
    const aL = describeCellSet(input.A), bL = input.B ? describeCellSet(Bexpr!) : "rest";
    place({ type: "DeTable", title: input.title || `DE · ${aL} vs ${bL}`, cap: `${aL} vs ${bL}${panel ? " · panel" : " · approx"}`, bind: "de:between", aLabel: aL, bLabel: bL, rows });
    const up = rows.filter((r: any) => r.lfc > 0).slice(0, 6).map((r: any) => r.symbol).join(", ");
    const dn = rows.filter((r: any) => r.lfc < 0).slice(0, 6).map((r: any) => r.symbol).join(", ");
    return { ok: `DE ${aL} (${Aids.length}) vs ${bL} (${Bids.length}), compared directly. Higher in ${aL}: ${up || "—"}. Higher in ${bL}: ${dn || "—"}.` };
  }

  // ----- the code escape hatch: sandboxed ad-hoc computation over a data snapshot, typed result binds to a panel -----
  async runComputeCode(input: { code?: string; genes?: string[]; grouping?: string; title?: string; toCanvas?: boolean }): Promise<{ ok?: string; error?: string }> {
    const ctx = this.ctx;
    if (typeof input.code !== "string" || !input.code.trim()) return { error: "code (an async function body returning {kind,…}) is required" };
    await ctx.view.genes();
    // build the worker snapshot: warmed categoricals, declared gene vectors, the embedding, optional grouping stats
    const cats: Record<string, { codes: any; categories: string[] }> = {};
    for (const f of ctx.categoricalFields()) { const m: any = await ctx.metaOf(f); cats[f] = { codes: m.codes, categories: m.categories }; }
    const genes: Record<string, Float32Array> = {}; const unknown: string[] = [];
    for (const sym of input.genes || []) { const s = String(sym).trim(); if (!s) continue; const gi = await ctx.view.geneCol(s); if (gi == null) { unknown.push(s); continue; } genes[s] = (await ctx.view.geneExpression(s)).values; }
    let stats: any; if (input.grouping && ctx.groupings().includes(input.grouping)) { const gs = await ctx.groupStatsCached(input.grouping); stats = { groups: gs.groups, mean: gs.mean, frac: gs.frac, nGenes: gs.nGenes }; }
    const run = await runInWorker(input.code, { n: ctx.n, cats, genes, embedding: ctx.embedding.data, stats }, 5000);
    if (!run.ok) return { error: run.error };
    const v = validateComputeResult(run.result, ctx.n);
    const note = unknown.length ? ` Unknown genes (pass exact symbols; not measured here): ${unknown.join(", ")}.` : "";
    if (v.error) return { error: v.error + (unknown.length ? ` (also: ${unknown.join(", ")} not found)` : "") };
    const res = v.result!;
    if (res.kind === "genes") {
      const hasLfc = res.rows.some((r) => r.lfc != null);
      const spec: Partial<Panel> = { type: hasLfc ? "DeTable" : "GeneList", title: res.title || "Computed genes", cap: "custom code", bind: "code:result", rows: res.rows };
      if (input.toCanvas) this.addPanel(spec); else this.agent.addRail(spec);
      return { ok: `genes table (${res.rows.length}): ${res.rows.slice(0, 8).map((r) => r.symbol).join(", ")}.${note}` };
    }
    if (res.kind === "values") {
      setCodeValues(res.label, Float32Array.from(res.values)); this.recolorAll("code:" + res.label);
      return { ok: `coloured the embedding by your computed per-cell score "${res.label}".${note}` };
    }
    if (res.kind === "note") {
      this.agent.addRail({ type: "Note", title: res.title || "Computed note", text: res.text, bind: "code:result" });
      return { ok: `added a note.${note}` };
    }
    this.coord.setSelection({ kind: "cells", ids: Int32Array.from(res.ids) });   // cells → selection
    return { ok: `selected ${res.ids.length} cells${res.label ? ` (${res.label})` : ""}.${note}` };
  }

  // "Recolour everything" — a gene click or the agent's set_color. Clears per-panel colour overrides so the
  // shared colour actually reaches every embedding (a per-panel override would otherwise shadow it), then
  // sets the global handle. Per-panel divergence is reserved for deliberate dropdown / configure_panel use.
  recolorAll(handle: string) {
    this.noteColor(handle);
    let cleared = false;
    for (const p of this.canvas) if (p.type === "Embedding" && p.view?.colorBy) { delete p.view.colorBy; cleared = true; }
    if (this.coord.state.colorBy !== handle) this.coord.setColor(handle);              // subscribe → repaint + sync
    else if (cleared) { this.repaint(); this.syncColorSelects(); this.syncToggles(); } // same handle, but overrides dropped
  }

  // The light hover path — no recolour, no checkpoint. The hint is a typed EntityRef; each receiver reads it:
  //  embeddings — a CELL hint → crosshairs at that cell (in EACH panel's own embedding, so a hover marks it
  //  in the before AND after at once); a CATEGORY hint → a light overlay lifting that category's cells.
  //  vocabulary panels — interpret the ref in their grouping (a cell → the category it falls in; a category →
  //  direct if same grouping, else translate via cells). Cross-vocabulary translation is gated to cheap stores.
  async repaintHint() {
    const hint = this.coord.state.hint;
    if (!hint) { for (const ev of this.embeddings) { ev.setCrosshairCell(null); ev.setHighlightCells(null); } }
    else if (hint.kind === "cells" && hint.ids.length === 1) { const i = hint.ids[0]; for (const ev of this.embeddings) { ev.setCrosshairCell(i); ev.setHighlightCells(null); } }
    else { const ids = this.ctx.translateCheap() ? this.ctx.refToCells(hint) : null; for (const ev of this.embeddings) { ev.setCrosshairCell(null); ev.setHighlightCells(ids); } }
    for (const r of this.compReactors) {
      const cheap = hint && (hint.kind === "cells" ? hint.ids.length <= 1 : hint.grouping === r.grouping);
      const cats = hint && (cheap || this.ctx.translateCheap()) ? this.ctx.refToCategories(hint, r.grouping) : [];
      r.setHover(cats.length ? new Set(cats.filter((t) => t.frac >= 0.08).map((t) => t.value)) : null);
    }
  }

  // A dismissable caveat banner — click anywhere on it to collapse to a small ⚠ chip (click again to restore).
  // Kept per handle so it stays collapsed across re-renders; the methodology is one click away, never lost.
  caveatEl(bind: string | undefined, text: string): HTMLElement {
    const cv = mk("div", "caveat" + (bind && this.caveatsCollapsed.has(bind) ? " collapsed" : ""));
    cv.innerHTML = `<b>⚠ caveat</b><span>${text}</span>`;
    cv.title = "click to collapse / restore";
    cv.onclick = () => { const c = cv.classList.toggle("collapsed"); if (bind) c ? this.caveatsCollapsed.add(bind) : this.caveatsCollapsed.delete(bind); };
    return cv;
  }

  newPanel(p: Partial<Panel>): Panel { return { id: ++this.uid, type: p.type!, title: p.title || p.type!, cap: p.cap, full: p.full, col: p.col, bind: p.bind, text: p.text, q: p.q, group: p.group, gene: p.gene, aLabel: p.aLabel, bLabel: p.bLabel, heatMode: p.heatMode, genes: p.genes, view: p.view, split: p.split, rows: p.rows, source: p.source, controls: p.controls }; }

  // Add a configured panel to the canvas — the composition atom (the agent's add_panel). Additive and
  // checkpointed (so it's non-disorienting and reversible); returns the new id so it can be configure_panel'd.
  addPanel(spec: Partial<Panel>): number {
    const p = this.newPanel(spec); this.canvas.push(p);
    this.fullRender(); this.checkpoint("add panel · " + p.title, "The agent extended your workbench additively — nothing existing moved, and it's a checkpoint you can step back from.");
    return p.id;
  }

  // ---------- rail ----------
  setRail(open: boolean) { this.$("rail").classList.toggle("open", open); this.$("railBtn").classList.toggle("on", open); }
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
      h.appendChild(Object.assign(mk("span", "rtitle"), { textContent: p.title }));   // the answer's own title (the column already says "disposable")
      if (p.cap) h.appendChild(Object.assign(mk("span", "rtcap"), { textContent: "· " + p.cap }));
      const sp = mk("div", "sp");
      const valid = this.agent.validate(p).ok;
      if (p.type !== "Note" && valid) { const pin = mk("button", "pin", "⤴ pin"); pin.onclick = () => { this.rail = this.rail.filter((z) => z.id !== p.id); this.canvas.push(this.newPanel(p)); this.fullRender(); if (!this.rail.length) this.setRail(false); this.checkpoint("pin " + p.title, "You promoted a disposable answer into your workbench — generation accretes only by your hand."); }; sp.appendChild(pin); }
      const ds = mk("button", "dismiss", "✕"); ds.onclick = () => { this.rail = this.rail.filter((z) => z.id !== p.id); this.renderRail(); this.repaint(); if (!this.rail.length && !this.proposal) this.setRail(false); };
      sp.appendChild(ds); h.appendChild(sp); d.appendChild(h);
      if (p.q) d.appendChild(Object.assign(mk("div", "rq"), { textContent: "“" + p.q + "”" }));
      const H = this.ctx.handleOf(p.bind);
      if (H?.caveat) d.appendChild(this.caveatEl(p.bind, H.caveat));
      const b = mk("div", "pbody"); const built = await bodyFor(p, this.ctx, this.hooks()); b.appendChild(built.el); d.appendChild(b);   // rail header stays uncluttered (no filter box); it appears when pinned to the canvas
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
    if (name === this.currentWS) return;   // already active — don't rebuild (would discard live edits)
    // Auto-save the OUTGOING workspace's live layout (full state — panels, per-panel view, pinned genes, …) so
    // switching away and back restores it exactly, not the original template.
    if (this.currentWS && this.WS[this.currentWS]) this.WS[this.currentWS] = { colorBy: this.coord.state.colorBy, panels: JSON.parse(JSON.stringify(this.canvas)) };
    this.currentWS = name; this.coord.set({ colorBy: ws.colorBy, selection: null });
    this.canvas = ws.panels.map((p) => this.newPanel(p));
    this.fullRender();
    if (name === "Annotate") this.ensureAnnotation();   // async: seed the working draft + an scType source, then re-render
    if (user) { this.toast("Switched to " + name, "A workspace is a named, reversible layout — your previous one is a step back in History."); this.checkpoint("workspace → " + name, "Deliberate workspace switch."); }
  }

  captureLayout(): Partial<Panel>[] { return this.canvas.map((p) => ({ type: p.type, title: p.title, cap: p.cap, full: p.full, col: p.col, bind: p.bind, group: p.group, gene: p.gene, heatMode: p.heatMode, genes: p.genes, view: p.view ? JSON.parse(JSON.stringify(p.view)) : undefined, rows: this.capRows(p), source: p.source, controls: p.controls ? JSON.parse(JSON.stringify(p.controls)) : undefined })); }
  // Result tables now hold the FULL ranked gene list (all tested genes) for live search; cap what we PERSIST so a
  // big-gene-set DE/overdispersion panel doesn't bloat the session doc (the tail is recomputable; live search keeps all).
  private capRows(p: Panel): any[] | undefined { const r = p.rows; if (!r) return undefined; return (p.type === "DeTable" || p.type === "GeneList") && r.length > 500 ? r.slice(0, 500) : r; }

  // Add an author-written widget as a Widget panel on the workbench. Used by the agent's save_widget tool and the
  // custom-widget library menu. The iframe mounts via widgetBody; controls (if known) render in the header.
  // If a Widget panel with the SAME title is already on the canvas, UPDATE it in place (the re-author / "clean it up"
  // flow) instead of mounting a duplicate — mirrors the library's by-name upsert. fullRender re-mounts the iframe
  // from the new .source, so the running widget picks up the new code. Returns {id, updated}.
  addWidgetPanel(source: string, title?: string, controls?: { id: string; label: string }[]): { id: number; updated: boolean } {
    const name = title || "Widget";
    this.saveWidgetToLibrary(name, source, controls);   // also keep it in the re-addable library
    const existing = this.canvas.find((p) => p.type === "Widget" && p.title === name);
    if (existing) {
      existing.source = source; existing.controls = controls;
      this.fullRender(); this.checkpoint("update widget · " + name, "The agent revised an existing widget in place — same panel, new code; a reversible checkpoint.");
      return { id: existing.id, updated: true };
    }
    return { id: this.addPanel({ type: "Widget", title: name, source, controls, bind: "widget:custom" }), updated: false };
  }

  // CHECK A WIDGET'S LIVE USAGE after it's created: snapshot its current rendered text + recent logs + any error, so
  // the agent can verify it actually works in the running app (with real data + the user's current selection) and fix it.
  async inspectWidget(panelId?: number): Promise<string> {
    const widgets = this.canvas.filter((p) => p.type === "Widget");
    if (!widgets.length) return "no widget panels on the workbench to inspect";
    const target = panelId != null ? widgets.find((p) => p.id === panelId) : (widgets.length === 1 ? widgets[0] : null);
    if (!target) return "several widgets — pass panelId. Available: " + widgets.map((p) => `#${p.id} "${p.title}"`).join(", ");
    const h = this.widgetHandles.get(target.id);
    if (!h) return `widget #${target.id} "${target.title}" is not mounted yet — try again`;
    const text = await h.snapshot(1500); const err = h.lastError();
    return JSON.stringify({ panelId: target.id, title: target.title, manifest: h.manifest(), error: err ? err.message : null, logs: h.logs().slice(-8), renderedText: (text || "").slice(0, 600) });
  }
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

  // The right-side ACCOUNT menu: sign-in (placeholder), the light/dark theme selector, the custom-widget library
  // (re-add / delete authored widgets), and session management. Anchored under the avatar button.
  openAccountMenu() {
    const c = this.$("acct"); const light = document.documentElement.classList.contains("light");
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
    // ADD TO WORKBENCH = standard built-in panels + the custom-widget library, one searchable list.
    const defGrp = (() => { try { return this.ctx.defaultGrouping(); } catch { return "leiden"; } })();
    const standard: { name: string; about: string; spec: Partial<Panel> }[] = [
      { name: "Embedding", about: "UMAP scatter of all cells", spec: { type: "Embedding", title: "Embedding", bind: "embedding:main" } },
      { name: "Marker dot-plot", about: "top marker genes per group", spec: { type: "Heatmap", title: "Marker genes", cap: "top genes per group", group: defGrp } },
      { name: "Composition", about: "stacked cluster proportions per sample", spec: { type: "CompositionBars", title: "Composition", cap: "by sample", bind: "composition:bySample" } },
      { name: "Variable genes", about: "top overdispersed genes for the current selection (live)", spec: { type: "VariableGenes", title: "Variable genes", cap: "overdispersion" } },
      { name: "Metadata facets", about: "browse / filter / cross-filter metadata", spec: { type: "MetadataFacets", title: "Metadata", cap: "browse facets", bind: "facets:all" } },
    ];
    const row = (key: string, name: string, kind: string, add: string, del?: string) =>
      `<div class="acwrow" data-search="${esc(key.toLowerCase())}"><span class="acwname" title="${esc(name)}">${esc(name)}</span><span class="acwkind">${kind}</span><span class="acwadd" ${add} title="add to workbench">add</span>${del ? `<span class="acwdel" ${del} title="delete from library">✕</span>` : ""}</div>`;
    const stdRows = standard.map((s, i) => row(`${s.name} ${s.about}`, s.name, "panel", `data-std="${i}"`)).join("");
    const widgets = stdRows + this.widgetLib.map((w) => row(w.name, w.name, "widget", `data-add="${w.id}"`, `data-del="${w.id}"`)).join("");
    c.innerHTML = `
      <div class="acsec"><div class="aclabel">ACCOUNT</div>
        <div class="acrow"><span class="acava">G</span><div><div class="acname">Guest</div><div class="acsub">Local session · not signed in</div></div></div>
        <button class="acbtn" data-a="signin">Sign in</button>
        <div class="acicons">
          <button data-a="theme" title="${light ? "Light theme · switch to dark" : "Dark theme · switch to light"}">${light ? "☀" : "☾"}</button>
          <button data-a="export" title="Save session to a file (.json)">⤓</button>
          <button data-a="import" title="Open a session file">⤒</button>
          <button data-a="reset" title="Reset layout &amp; reload">↺</button>
        </div></div>
      <div class="acsec"><div class="aclabel">ADD TO WORKBENCH</div>
        <input class="acwsearch" id="acwsearch" placeholder="search panels & widgets…">
        <div class="acwidgets" id="acwlist">${widgets}</div></div>`;
    const b = this.$("acctBtn").getBoundingClientRect();
    c.style.left = Math.max(8, Math.min(b.right - 280, innerWidth - 288)) + "px"; c.style.top = (b.bottom + 6) + "px"; c.classList.add("show");
    c.querySelectorAll<HTMLElement>("[data-a]").forEach((el) => el.onclick = () => { const a = el.dataset.a!;
      if (a === "signin") { this.toast("Sign-in is coming soon — your session + widgets are saved locally for now.", null); c.classList.remove("show"); }
      else if (a === "theme") { this.applyTheme(document.documentElement.classList.contains("light") ? "dark" : "light"); this.openAccountMenu(); }   // toggle + re-render the icon
      else if (a === "export") { c.classList.remove("show"); void this.exportSessionToFile(); }
      else if (a === "import") { c.classList.remove("show"); void this.importSessionFromFile(); }
      else if (a === "reset") { try { localStorage.removeItem(SESSION_KEY); } catch { /* */ } location.reload(); } });   // clear the saved layout AND reboot to the dataset's default (recovers a stuck view; keeps the widget library + theme)
    c.querySelectorAll<HTMLElement>("[data-std]").forEach((el) => el.onclick = () => { const s = standard[Number(el.dataset.std)]; if (s) { this.addPanel({ ...s.spec }); this.toast(`Added ${s.name}`, null); } c.classList.remove("show"); });
    c.querySelectorAll<HTMLElement>("[data-add]").forEach((el) => el.onclick = () => { const w = this.widgetLib.find((x) => x.id === el.dataset.add); if (w) { this.addWidgetPanel(w.source, w.name, w.controls); this.toast(`Added widget “${w.name}”`, null); } c.classList.remove("show"); });
    c.querySelectorAll<HTMLElement>("[data-del]").forEach((el) => el.onclick = (e) => { e.stopPropagation(); this.deleteWidgetFromLibrary(el.dataset.del!); this.openAccountMenu(); });   // re-render the list in place
    const sb = c.querySelector<HTMLInputElement>("#acwsearch");   // filter the combined list in place (no menu re-render → keeps focus)
    if (sb) sb.oninput = () => { const q = sb.value.trim().toLowerCase(); c.querySelectorAll<HTMLElement>(".acwrow").forEach((el) => { el.style.display = !q || (el.dataset.search || "").includes(q) ? "" : "none"; }); };
  }

  // ---------- checkpoints ----------
  snap() { return { colorBy: this.coord.state.colorBy, focus: this.coord.state.focus, ws: this.currentWS, canvas: JSON.parse(JSON.stringify(this.canvas)), rail: JSON.parse(JSON.stringify(this.rail)) }; }
  checkpoint(q: string, why: string, opts?: { kind?: "ask" | "act"; exchange?: any }) { this.history.push({ i: this.history.length, q, why, state: this.snap(), kind: opts?.kind || "act", exchange: opts?.exchange }); this.viewing = -1; this.renderSpine(); if (this.threadDocked) this.renderThread(); this.scheduleSave(); }
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
  pipState = "idle"; pipLabel = "";
  setPip(state: string, label?: string) { this.pipState = state; this.pipLabel = label || ""; this.renderAskBtn(); }
  // While a LIVE turn is in flight the Ask button becomes a STOP button (click to abort) — the main-screen stop. Else
  // it reflects the presence pip (Working/Listening/Ask). refreshAskBtn re-renders it when only `running` changed.
  refreshAskBtn() { this.renderAskBtn(); }
  renderAskBtn() {
    const b = this.$("askBtn");
    if (this.agent?.running) { b.className = "tb pip working stop"; b.title = "stop the agent"; b.innerHTML = `<span class="stopsq"></span>Stop${this.pipLabel ? ` · ${this.pipLabel}` : ""}`; return; }
    b.title = ""; b.className = "tb pip" + (this.pipState && this.pipState !== "idle" ? " " + this.pipState : "");
    const main = this.pipState === "working" ? "Working" + (this.pipLabel ? " · " + this.pipLabel : "") : this.pipState === "listening" ? "Listening…" : "Ask";
    const right = this.pipState === "nudge" ? `<span class="nbadge">${this.pipLabel || "!"}</span>` : (!this.pipState || this.pipState === "idle" || this.pipState === "listening") ? `<span class="kbd">⌘K</span>` : "";
    b.innerHTML = `<span class="dot"></span>${main}${right}`;
  }

  // ---------- selection popover ----------
  openSelpop() {
    const ids = this.ctx.selectedCells(); if (!ids.length) return;
    this.ctx.metaOf("cell_type").then((m: any) => {
      const cts: Record<string, number> = {}; for (const i of ids) cts[m.categories[m.codes[i]]] = (cts[m.categories[m.codes[i]]] || 0) + 1;
      const top = Object.entries(cts).sort((a, b) => b[1] - a[1])[0];
      this.scope = { type: "selection", ids: Array.from(ids), summary: `${ids.length} cells (mostly ${top?.[0] || "?"})` };
      const sp = this.$("selpop");
      sp.innerHTML = `<div class="head">${ids.length} cells · mostly ${top?.[0] || "?"}</div>` +
        `<div class="it" data-a="ask"><span class="ic">⌘K</span>Ask about these…</div>` +
        `<div class="it" data-a="de"><span class="ic">≢</span>Run DE on selection</div>` +
        `<div class="it" data-a="label"><span class="ic">✎</span>Label as…</div>` +
        `<div class="it" data-a="clear"><span class="ic">✕</span>Clear selection</div>`;
      sp.classList.add("show");
      // position with the menu's REAL width: if the anchor carries a `right` (a right-aligned trigger like the facet
      // "actions" button), align the menu's right edge to it so it stays inside the panel; else open to the right of
      // the anchor. Clamp within the window with an 8px margin either way (never bleed to the very edge).
      const a = this.lastSelAnchor; const wpx = sp.offsetWidth || 210;
      const left = a.right != null ? a.right - wpx : a.left + 8;
      sp.style.left = Math.max(8, Math.min(left, innerWidth - wpx - 8)) + "px"; sp.style.top = a.top + "px";
      sp.querySelectorAll<HTMLElement>(".it").forEach((it) => it.onclick = () => { const a = it.dataset.a;
        if (a === "label") { this.selpopLabelInput(Array.from(ids)); return; }   // sub-state — keep the popover open
        this.hideSelpop();
        if (a === "ask") this.openPalette(this.scope!); else if (a === "de") this.agent.ask("run de", this.scope); else { this.coord.setSelection(null); this.scope = null; } });
    });
  }
  // brush → "Label as…": type a label, applied to the selected cells in the working annotation draft
  // (auto-creates it, non-destructive). The free-form manual entry point that complements the agent + reconcile.
  selpopLabelInput(ids: number[]) {
    const sp = this.$("selpop");
    sp.innerHTML = `<div class="head">label ${ids.length} cells</div><input id="splabel" placeholder="cell-type label…" style="width:90%;margin:5px 6px;font-size:12px"><div class="it" data-a="apply"><span class="ic">✓</span>add to working annotation</div>`;
    const inp = sp.querySelector<HTMLInputElement>("#splabel")!; inp.focus();
    const apply = () => { const v = inp.value.trim(); this.hideSelpop(); if (v) { this.labelCells(Int32Array.from(ids), v); this.coord.setSelection(null); this.scope = null; this.toast(`labeled ${ids.length} cells “${v}”`, "Added to the working annotation draft — see the Annotate workspace."); } };
    inp.onkeydown = (e) => { if (e.key === "Enter") apply(); else if (e.key === "Escape") this.hideSelpop(); };
    sp.querySelector<HTMLElement>('[data-a="apply"]')!.onclick = apply;
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
    { t: "Most variable genes (per-gene HVG)", q: "show most variable genes", ic: "≢" },
    { t: "Show overdispersed gene programs", q: "show overdispersed gene programs", ic: "▤" },
    { t: "Show composition across samples", q: "show composition", ic: "▥" },
    { t: "Help me interpret a finding", q: "help me interpret this", ic: "✦" },
    { t: "Set everything up to compare conditions", q: "set everything up to compare conditions", ic: "⚙" },
  ];
  openPalette(scope?: Scope) {
    this.scope = scope || this.scope; this.$("scrim").classList.add("show"); this.$("palette").classList.add("show");
    if (!this.thread) this.setPip("listening"); this.renderScope(); (this.$("pin") as HTMLInputElement).value = ""; this.filter(""); (this.$("pin") as HTMLInputElement).focus();
  }
  closePalette() { this.$("scrim").classList.remove("show"); this.$("palette").classList.remove("show"); if (!this.thread) this.setPip(this.nudgePending ? "nudge" : "idle", this.nudgePending ? "1" : undefined); }
  // Light / dark theme. The DOM re-themes via CSS variables (html.light overrides :root); the embedding's
  // non-focus dot colour is JS-set (theme.ts), so update it + repaint. Persisted as a preference.
  applyTheme(theme: "light" | "dark"): void {
    const light = theme === "light";
    document.documentElement.classList.toggle("light", light);
    setThemeColors(!light);
    try { localStorage.setItem("p2-theme", theme); } catch {}
    const b = this.$("themeBtn"); if (b) { b.textContent = light ? "☀" : "☾"; b.title = light ? "switch to dark theme" : "switch to light theme"; }
    if (this.embeddings.length) this.repaint();   // recolour the embeddings with the theme's dim colour
    this.themeSubs.forEach((f) => { try { f(); } catch { /* a widget host re-push must not break the toggle */ } });   // re-theme widget iframes
  }
  // The global FOCUS chip in the top bar — the inter-panel "restricted to this subpopulation" indicator AND
  // its release control (clicking "show all" clears focus everywhere). Visible whenever a focus is set.
  renderFocus() {
    const el = this.$("focuschip"); const f = this.coord.state.focus;
    if (!f) { el.style.display = "none"; return; }
    const lbl = String(f.label).replace(/[<&]/g, (c) => c === "<" ? "&lt;" : "&amp;");
    el.style.display = ""; el.innerHTML = `<span class="fdot"></span>focused: <b>${lbl}</b> <span class="fn">${f.ids.length.toLocaleString()} cells</span> <span class="x" id="focusX" title="release the focus — show all cells">show all ✕</span>`;
    (this.$("focusX")).onclick = () => this.releaseFocus();
  }
  renderScope() { const s = this.$("scope"); if (this.scope) { s.style.display = ""; s.innerHTML = `<span>↳ about ${this.scope.summary}</span><span class="x" id="scx">clear</span>`; this.$("scx").onclick = () => { this.scope = null; this.renderScope(); this.filter((this.$("pin") as HTMLInputElement).value); }; } else s.style.display = "none"; }
  scopedSugs() { return this.scope ? [{ t: "Run differential expression on this selection", q: "run de", ic: "≢" }, { t: "What cell types are these?", q: "what are these", ic: "?" }, { t: "Colour by condition", q: "colour by condition", ic: "◐" }] : this.SUGS; }
  filter(v: string) { const base = this.scopedSugs(); this.filtered = base.filter((s) => s.t.toLowerCase().includes(v.toLowerCase())); if (v && !this.filtered.length) this.filtered = [{ t: `Ask: “${v}”`, q: v, ic: "➤", free: true }]; this.hot = 0; this.renderSugs(); }
  renderSugs() { const c = this.$("sugs"); c.innerHTML = ""; this.filtered.forEach((s, i) => { const d = mk("div", "sug" + (i === this.hot ? " hot" : "")); d.innerHTML = `<span class="ic">${s.ic || "➤"}</span><span class="lab">${s.t}</span>` + (s.free ? "" : `<span class="hint">enter</span>`); d.onclick = () => { this.closePalette(); this.agent.ask(s.q, this.scope); }; c.appendChild(d); }); }

  // ---------- wiring ----------
  wire() {
    this.$("askBtn").onclick = () => { if (this.agent.running) { this.agent.stopLive(); return; } if (this.nudgePending) this.agent.openNudge(); else this.openPalette(); };
    this.$("lockBtn").onclick = () => { this.locked = !this.locked; this.$("lockBtn").classList.toggle("on", this.locked); this.$("lockBtn").textContent = this.locked ? "🔒 Layout" : "🔓 Layout"; this.toast(this.locked ? "Layout locked" : "Layout unlocked", this.locked ? "The agent will route bigger changes to the rail instead of touching your workbench." : null); };
    this.$("acctBtn").onclick = (e) => { e.stopPropagation(); const c = this.$("acct"); if (c.classList.contains("show")) c.classList.remove("show"); else this.openAccountMenu(); };
    this.applyTheme((localStorage.getItem("p2-theme") as "light" | "dark") || "dark");   // restore the saved preference
    this.$("railBtn").onclick = () => this.setRail(!this.$("rail").classList.contains("open"));
    this.$("railX").onclick = () => this.setRail(false);
    this.$("convoBtn").onclick = () => this.agent.setThreadDock(!this.threadDocked);   // mirror of railBtn: top-bar toggle for the Chat column
    // drag the Answers column's left edge to resize it (width persists for the session)
    { const grip = this.$("railgrip"), rail = this.$("rail"); let gx = 0, gw = 0, drag = false;
      grip.addEventListener("pointerdown", (e) => { const pe = e as PointerEvent; drag = true; gx = pe.clientX; gw = rail.offsetWidth; rail.style.transition = "none"; try { grip.setPointerCapture(pe.pointerId); } catch {} e.preventDefault(); });
      grip.addEventListener("pointermove", (e) => { if (!drag) return; const w = Math.max(240, Math.min(760, gw + (gx - (e as PointerEvent).clientX))); rail.style.flexBasis = w + "px"; rail.style.width = w + "px"; });
      grip.addEventListener("pointerup", () => { drag = false; rail.style.transition = ""; }); }
    this.$("tlhd").onclick = () => this.$("timeline").classList.toggle("collapsed");
    this.$("dockBtn").onclick = (e) => { e.stopPropagation(); this.agent.setThreadDock(!this.threadDocked); };
    this.$("scrim").onclick = () => this.closePalette();
    (this.$("pin") as HTMLInputElement).addEventListener("input", (e) => this.filter((e.target as HTMLInputElement).value));
    (this.$("pin") as HTMLInputElement).addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { this.hot = Math.min(this.hot + 1, this.filtered.length - 1); this.renderSugs(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { this.hot = Math.max(this.hot - 1, 0); this.renderSugs(); e.preventDefault(); }
      else if (e.key === "Enter") { const s = this.filtered[this.hot]; if (s) { this.closePalette(); this.agent.ask(s.q, this.scope); } }
    });
    document.addEventListener("click", (e) => { if (!this.$("selpop").contains(e.target as Node)) this.hideSelpop(); if (!this.$("ctx").contains(e.target as Node)) this.$("ctx").classList.remove("show"); const ac = this.$("acct"); if (!ac.contains(e.target as Node) && (e.target as HTMLElement).id !== "acctBtn" && !this.$("acctBtn").contains(e.target as Node)) ac.classList.remove("show"); });
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); this.openPalette(); }
      else if (e.key === "Escape") { this.closePalette(); this.hideSelpop(); this.$("ctx").classList.remove("show"); }
    });
    this.coord.subscribe((_s, changed) => {
      if (this.suspendRender) return;   // applyViewPatch is batching; it will render once at the end
      if (changed.length === 1 && changed[0] === "hint") { this.repaintHint(); return; }  // light hover path
      if (changed.length === 1 && changed[0] === "geneHint") { const g = this.coord.state.geneHint; this.geneHoverSinks.forEach((fn) => fn(g)); return; }  // gene-row hover, cross-panel
      this.repaint(); this.syncColorSelects(); this.syncToggles();
    });
  }
  // keep each panel's dropdown showing ITS effective handle (per-panel override, else the global default).
  // keep each panel's dropdown showing ITS effective handle (per-panel override, else the global default).
  // Embedding dropdowns accept any handle (add the option if it's a gene not in the standard list); a
  // composition dropdown only ever shows a grouping (it ignores a global gene colouring, falling back to its grouping).
  // Is a colour handle a NUMERIC colouring (so a colormap applies)? gene/qc/code/geneset are; meta: only when the field isn't categorical.
  isNumericColoring(handle: string): boolean { return !handle.startsWith("meta:") || this.ctx.categoricalValues(handle.slice(5)).length === 0; }

  syncColorSelects() {
    document.querySelectorAll<HTMLSelectElement>("select.inline:not(.cm):not(.wins)").forEach((s) => {
      const p = this.canvas.find((z) => z.id === Number(s.dataset.pid)); if (!p) return;
      if (p.type === "Embedding") {
        const eff = p.view?.colorBy ?? this.coord.state.colorBy;
        s.innerHTML = this.colorOptionsHtml(eff);   // rebuilt from the capped list — no unbounded accumulation
      } else { const eff = p.view?.colorBy ?? ("meta:" + this.ctx.defaultGrouping()); if ([...s.options].some((o) => o.value === eff)) s.value = eff; }
    });
    // colour-map pickers: show only for numeric colourings; keep the value in step with the panel's colormap
    document.querySelectorAll<HTMLSelectElement>("select.cm").forEach((s) => {
      const p = this.canvas.find((z) => z.id === Number(s.dataset.pid)); if (!p) return;
      const eff = p.view?.colorBy ?? this.coord.state.colorBy;
      s.style.display = this.isNumericColoring(eff) ? "" : "none";
      const cmv = p.view?.colormap || "amber"; if ([...s.options].some((o) => o.value === cmv)) s.value = cmv;
    });
    // winsorization pickers: same show-only-for-numeric rule; keep the value in step with the panel's display.winsor
    document.querySelectorAll<HTMLSelectElement>("select.wins").forEach((s) => {
      const p = this.canvas.find((z) => z.id === Number(s.dataset.pid)); if (!p) return;
      const eff = p.view?.colorBy ?? this.coord.state.colorBy;
      s.style.display = this.isNumericColoring(eff) ? "" : "none";
      const wv = String((p.view?.display?.winsor) ?? this.coord.state.display.winsor ?? 0);
      if ([...s.options].some((o) => o.value === wv)) s.value = wv;
    });
    // toggling a picker's visibility (above) changes header content without resizing it — re-run overflow folding
    // so a freshly-shown control lands in the ⋯ menu instead of clipping past the header edge.
    document.querySelectorAll<HTMLElement>(".ph").forEach((ph) => (ph as any)._ovfSchedule?.());
  }

  // Remember a colouring handle for the embedding dropdown, capped at 5 per class (gene/meta/qc/geneset) so
  // clicking through many genes doesn't flood the menu — the oldest of that class drops off (current is kept).
  noteColor(handle: string) {
    if (!handle || !handle.includes(":") || this.colorChoices.some(([h]) => h === handle)) return;
    const cls = handle.split(":")[0] + ":";
    this.colorChoices.push([handle, handleLabel(handle)]);
    const ofClass = this.colorChoices.filter(([h]) => h.startsWith(cls));
    if (ofClass.length > 5) { const drop = ofClass[0][0]; this.colorChoices = this.colorChoices.filter(([h]) => h !== drop); }
  }
  // <option> list for an embedding colour dropdown from the capped choices (always including the current handle).
  colorOptionsHtml(cur: string): string {
    // annotation sources with per-cell confidence add a "<src> confidence" option — colour by it to see the
    // uncertain (ambiguous) cells, i.e. where reconciliation is hard.
    const confOpts = [...this.annoLayers.values()].filter((l) => l.confidence).map((l) => [`conf:${l.name}`, `${l.name} confidence`] as [string, string]);
    // the working draft + its derived hierarchy levels (annotation: L1 …) — so you can colour by a coarser level
    const levelOpts = ["annotation", ...this.ctx.derivedGroupings()].filter((g) => this.ctx.groupings().includes(g)).map((g) => [`meta:${g}`, g] as [string, string]);
    const seen = new Set<string>();
    const all = [...this.colorChoices, ...confOpts, ...levelOpts].filter(([h]) => !seen.has(h) && !!seen.add(h));
    const opts = cur && !all.some(([h]) => h === cur) ? [[cur, handleLabel(cur)] as [string, string], ...all] : all;
    return opts.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`).join("");
  }
  // reflect display state onto the header toggle buttons — PER PANEL (each button reads its own panel's
  // effective display = the coord default merged with the panel's override), so both tiers stay in step.
  syncToggles() {
    document.querySelectorAll<HTMLButtonElement>("button.mini[data-tg]").forEach((b) => {
      const p = this.canvas.find((z) => z.id === +(b.dataset.pid || -1));
      const d = { ...this.coord.state.display, ...(p?.view?.display || {}) };
      const cat = !this.isNumericColoring(p?.view?.colorBy ?? this.coord.state.colorBy);
      const on = b.dataset.tg === "labels" ? (d.labels && cat) : (d.legend ?? !cat);
      b.classList.toggle("on", on);
    });
  }

  // expose thread rendering for the agent
  renderThread() { this.agent.renderThread(); }
}
