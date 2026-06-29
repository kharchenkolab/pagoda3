import { mk } from "./dom.ts";
import { Ctx } from "../data/ctx.ts";
import { Coord, handleLabel, EntityRef } from "../data/coord.ts";
import { Panel, PanelView, PanelHooks, CompReactor, BuiltBody, bodyFor, paintEmbedding, resolvePanelStyleFor } from "./panels.ts";
import { EmbeddingView } from "../render/embedding.ts";
import { Agent, Scope } from "../agent/agent.ts";
import { agentPanelTypes } from "./panel-registry.ts";
import { checkLive } from "../agent/live.ts";
import { saveCred, clearCred, loadCred, credStatus, detectCred, resolveMode, localCfg, setLocalCfg, setAgentOff, proxyCfg, setProxyCfg, proxyBase } from "../agent/credentials.ts";
import { getProvider, providerModel, PROVIDER_KEY } from "../agent/providers.ts";
import { normalizeViewPatch, RawViewPatch, World, PanelSpec, PanelPatch, MAX_COLS } from "../agent/viewpatch.ts";
import { validateCellSet, resolveCellSet, describeCellSet, CellSet, CellWorld, CellEnv } from "../agent/cellset.ts";
import { validateComputeResult, runInWorker, buildComputeSnapshot } from "../agent/codeapi.ts";
import { setCodeValues, setConfValues, invalidateColor, setCategoryColor, clearCategoryColors, serializeCategoryColors, restoreCategoryColors } from "../render/colors.ts";
import { clampStyle, deepMerge, describeStyle, getStyle } from "../render/style.ts";
import { setCustomPalette, serializeCustomPalette, restoreCustomPalette } from "../render/palettes.ts";
import { themeIsDark } from "../render/theme.ts";
import { setThemeColors } from "../render/theme.ts";
import { installOverflow } from "./overflow.ts";
import { makeWidgetHost } from "../widget/apphost.ts";
import type { WidgetHost, WidgetHandle } from "../widget/runtime.ts";
import { widgetLint } from "../widget/contract.ts";
import { pseudobulkDECore, pseudobulkPairedDECore } from "../compute/odcore.ts";
import { ResultRegistry, buildSessionEntities, type SessionEntity } from "./results.ts";
import { fieldBuckets } from "../data/fieldroles.ts";
import { SESSION_KEY, WIDGETS_KEY, SavedWidget, SerAnnoLayer, Fingerprint, serializeSession, parseSession, serializeBundle, parseBundle, fingerprintMismatch, upsertWidget, loadWidgets, widgetHash } from "./persist.ts";

// Item 2/C — the trust registry: source-hashes of widgets the user has authored or explicitly consented to run. Foreign
// widgets that arrive via an imported session file are NOT here, so they're GATED (rendered as a consent placeholder)
// until the user reviews + trusts them — no auto-execution of code from a file. Persisted (the user's standing allow-list).
const TRUST_KEY = "p3-trusted-widgets";
import { paletteNames, normalizePalette } from "../render/palettes.ts";
import { AnnotationLayer, seedLayer, setLabel, reconcile, compact, hierarchyDepth, rollupToLevel } from "../anno/model.ts";
import { PBMC_MARKERS, MarkerDB } from "../anno/markerdb.ts";
import { zscoreByGroup, scoreClusters, assignClusters, MarkerIdx } from "../anno/sctype.ts";
import { LRModel, lrFinalize } from "../anno/celltypist.ts";

interface Checkpoint { i: number; q: string; why: string; state: any; kind?: "ask" | "act"; exchange?: { kind: string; entries?: any[]; turns?: any[] }; }
interface WS { colorBy: string; panels: Partial<Panel>[]; }

// Parse ANY CSS colour string → [r,g,b] via the canvas (so "lightgrey", "#ccc", "rgb(…)", "hsl(…)" all work) — used
// by update_view's `recolor` knob. The two-defaults trick detects an INVALID colour: a valid one normalises the same
// regardless of the prior fillStyle, an invalid one leaves the default unchanged (so the two reads differ).
function parseCssColorToRGB(s: string): [number, number, number] | null {
  try {
    const cx = document.createElement("canvas").getContext("2d"); if (!cx) return null;
    cx.fillStyle = "#000"; cx.fillStyle = s; const a = cx.fillStyle;
    cx.fillStyle = "#fff"; cx.fillStyle = s; const b = cx.fillStyle;
    if (a !== b) return null;
    if (typeof a === "string" && a[0] === "#") return [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
    const m = typeof a === "string" ? a.match(/rgba?\(([^)]+)\)/) : null;
    if (m) { const p = m[1].split(",").map((x) => parseFloat(x)); return [p[0] | 0, p[1] | 0, p[2] | 0]; }
    return null;
  } catch { return null; }
}

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
  results = new ResultRegistry();   // session RESULTS (DE / pseudobulk / markers / HVG) as first-class re-runnable artifacts — the session ledger lists these
  embeddings: EmbeddingView[] = [];
  compReactors: CompReactor[] = [];   // vocabulary-bound panels that highlight a category on a coord hint
  coordSubs: (() => void)[] = [];     // managed coord subscriptions (panels' onCoord) — unsubscribed each fullRender
  teardowns: (() => void)[] = [];     // per-panel cleanup (e.g. a widget iframe + its host subscription) — run each fullRender
  widgetHandles = new Map<number, WidgetHandle>();   // live mounted widget iframes by panel id (for inspect_widget); cleared each fullRender
  themeSubs = new Set<() => void>();  // theme-change listeners (widgets re-theme their iframes); fired in applyTheme
  builtinWS!: Set<string>;            // code-defined workspace names (the rest are user-saved → persisted)
  widgetLib: SavedWidget[] = [];      // the custom-widget LIBRARY (authored widgets, re-addable from the menu); persisted
  trustedWidgets = new Set<string>(); // source-hashes the user authored/consented to run (Item 2/C); foreign imports gate
  widgetPool?: import("../compute/pool.ts").ComputePool;   // S5: off-thread, terminable worker for widget runCompute (kernels over the shared SAB); set by main.ts
  private _saveTimer: any = null;     // debounce for session persistence
  private lastSel: any;               // last selection dispatched to reactors — skip re-dispatch on colour-only repaints
  private reactorsStale = true;       // set when reactors are rebuilt (fullRender) → force one dispatch
  geneHoverSinks: ((sym: string | null) => void)[] = [];   // panels that highlight a gene's row on a coord geneHint
  colorChoices: [string, string][] = [...COLOR_OPTS];   // colour-by dropdown options, capped per class (see noteColor)
  caveatsCollapsed = new Set<string>();   // caveat handles the user clicked to collapse (stay collapsed across renders)
  // presence
  thread: any = null; threadDocked = false; nudgePending: any = null; apTimer: any = null; apIndex = 0;
  scope: Scope | null = null; askScope: Scope | null = null; hot = 0; filtered: any[] = []; lastSelAnchor: { left: number; top: number; right?: number } = { left: 0, top: 0 };
  private selpopOutside?: (e: Event) => void;   // the selection popover's OWN outside-dismiss listener (armed on open, removed on close) — see showSelpop/hideSelpop
  lastSaveCategory?: string;   // remember the Save-selection target so repeated saves default to the same custom category
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

  // Surface the store's viewer-optimization level. The app opens ANY lstar zarr and degrades gracefully (a base store
  // recomputes the cell-major panel from gene-major counts each session; coloring/embedding/metadata need no extension);
  // this banner just makes the level visible + names the one-command fix. Dismissal is remembered per store + level.
  private bannerForStore(): void {
    const el = this.$("optbanner"); if (!el) return;
    const ds: any = this.ctx.view.ds;
    const has = (n: string) => typeof ds?.hasField === "function" && ds.hasField(n);
    const cellmajor = has("counts_cellmajor"), ordered = has("counts_cellmajor_order");
    if (cellmajor && ordered) { el.style.display = "none"; return; }   // fully viewer-optimized → nothing to say
    const level = cellmajor ? "ext" : "base";
    const storeKey = new URLSearchParams(location.search).get("store") || "default";
    try { if (localStorage.getItem("p2-optdismiss::" + storeKey) === level) { el.style.display = "none"; return; } } catch { /* */ }
    const fix = "lstar convert IN.h5ad OUT.lstar.zarr --viewer";
    const msg = cellmajor
      ? `<b>Extended, but not locality-ordered.</b> Compute is fast, but on a high-latency host the per-selection reads aren't coalesced into one. Add the order — re-run <code>${fix}</code>.`
      : `<b>Not viewer-optimized.</b> Differential expression & variable genes recompute from the whole matrix each session (slow on large or remote data). Optimize once — <code>${fix}</code>.`;
    el.innerHTML = `<span class="ob-i">◆</span><span class="ob-t">${msg}</span><span class="ob-x" id="optX" title="dismiss">✕</span>`;
    el.style.display = "flex";
    const x = el.querySelector("#optX") as HTMLElement | null;
    if (x) x.onclick = () => { el.style.display = "none"; try { localStorage.setItem("p2-optdismiss::" + storeKey, level); } catch { /* */ } };
  }

  async mount(parent: HTMLElement) {
    this.agent = new Agent(this);
    this.root.innerHTML = `
      <div class="top">
        <div class="logo">pagoda<span>3</span></div>
        <div class="wstabs" id="wstabs"></div>
        <div class="selchip" id="selchip" style="display:none"></div>
        <div class="focuschip" id="focuschip" style="display:none"></div>
        <div class="fetchpill" id="fetchpill" style="display:none"></div>
        <div class="spacer"></div>
        <div class="tb pip" id="askBtn"><span class="dot"></span>Ask<span class="kbd">⌘K</span></div>
        <div class="tb" id="lockBtn">🔓 Layout</div>
        <div class="tb" id="convoBtn" title="show / hide the Chat column">Chat</div>
        <div class="tb" id="railBtn" title="show / hide the Answers column">Answers</div>
        <div class="tb acct" id="acctBtn" title="account, theme & custom widgets"><span class="acdot">G</span></div>
      </div>
      <div class="optbanner" id="optbanner" style="display:none"></div>
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
    // GLOBAL data-fetch indicator: any csrRows read (agent DE/overdispersion, the live panels) surfaces a top-bar
    // pill so a slow read is never a silent wait. Delay-gated at 250ms (no flash on cache hits / od_score / small reads).
    let fetchTimer: any = null;
    this.ctx.view.onFetchProgress((done, total) => {
      const pill = this.$("fetchpill"); if (!pill) return;
      if (done >= total) { if (fetchTimer) { clearTimeout(fetchTimer); fetchTimer = null; } pill.style.display = "none"; return; }
      pill.textContent = `⟳ fetching ${total ? Math.round(done / total * 100) : 0}%`;
      if (pill.style.display === "none" && !fetchTimer) fetchTimer = setTimeout(() => { pill.style.display = "inline-flex"; fetchTimer = null; }, 250);
    });
    this.wire();
    this.setPip("idle");
    this.bannerForStore();   // surface the store's viewer-optimization level (extended? locality-ordered?)
    this.switchWS("Metadata", false);
    this.checkpoint("session start", "Baseline Metadata workspace.");
    this.restoreSession();   // restore the last session (layout incl. widget panels) + load the custom-widget library
    setTimeout(() => this.toast("Drag with Shift to select cells · ⌘K to ask · right-click a panel", null), 500);
    // connect the live planner if its backend is reachable — checks the ACTIVE provider (Anthropic OAuth, or the
    // local vLLM model) and labels with the real model so "live on …" never lies about which model is driving.
    const prov = getProvider();
    checkLive(prov).then((ok) => { this.agent.live = ok; if (ok) {
      const model = prov === "openai" ? providerModel(prov) : "Opus";
      this.toast("Live agent connected · " + model, prov === "openai"
        ? "A LOCAL OpenAI-compatible model (vLLM) is driving the agent — switch back with p2.setProvider('anthropic')."
        : "The agent is the real Anthropic planner now — it drives the coordination space through tools, at the lowest sufficient rung.");
    } });
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
  // The fingerprint identifies the IMMUTABLE BASE dataset (so a session only reapplies where the data aligns). It must
  // therefore exclude SESSION-CREATED categoricals — the annotation draft + agent/UI-derived categories — which live in
  // ctx.meta as categoricals too. Including them was self-defeating: a session carrying a derived category recorded that
  // field in its own fingerprint, so on RELOAD (before restore, the field absent) the fingerprint mismatched and the
  // whole annotation block — the category AND the working draft — was refused restoration.
  datasetFingerprint(): Fingerprint {
    try {
      const overlay = new Set<string>([...this.ctx.annotationLayers(), ...this.ctx.derivedGroupings()]);
      return { n: this.ctx.n, fields: this.ctx.categoricalFields().filter((f) => !overlay.has(f)).sort() };
    } catch { return { n: 0, fields: [] }; }
  }
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
    const base = { store: this.currentStore(), fingerprint: this.datasetFingerprint(), currentWS: this.currentWS, colorBy: this.coord.state.colorBy, canvas: this.captureLayout(), userWS, annotation: this.serializeAnnotation(), catColors: serializeCategoryColors(), style: (this.coord.state as any).style, customPalette: serializeCustomPalette(), results: this.results.serialize() };
    // Try the full doc (incl. the chat log); if it busts the ~5MB quota, retry WITHOUT the conversation so views +
    // annotation still persist (the chat is the biggest + most droppable part — it's also in the exportable file).
    try { localStorage.setItem(SESSION_KEY, serializeSession({ ...base, conversation: this.serializeConversation() })); }
    catch { try { localStorage.setItem(SESSION_KEY, serializeSession(base)); } catch { /* private mode / still over — non-fatal */ } }
  }
  restoreSession() {
    this.widgetLib = loadWidgets(localStorage.getItem(WIDGETS_KEY));   // the widget LIBRARY is dataset-agnostic — always load it
    this.loadTrust();   // the user's standing trust allow-list + their own library is trusted (Item 2/C)
    const doc = parseSession(localStorage.getItem(SESSION_KEY));
    if (!doc || doc.store !== this.currentStore()) return;   // no session, or one from a DIFFERENT dataset → keep this store's default layout (no redundant re-render)
    this.applySessionViews(doc);
    restoreCategoryColors((doc as any).catColors);   // per-value colour overrides (keyed by field+value, not cell-indexed → no fingerprint gate; a missing field just won't apply)
    (this.coord.state as any).style = (doc as any).style;   // global style overrides (view layer, not cell-indexed)
    restoreCustomPalette((doc as any).customPalette);   // a user-defined numeric gradient (view layer)
    if (doc.annotation && !fingerprintMismatch(doc.fingerprint, this.datasetFingerprint())) this.restoreAnnotation(doc.annotation);   // cell-indexed → only when the dataset still aligns
    this.results.restore((doc as any).results);   // gene-indexed rows + a re-runnable spec — safe to restore for the same store (re-run is guarded if a referenced set no longer resolves)
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
    const session = parseSession(serializeSession({ store: this.currentStore(), fingerprint: this.datasetFingerprint(), currentWS: this.currentWS, colorBy: this.coord.state.colorBy, canvas: this.captureLayout(), userWS, annotation: this.serializeAnnotation(), conversation: this.serializeConversation(), catColors: serializeCategoryColors(), style: (this.coord.state as any).style, customPalette: serializeCustomPalette(), results: this.results.serialize() }))!;
    return serializeBundle({ session, widgets: this.widgetLib, savedAt: Date.now() });
  }
  applyBundle(raw: string): { ok: boolean; msg: string } {
    const b = parseBundle(raw);
    if (!b) return { ok: false, msg: "Not a pagoda session file." };
    const mism = fingerprintMismatch(b.session.fingerprint, this.datasetFingerprint());
    let added = 0;   // widgets are dataset-agnostic → always merge into the library (upsert by name)
    // Imported widgets are tagged origin:"imported" and are NOT auto-trusted — their panels render a consent gate
    // (Item 2/C) until the user reviews + runs them. (A re-import of source the user already trusts stays trusted: the
    // trust list is content-addressed.)
    for (const w of b.widgets) { const before = this.widgetLib.length; this.widgetLib = upsertWidget(this.widgetLib, { name: w.name, source: w.source, controls: w.controls, origin: "imported" }, w.createdAt || Date.now(), w.id || "w" + Date.now().toString(36) + added); if (this.widgetLib.length > before) added++; }
    if (b.widgets.length) try { localStorage.setItem(WIDGETS_KEY, JSON.stringify({ widgets: this.widgetLib })); } catch { /* */ }
    this.applySessionViews(b.session);
    restoreCategoryColors((b.session as any).catColors);   // per-value colour overrides travel with the file
    (this.coord.state as any).style = (b.session as any).style;   // style overrides travel with the file
    restoreCustomPalette((b.session as any).customPalette);   // the custom palette travels with the file
    if (b.session.annotation && !mism) this.restoreAnnotation(b.session.annotation);
    this.results.restore((b.session as any).results);
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
  saveWidgetToLibrary(name: string, source: string, controls?: { id: string; label: string }[], origin: "authored" | "imported" = "authored") {
    this.widgetLib = upsertWidget(this.widgetLib, { name: name || "Widget", source, controls, origin }, Date.now(), "w" + Date.now().toString(36));
    try { localStorage.setItem(WIDGETS_KEY, JSON.stringify({ widgets: this.widgetLib })); } catch { /* */ }
    if (origin === "authored") this.trustWidget(source);   // a widget authored THIS session is trusted (the user watched it being built); a re-added IMPORTED one stays gated
  }
  deleteWidgetFromLibrary(id: string) {
    this.widgetLib = this.widgetLib.filter((w) => w.id !== id);
    try { localStorage.setItem(WIDGETS_KEY, JSON.stringify({ widgets: this.widgetLib })); } catch { /* */ }
  }

  // ---- Item 2/C: widget trust (provenance + consent) ----
  // Load the persisted allow-list, and migrate: every widget already in the USER'S OWN library is trusted (they
  // authored it in a prior session). Only FOREIGN source — arriving via an imported session file — stays ungated-list.
  loadTrust() {
    try { const arr = JSON.parse(localStorage.getItem(TRUST_KEY) || "[]"); if (Array.isArray(arr)) for (const h of arr) this.trustedWidgets.add(String(h)); } catch { /* */ }
    // Migrate the user's OWN widgets (authored, or legacy with no origin) to trusted — but NOT ones tagged "imported",
    // which must keep gating across restarts unless the user explicitly consented (that lands on the TRUST_KEY list above).
    for (const w of this.widgetLib) if (w.source && w.origin !== "imported") this.trustedWidgets.add(widgetHash(w.source));
    this.persistTrust();
  }
  private persistTrust() { try { localStorage.setItem(TRUST_KEY, JSON.stringify([...this.trustedWidgets])); } catch { /* */ } }
  trustWidget(source: string) { if (source) { this.trustedWidgets.add(widgetHash(source)); this.persistTrust(); } }
  revokeWidgetTrust(source: string) { if (source && this.trustedWidgets.delete(widgetHash(source))) { this.persistTrust(); this.fullRender(); } }
  // A widget panel needs CONSENT before its code runs iff its exact source isn't on the trust list (i.e. it came from
  // an imported file and the user hasn't reviewed it). Content-addressed, so an edit re-gates and a re-import of a
  // trusted source does not.
  widgetNeedsConsent(p: Panel): boolean { return p.type === "Widget" && !!p.source && !this.trustedWidgets.has(widgetHash(p.source)); }
  // Was this widget's code IMPORTED (arrived via a session file), vs AUTHORED in a session? Only imported widgets get
  // their declared permissions BOUND at runtime — they're foreign code the user accepted at the consent gate under
  // stated terms. A widget you authored is governed only by the global host allowlist, so the declaration never blocks
  // your own (agent-driven) edits — it's documentation, not a gate. Signal: a matching library entry tagged "imported".
  widgetIsImported(p: Panel): boolean {
    if (p.type !== "Widget" || !p.source) return false;
    const h = widgetHash(p.source);
    return this.widgetLib.some((w) => w.origin === "imported" && w.source && widgetHash(w.source) === h);
  }

  // The DECLARES block — version/description/declared permissions — built with textContent (the manifest is foreign
  // data; never innerHTML it). Shared by the import consent gate AND the trusted-widget inspector, so what a widget
  // says it does is shown the same way before AND after you trust it.
  private widgetDeclaresEl(p: Panel): HTMLElement {
    const declares = mk("div"); declares.style.cssText = "font-size:11.5px;color:var(--text);background:var(--inset);border:1px solid var(--line);border-radius:6px;padding:8px;line-height:1.55";
    const addLine = (label: string, value: string) => { const d = mk("div"); const s = mk("span", undefined, label); s.style.cssText = "color:var(--faint);margin-right:6px"; d.append(s, document.createTextNode(value)); declares.appendChild(d); };
    if (p.version) addLine("version", p.version);
    if (p.description) { const d = mk("div"); d.textContent = p.description; declares.appendChild(d); }
    const caps: string[] = [];
    if (p.permissions?.external?.length) caps.push("fetches external data from: " + p.permissions.external.join(", "));
    if (p.permissions?.compute) caps.push("runs off-thread compute");
    caps.push("reads your data; can drive selection/colour");
    addLine("declares:", caps.join(" · "));
    return declares;
  }

  // INSPECT a TRUSTED, already-running widget — the post-trust analog of the consent gate. An authored widget skips the
  // gate (you watched it being built), so without this there's no UI to see what it DECLARED (permissions/version) or
  // read its source after the fact. Opened from the ⓘ button in a widget panel's header. textContent only (foreign code).
  // (Distinct from the agent-facing inspectWidget(panelId) below, which returns a live-state STRING for the model.)
  showWidgetInfo(p: Panel) {
    const ov = mk("div", "modal");
    const card = mk("div", "modalcard"); card.style.cssText = "max-width:680px;width:90vw;display:flex;flex-direction:column;gap:10px;text-align:left";
    const title = mk("div", "mtitle"); title.textContent = "Widget · " + (p.title || "Widget");
    const pre = mk("pre"); pre.style.cssText = "max-height:50vh;overflow:auto;font:11px var(--mono);background:var(--inset);border:1px solid var(--line);border-radius:6px;padding:8px;white-space:pre-wrap;color:var(--text);margin:0";
    pre.textContent = p.source || "(no source)";
    const acts = mk("div", "macts"); const okb = mk("button", "mok"); okb.textContent = "Close"; acts.appendChild(okb);
    card.append(title, this.widgetDeclaresEl(p), pre, acts); ov.appendChild(card);
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    ov.onclick = (e) => { if (e.target === ov) close(); };
    okb.onclick = () => close();
    document.body.appendChild(ov); document.addEventListener("keydown", onKey); okb.focus();
  }

  // The CONSENT PLACEHOLDER shown instead of mounting an untrusted (imported) widget — review the source, then trust+run
  // or remove. Built with textContent only (the title/source are foreign — never innerHTML them).
  renderWidgetGate(p: Panel, wrap: HTMLElement) {
    wrap.textContent = "";
    const box = mk("div", "wgate"); box.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;padding:14px;overflow:auto";
    const h = mk("div"); h.style.cssText = "font-weight:600;color:var(--text)"; h.textContent = "⚠ Untrusted widget";
    const msg = mk("div"); msg.style.cssText = "font-size:12px;color:var(--dim);line-height:1.45";
    msg.textContent = `“${p.title || "Widget"}” arrived in an imported session — its code has NOT run. Review it, then choose whether to run it. It would be sandboxed (no DOM/page access) and its compute terminable, but it can still read your data, drive selections/colour, and fetch from allow-listed biodata sources.`;
    // DECLARED module metadata (P4) — the SAME block the trusted-widget inspector shows (one builder, built with
    // textContent since the manifest is foreign data), so the user trusts an imported widget BY INSPECTION.
    const declares = this.widgetDeclaresEl(p);
    const pre = mk("pre"); pre.style.cssText = "display:none;flex:1;min-height:60px;overflow:auto;font:11px var(--mono);background:var(--inset);border:1px solid var(--line);border-radius:6px;padding:8px;white-space:pre-wrap;color:var(--text)";
    pre.textContent = p.source || "";
    const row = mk("div"); row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
    const review = mk("button"); review.textContent = "Review source"; review.onclick = () => { const on = pre.style.display === "none"; pre.style.display = on ? "block" : "none"; review.textContent = on ? "Hide source" : "Review source"; };
    const trust = mk("button"); trust.textContent = "Trust & run"; trust.style.cssText = "border-color:var(--good);color:var(--good)";
    trust.onclick = () => this.confirmModal({ title: "Run this imported widget?", body: "This is custom code from an imported session. Running it lets it read your data, drive selections/colour, and fetch from allow-listed biodata sources. Only run widgets from a source you trust.", ok: "Trust & run", onConfirm: () => { this.trustWidget(p.source || ""); this.fullRender(); } });
    const remove = mk("button"); remove.textContent = "Remove"; remove.onclick = () => { this.removePanel(p.id); this.fullRender(); };
    row.append(review, trust, remove); box.append(h, msg, declares, row, pre); wrap.appendChild(box);
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
      onTheme: (fn) => { const u = this.onTheme(fn); this.coordSubs.push(u); },   // managed theme-change subscription — torn down on fullRender alongside the coord subs
      focusCategory: (field, value) => { const r = this.focusFromOp({ dim: field, value }); if (!r.error) { this.fullRender(); this.checkpoint(`focus · ${field}=${value}`, "Restricted the workspace to a metadata value — release with the focus chip."); } },
      addPanel: (spec) => { this.addPanel(spec); this.fullRender(); },
      openSelectionMenu: (anchor) => { this.lastSelAnchor = anchor; this.openSelpop(); },   // ops menu for the current selection (facet/lasso/etc.)
      onConfigurePanel: (id, patch) => this.configurePanel(id, patch),
      registerGeneHover: (fn) => this.geneHoverSinks.push(fn),
      annotation: {   // the annotation-workflow capability namespace (only Reconcile/AnnoRecord use it)
        annotate: (ids, label, layer) => this.labelCells(ids, label, layer),
        annoLayer: (name) => this.annoLayers.get(name),
        saveRecord: (layerName, record) => { const L = this.annoLayers.get(layerName); if (L) { L.records = L.records || {}; const prev = L.records[record.label]; L.records[record.label] = record; if (layerName === "annotation" && prev?.category !== record.category) { this.refreshHierarchyLevels(L); this.repaint(); this.syncColorSelects(); } } },   // lineage changed → rebuild the L1/L2 rollups
        adoptSource: (name) => { this.adoptSource(name); },
        renameLabel: (layerName, from, to) => { this.renameLabel(layerName, from, to); },
        proposeRecord: (layerName, label) => { this.proposeRecord(label, layerName); },
        proposeAllNames: (layerName) => { this.proposeAllNames(layerName); },
        splitLabel: (label) => { this.splitLabel(label); },
        manageCategory: (input) => this.manageCategory(input),   // Metadata-panel manage card → the same verbs the agent uses
      },
      ledger: { entities: () => this.sessionEntities(), act: (ent, op, arg) => this.ledgerDo(ent, op, arg), exportSession: () => void this.exportSessionToFile(), importSession: () => void this.importSessionFromFile() },
      widgetHost: () => this.widgetHost(),
      onTeardown: (fn) => { this.teardowns.push(fn); },   // run + cleared each fullRender (like coordSubs) — no iframe leak
      registerWidget: (id, handle) => { this.widgetHandles.set(id, handle); },   // so inspect_widget can read a live widget's state
      onWidgetParam: (panelId, pid, value) => { this.setWidgetParam(panelId, pid, value, true); },   // a render:'self' control reported a change → persist/sync (fromWidget: no echo)
      widgetNeedsConsent: (p) => this.widgetNeedsConsent(p),                      // Item 2/C: gate untrusted (imported) widget code
      widgetIsImported: (p) => this.widgetIsImported(p),                          // P4: bind declared permissions for imported widgets only
      renderWidgetGate: (p, wrap) => this.renderWidgetGate(p, wrap),
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
    this.layoutCanvas(wb);   // place panels into the N-column grid (row-major by default; per-panel col pins override)
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
    const close = Object.assign(mk("button", "dismiss ico", "✕"), { title: "remove" }) as HTMLButtonElement;   // the shared light × (matches the Answers card)
    close.onclick = () => { this.canvas = this.canvas.filter((z) => z.id !== p.id); this.fullRender(); this.checkpoint("remove " + p.title, "You removed a panel — direct edits to your own layout always win."); };
    if (p.type === "Widget") { const info = Object.assign(mk("button", "mini", "ⓘ"), { title: "view source + declared permissions" }) as HTMLButtonElement; info.onclick = () => this.showWidgetInfo(p); sp.appendChild(info); }   // inspect a trusted widget (the post-trust analog of the consent gate)
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
      const col = d.dataset.col != null && d.dataset.col !== "" ? Number(d.dataset.col) : undefined;            // join the target's column (0-based)
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
  private wireWidgetControls(p: Panel, h: HTMLElement, sp: HTMLElement, beforeEl: HTMLElement, handle: { sendControl: (id: string) => void; sendParam: (id: string, v: any) => void; onManifest: (cb: (m: any) => void) => void }) {
    const rendered = new Set<string>();
    const place = (node: HTMLElement, late: boolean) => { if (late) (h as any)._ovfAdd?.(node, beforeEl); else sp.insertBefore(node, beforeEl); };
    const addBtn = (c: { id: string; label: string }, late: boolean) => {
      if (!c || !c.id || rendered.has("c:" + c.id)) return; rendered.add("c:" + c.id);
      const btn = Object.assign(mk("button", "mini", c.label), { title: c.label }) as HTMLButtonElement;
      btn.dataset.wcid = c.id; btn.onclick = () => handle.sendControl(c.id);
      place(btn, late);
    };
    // a typed PARAM renders as a header INPUT; a change routes through setWidgetParam (coerce/clamp + persist + → widget)
    const addParam = (pr: any, late: boolean) => {
      if (!pr || !pr.id || rendered.has("p:" + pr.id)) return; rendered.add("p:" + pr.id);
      if (pr.render === "self") return;   // the widget draws this control itself (placement is its call) — host adds NO header chip; the value still rides update_view/describe_panel/persistence
      const wrap = mk("span", "mini wparam"); wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:1px 5px";
      const lab = mk("span", undefined, pr.label); lab.style.cssText = "color:var(--faint);font-size:10px";
      let input: HTMLInputElement | HTMLSelectElement;
      if (pr.type === "select") { const s = document.createElement("select"); (pr.options || []).forEach((o: any) => { const op = document.createElement("option"); const obj = o && typeof o === "object"; op.value = String(obj ? o.value : o); op.textContent = String(obj ? (o.label ?? o.value) : o); s.appendChild(op); }); s.value = String(pr.value); input = s; }   // option is a string OR {value,label}
      else if (pr.type === "bool") { const i = document.createElement("input"); i.type = "checkbox"; i.checked = !!pr.value; input = i; }
      else if (pr.type === "color") { const i = document.createElement("input"); i.type = "color"; i.value = String(pr.value); input = i; }
      else if (pr.type === "number") { const i = document.createElement("input"); i.type = "number"; if (pr.min != null) i.min = String(pr.min); if (pr.max != null) i.max = String(pr.max); if (pr.step != null) i.step = String(pr.step); i.value = String(pr.value); i.style.width = "58px"; input = i; }
      else { const i = document.createElement("input"); i.type = "text"; i.value = String(pr.value ?? ""); i.style.width = "84px"; input = i; }
      // THEME the text-like inputs so a header param select/number/text matches the app's dark chrome (native controls render white otherwise — the bug behind "ugly white box").
      if (pr.type !== "bool" && pr.type !== "color") (input as HTMLElement).style.cssText += "background:var(--inset);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:1px 4px;font:inherit;font-size:11px;";
      (input as HTMLElement).dataset.wpid = pr.id;
      input.onchange = () => { const v = pr.type === "bool" ? (input as HTMLInputElement).checked : pr.type === "number" ? Number((input as HTMLInputElement).value) : (input as any).value; this.setWidgetParam(p.id, pr.id, v); };
      wrap.appendChild(lab); wrap.appendChild(input);
      place(wrap, late);
    };
    (p.controls || []).forEach((c) => addBtn(c, false));   // known from a prior render → before installOverflow
    (p.params || []).forEach((pr) => addParam(pr, false));
    handle.onManifest((m) => {   // first/updated manifest
      p.controls = m?.controls || [];
      if (m?.version) p.version = m.version; if (m?.description) p.description = m.description; if (m?.permissions) p.permissions = m.permissions;   // module metadata → persisted, shown at the consent gate on import
      // params: keep the manifest's DEFINITION (label/type/range) but a RESTORED value wins; re-apply restored values
      // to the freshly-mounted widget so its state matches what was persisted.
      const declared: any[] = m?.params || [], saved: any[] = p.params || [];
      p.params = declared.map((d) => { const s = saved.find((x) => x.id === d.id); return s && s.value !== undefined ? { ...d, value: s.value } : d; });
      for (const pr of p.params) { const d = declared.find((x) => x.id === pr.id); if (d && JSON.stringify(pr.value) !== JSON.stringify(d.value)) handle.sendParam(pr.id, pr.value); }
      (p.controls || []).forEach((c) => addBtn(c, true));
      p.params.forEach((pr) => addParam(pr, true));
    });
  }

  // Place the canvas into an N-column grid. The column count grows to fit the layout's deepest pin — default 2
  // (the friendly auto-balance width), but pin a panel to col 2 and the grid becomes three columns, so "three
  // side-by-side columns" is just col 0/1/2 (capped at MAX_COLS so a stray pin can't shred it into slivers).
  // Unpinned panels drop into the SHORTEST column so a new one doesn't pile onto a full one and scroll off; each
  // column's last panel spans the leftover rows so there's never an empty hole. `full` panels span the width.
  layoutCanvas(wb: HTMLElement) {
    const lone = this.canvas.length === 1;
    const pins = this.canvas.filter((p) => !p.full && typeof p.col === "number" && p.col >= 0).map((p) => p.col!);
    const ncol = Math.min(MAX_COLS, Math.max(2, ...(pins.length ? pins.map((c) => c + 1) : [2])));
    wb.style.gridTemplateColumns = `repeat(${ncol}, 1fr)`;
    const rowAt = new Array<number>(ncol).fill(1);                 // next free row in each column
    const last: (HTMLElement | null)[] = new Array(ncol).fill(null);
    for (const p of this.canvas) {
      const el = wb.querySelector<HTMLElement>(`.panel[data-pid="${p.id}"]`); if (!el) continue;
      if (p.full || lone) { const r = Math.max(...rowAt); el.style.gridColumn = "1 / -1"; el.style.gridRow = String(r); delete el.dataset.col; rowAt.fill(r + 1); last.fill(null); continue; }
      const col = typeof p.col === "number" && p.col >= 0 ? Math.min(ncol - 1, p.col) : rowAt.indexOf(Math.min(...rowAt));
      el.style.gridColumn = String(col + 1); el.style.gridRow = String(rowAt[col]++); el.dataset.col = String(col); last[col] = el;
    }
    const maxRow = Math.max(...rowAt) - 1;
    for (let c = 0; c < ncol; c++) { const el = last[c]; if (el && rowAt[c] - 1 < maxRow) el.style.gridRow = el.style.gridRow + " / " + (maxRow + 1); }
  }

  // Move a dragged panel next to a target, into the target's column (so you can drop a panel UNDER another to
  // stack it in that column). `after` = dropped on the lower half of the target.
  reorderTo(fromId: number, toId: number, after: boolean, col?: number) {
    if (fromId == null || fromId === toId) return;
    const from = this.canvas.findIndex((z) => z.id === fromId); if (from < 0) return;
    const [m] = this.canvas.splice(from, 1);
    if (typeof col === "number" && col >= 0) m.col = col;
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
      for (const r of this.compReactors) {
        // ORTHOGONAL guard: a category selection of a DIFFERENT grouping (e.g. a sample, while this panel is grouped by
        // cell_type) has no honest column mapping — refToCategories would return the selection's COMPOSITION (its top
        // cell types), which reads as "those columns are selected" and confuses. Suppress the highlight and surface a
        // pill notice instead. Same-grouping categories + cells/lasso selections keep the composition highlight.
        const orth = sel?.kind === "category" && (sel as any).grouping !== r.grouping && !!r.setOrthogonal;   // OPT-IN: only reactors that registered setOrthogonal (the dotplot) suppress + show a pill; others (e.g. the reconcile panel's `annotation` reactor) NEED the cross-grouping translation — leiden→annotation is how a selected cluster opens its working-draft record
        r.setSelect(sel && !orth ? new Set(this.ctx.refToCategories(sel, r.grouping).filter((t) => t.frac >= 0.08).map((t) => t.value)) : null);
        r.setOrthogonal?.(orth ? { grouping: (sel as any).grouping, value: (sel as any).value } : null);
      }
      this.lastSel = sel; this.reactorsStale = false;
    }
    this.$("railBtn").innerHTML = "Answers" + (this.rail.length ? ` <span class="badge">${this.rail.length}</span>` : "");
    this.renderFocus();   // keep the global focus chip (the release control) in sync
    this.renderSelChip();   // L2 select: the mild "what's selected" status chip
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
  applyPanelModel(p: Panel, patch: { title?: string; col?: number; full?: boolean; colorBy?: string; scope?: EntityRef | null; embedding?: string; colormap?: string; heatMode?: "heat" | "dot"; genes?: string[]; group?: string; style?: Record<string, any> }): boolean {
    let rebuild = false;
    if (patch.title != null && patch.title !== p.title) { p.title = patch.title; rebuild = true; }   // title shows in the header (panelEl) → rebuild
    if (typeof patch.col === "number" && patch.col >= 0) { if (patch.col !== p.col) rebuild = true; p.col = patch.col;
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
    if (patch.style) { const { clean } = clampStyle(getStyle(p.type), patch.style); (v as any).style = deepMerge((v as any).style || {}, clean); rebuild = true; }   // per-panel style override (clamped against the panel's own descriptor); rebuild → re-resolve on next paint
    p.view = v;
    return rebuild;
  }

  // describe_panel: the reflective "what can I style here?" surface (weak-C). Returns each styleable key with its
  // CURRENT effective value, default, and range — read from the same DEFAULT_STYLE the renderer paints from, so it
  // can't drift from what's actually honoured. P0 covers the Embedding family; other panel types report their named
  // knobs instead. The agent reads this like an MCP tool's schema, then sets keys via update_view({style}).
  describePanel(id?: number): { id?: number; type: string; params?: any[]; dataInputs?: Record<string, string>; controls?: { id: string; label: string }[]; note?: string } {
    const panel = id != null ? this.canvas.find((p) => p.id === id) : this.canvas.find((p) => p.type === "Embedding");
    if (id != null && !panel) return { id, type: "?", note: `no panel #${id}` };
    const type = panel?.type || "Embedding";
    // WIDGETS describe themselves at the INSTANCE level — from their own declared header controls (same idea as the
    // style registry, but the affordances come from the panel instance, not a type descriptor). The agent triggers
    // one like clicking the header button. This is the widget arm of strong-C: built-ins + widgets, one describe surface.
    if (type === "Widget" && panel) {
      const controls = panel.controls || [], wparams = panel.params || [];
      const hints: string[] = [];
      if (wparams.length) hints.push(`set a param with update_view({panels:[{id:${panel.id}, param:{id:'<id>', value:…}}]})`);
      if (controls.length) hints.push(`trigger a control with update_view({panels:[{id:${panel.id}, control:'<id>'}]})`);
      hints.push("read its live state with inspect_widget");
      return { id: panel.id, type, controls, params: wparams.length ? wparams : undefined, note: hints.join("; ") + "." };
    }
    const dataInputs = this.panelDataInputs(type);   // WHAT-TO-SHOW config (grouping/genes/scope/…) with live valid values — distinct from STYLE (how it looks)
    const d = getStyle(type);   // the PANEL's own registered descriptor (no central knowledge of this type)
    if (!d) return { id: panel?.id, type, dataInputs, note: dataInputs ? "no styleable params yet; dataInputs are this panel's data config — set via update_view({panels:[{id, …}]})." : `"${type}" exposes no styleable params or controls yet.` };
    const resolved = resolvePanelStyleFor(this.ctx, type, panel?.view);
    return { id: panel?.id, type, params: describeStyle(d, themeIsDark(), resolved), dataInputs, note: dataInputs ? "params STYLE the panel (visual constants); dataInputs are WHAT IT SHOWS — set via update_view({panels:[{id, …}]})." : undefined };
  }

  // describe_data: the dataset's FIELDS bucketed by ROLE (the data analog of describe_panel) — so the agent picks the
  // right field for the right slot instead of guessing. Heuristic (groupings()=clusterings, other categoricals=
  // covariates, numeric, genes) + any set_field_roles override; flags the likely pseudobulk replicate. Lives here (not
  // viewpatch) because it composes live ctx accessors; the pure bucketing is fieldroles.ts (node-tested).
  describeData(): string {
    const cats = this.ctx.categoricalFields().map((f) => ({ name: f, n: this.ctx.categoricalValues(f).length }));
    const numeric = this.ctx.metadataFields().filter((f) => f.kind === "numeric").map((f) => f.name);
    const b = fieldBuckets(this.ctx.groupings(), cats, numeric, this.ctx.view.nGenes, (f) => this.ctx.fieldRole(f) as any);
    const g = b.groupings.map((x) => `${x.name} (${x.n})`).join(", ") || "—";
    const cov = b.covariates.map((x) => `${x.name} (${x.n})${x.replicate ? " ⟵ replicate" : ""}`).join(", ") || "— (none — no experimental factors found)";
    return [
      "DATASET FIELDS by role — pick the right field for the right slot:",
      `• groupings (clusterings WITH markers — the only valid Heatmap 'group' + get_markers fields): ${g}`,
      `• covariates (experimental factors — COMPARE across these via facet / scope / pseudobulk replicate): ${cov}`,
      `• numeric (colour / threshold / compute_code): ${b.numeric.join(", ") || "—"}`,
      `• genes: ${b.geneCount.toLocaleString()} (HGNC symbols; address as gene:<SYMBOL>)`,
      `A covariate is NOT a grouping — to compare a quantity across it, facet by it (visual) or compute stat:'pseudobulk' replicate:${b.replicate ? `'${b.replicate}'` : "<the donor field>"} (statistical). Roles are heuristic; correct a wrong one with set_field_roles.`,
    ].join("\n");
  }

  // The configurable DATA inputs a panel type accepts (grouping/genes/scope/colour…) WITH live valid values — so the
  // agent that calls describe_panel to learn "what can I set here" gets the answer (vs only style keys). The valid
  // values come from ctx, so they can't go stale. Central per-type (like viewpatch's normalizer that enforces them);
  // A2 will add proper field-ROLE typing for the scope/covariate hint. Returns undefined for types with no data config.
  private panelDataInputs(type: string): Record<string, string> | undefined {
    const grps = this.ctx.groupings(), cats = this.ctx.categoricalFields();
    const covs = cats.filter((f) => !grps.includes(f));   // rough split (A2 types these properly): non-clustering categoricals read as covariates
    const scopeHint = `restrict to ONE population — scopeGrouping+scopeValue, any categorical${covs.length ? ` (covariates: ${covs.join(", ")})` : ""}; clearScope to undo`;
    if (type === "Heatmap") return {
      group: `the marker GROUPING — a clustering with markers, one of: ${grps.join(", ") || "—"} (a covariate like sample/condition is NOT a grouping — facet by it instead)`,
      heatMode: "'dotplot' (dot size = % expressing, colour = mean) | 'heatmap' (colour grid)",
      genes: "pin specific gene symbols via genes:[…] (shows ANY gene; clearGenes resets)",
      scope: scopeHint,
    };
    if (type === "Embedding") return {
      colorBy: "colour handle — meta:<field> | gene:<SYMBOL> | qc:<numeric> | geneset:<name>",
      colormap: `numeric palette — ${paletteNames().join(", ")}`,
      embedding: `projection — ${this.ctx.embeddingNames().join(", ") || "umap"}`,
      scope: scopeHint,
    };
    if (type === "CompositionBars") return { colorBy: "the grouping to stack by — meta:<grouping>", scope: scopeHint };
    return undefined;
  }

  // Trigger a widget's declared header control programmatically — the agent's analog of clicking the header button
  // (sends {t:"control", id} to the iframe). The widget self-updates; no host re-render needed.
  triggerWidgetControl(id: number, control: string): { ok?: string; error?: string } {
    const panel = this.canvas.find((p) => p.id === id);
    if (!panel) return { error: `no panel #${id}` };
    if (panel.type !== "Widget") return { error: `panel #${id} (${panel.type}) is not a widget — controls are a widget affordance` };
    if (!(panel.controls || []).some((c) => c.id === control)) return { error: `widget #${id} has no control "${control}" (declared: ${(panel.controls || []).map((c) => c.id).join(", ") || "none"})` };
    const handle = this.widgetHandles.get(id);
    if (!handle) return { error: `widget #${id} isn't mounted/live` };
    handle.sendControl(control);
    return { ok: `triggered control "${control}" on widget #${id}` };
  }

  // Set a widget's declared PARAM (a typed value knob) — coerce + clamp by type, store the value (for describe_panel +
  // persistence), send it to the widget, and reflect it in the header input. The agent's analog of editing the input.
  setWidgetParam(id: number, param: string, value: any, fromWidget = false): { ok?: string; error?: string } {
    const panel = this.canvas.find((p) => p.id === id);
    if (!panel) return { error: `no panel #${id}` };
    if (panel.type !== "Widget") return { error: `panel #${id} (${panel.type}) is not a widget — params are a widget affordance` };
    const pr = (panel.params || []).find((x) => x.id === param);
    if (!pr) return { error: `widget #${id} has no param "${param}" (declared: ${(panel.params || []).map((x) => x.id).join(", ") || "none"})` };
    const handle = this.widgetHandles.get(id);
    if (!handle) return { error: `widget #${id} isn't mounted/live` };
    let v = value;
    if (pr.type === "number") { v = Number(value); if (Number.isNaN(v)) return { error: `param "${param}" expects a number` }; if (pr.min != null) v = Math.max(pr.min, v); if (pr.max != null) v = Math.min(pr.max, v); }
    else if (pr.type === "bool") v = !!value;
    else if (pr.type === "select" && pr.options && !pr.options.some((o: any) => String(typeof o === "object" ? o.value : o) === String(value))) return { error: `param "${param}" must be one of: ${pr.options.map((o: any) => typeof o === "object" ? o.value : o).join(", ")}` };
    if (JSON.stringify(pr.value) === JSON.stringify(v)) return { ok: `"${param}" already ${JSON.stringify(v)}` };   // no-op (also breaks any echo loop)
    pr.value = v;   // persisted + reflected by describe_panel
    if (!fromWidget) {   // agent/user → push to the widget + reflect a header input. A WIDGET-initiated change already has the value, so DON'T echo it back (that would loop, and a render:'self' control has no header input to reflect).
      handle.sendParam(param, v);
      const inp = document.querySelector(`.panel[data-pid="${id}"] [data-wpid="${param}"]`) as HTMLInputElement | null;
      if (inp) { if (pr.type === "bool") inp.checked = !!v; else inp.value = String(v); }
    }
    this.scheduleSave();
    return { ok: `set "${param}" = ${JSON.stringify(v)} on widget #${id}` };
  }

  // ----- declarative view patcher: the single agent surface for "what to show" -----
  // Validates the patch against the live world, executes the resulting ops, and renders ONCE. New view knobs
  // are FIELDS in the patch (see viewpatch.ts), never new methods/tools. Returns applied/rejected/notes.
  async applyViewPatch(patch: RawViewPatch): Promise<{ applied: string[]; rejected: string[]; notes: string[] }> {
    const geneSet = new Set(await this.ctx.view.genes());   // warm + snapshot the gene index so geneExists is sync
    const all = () => [...this.canvas, ...this.rail];
    const world: World = {
      panelTypes: agentPanelTypes(),
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
        else if (op.kind === "catColors") {   // per-VALUE colour overrides for a categorical field (recolour just "low", or the unassigned cells)
          const cb = this.coord.state.colorBy;
          const field = op.field || (cb.startsWith("meta:") ? cb.slice(5) : "");
          if (!field) rejected.push("recolor: no categorical field — set a colour-by first, or pass field");
          else if (!this.ctx.groupings().includes(field)) rejected.push(`recolor: no categorical field "${field}"`);
          else {
            if (op.clear) { clearCategoryColors(field); applied.push(`reset colours of ${field}`); }
            const known = new Set(this.ctx.categoricalValues(field));   // sync (warmed); empty → skip the membership check
            for (const [rawV, colStr] of Object.entries(op.colors)) {
              const target = /^(unassigned|none|other|n\/?a|-1)?$/i.test(rawV.trim()) ? "" : rawV;   // unassigned aliases → the no-category cells
              if (target !== "" && known.size && !known.has(target)) { rejected.push(`recolor: "${target}" is not a value of ${field}`); continue; }
              const rgb = parseCssColorToRGB(colStr);
              if (!rgb) { rejected.push(`recolor: "${colStr}" isn't a recognisable colour`); continue; }
              setCategoryColor(field, target, rgb);
              applied.push(`${field}: ${target || "(unassigned)"} → ${colStr}`);
            }
            needFull = true;   // fullRender so the embedding AND the facets swatches / legend all pick up the override (a plain repaint skips the facets panel)
          }
        }
        else if (op.kind === "style") {   // the OPEN style escape hatch — patch a panel's rendering knobs (P0: the Embedding family)
          const { clean, notes: snotes } = clampStyle(getStyle("Embedding"), op.patch);   // global style targets the Embedding family (P0); clamp against its descriptor
          for (const n of snotes) notes.push(n);
          if (op.panel != null) {
            const p = all().find((z) => z.id === op.panel);
            if (!p) rejected.push(`style: no panel #${op.panel}`);
            else { p.view = p.view || {}; (p.view as any).style = op.reset ? undefined : deepMerge((p.view as any).style || {}, clean); applied.push(`style #${op.panel} ${op.reset ? "reset" : Object.keys(clean).join("/")}`); needFull = true; }
          } else {
            const cs = this.coord.state as any;   // global per-type style default (a panel's own view.style still wins)
            cs.style = op.reset ? undefined : { ...(cs.style || {}), Embedding: deepMerge(cs.style?.Embedding || {}, clean) };
            applied.push(`style ${op.reset ? "reset" : Object.keys(clean).join("/")}`); needFull = true;
          }
        }
        else if (op.kind === "triggerControl") {   // fire a widget's declared control (the widget self-updates in its iframe)
          const { ok, error } = this.triggerWidgetControl(op.id, op.control);
          if (error) rejected.push(error); else applied.push(ok!);
        }
        else if (op.kind === "setParam") {   // set a widget's declared typed param (the widget self-updates)
          const { ok, error } = this.setWidgetParam(op.id, op.param, op.value);
          if (error) rejected.push(error); else applied.push(ok!);
        }
        else if (op.kind === "customPalette") {   // a user/agent-defined numeric gradient → apply as the "custom" colormap
          const rgbs = op.stops.map((c) => parseCssColorToRGB(c)).filter(Boolean) as [number, number, number][];
          if (rgbs.length !== op.stops.length) rejected.push(`colorStops: ${op.stops.length - rgbs.length} colour(s) weren't recognisable`);
          if (rgbs.length && setCustomPalette(rgbs)) {
            for (const z of this.canvas) if (z.type === "Embedding") z.view = { ...z.view, colormap: "custom" };
            applied.push(`custom palette (${rgbs.length} stop${rgbs.length > 1 ? "s" : ""})`); needFull = true;
          } else if (!rgbs.length) rejected.push("colorStops: no usable colours");
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
              if (layout === "stack") spec.full = true; else { spec.col = k % 2; spec.full = false; }
              return this.newPanel(spec);
            });
            this.canvas.splice(idx, 1, ...facets);
            applied.push(`facet ${base} by ${op.by} → ${op.values.join(", ")}`); needFull = true;
          }
        }
        else if (op.kind === "unfacet") {
          // INVERSE of facet: collapse faceted copies back to one panel ("unsplit"/"go back"). A facet group = ≥2 panels
          // identical except their category scope (same type/title/group/genes, scope on the same grouping). Keep the
          // first (clear its scope → shows ALL cells again), remove the rest. unfacet:true = all groups; panel/by narrow it.
          const groups = new Map<string, Panel[]>();
          for (const p of this.canvas) {
            const sc = p.view?.scope as any;
            if (!sc || sc.kind !== "category") continue;
            if (op.by && sc.grouping !== op.by) continue;
            const key = `${p.type}|${p.title}|${p.group || ""}|${p.heatMode || ""}|${(p.genes || []).join(",")}|${sc.grouping}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(p);
          }
          let merged = 0; const removeIds = new Set<number>();
          for (const ps of groups.values()) {
            if (ps.length < 2) continue;
            if (op.panel != null && !ps.some((p) => p.id === op.panel)) continue;   // restrict to a specific panel's group
            const keep = ps[0]; const v = { ...(keep.view || {}) }; delete (v as any).scope; keep.view = v;   // un-scope the survivor
            for (const p of ps.slice(1)) removeIds.add(p.id);
            merged++;
          }
          if (merged) { this.canvas = this.canvas.filter((p) => !removeIds.has(p.id)); applied.push(`unfaceted ${merged} group${merged > 1 ? "s" : ""}`); needFull = true; }
          else notes.push("unfacet: no faceted panels to merge");
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
    const world: CellWorld = { categoricals: ctx.categoricalFields(), valuesOf: (f) => ctx.categoricalValues(f), hasSelection: this.selectionForCompute().length > 0, hasFocus: !!ctx.coord.state.focus };
    const e = validateCellSet(spec, world, "cells"); if (e) return { ids: new Int32Array(0), error: e };
    const env: CellEnv = { n: ctx.n, category: (g, v) => ctx.cellsOfCategory(g, v), selection: () => this.selectionForCompute(), focus: () => ctx.coord.state.focus?.ids ?? [] };
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

  // ── Derived/custom categorical FIELDS the agent creates + manages for the user (the manage_category tool) ──
  // A category = a named overlay (codes+categories) registered as a grouping. These ops build on the SAME
  // primitives the annotation draft uses (commitLayer / labelCells / renameLabel / resolveCells) but target ANY
  // named field — so "make a high-mito group", "rename/merge those", "delete it" all work. Create-from-an-
  // EXPRESSION (numeric threshold/score) goes through compute_code {kind:'category'}; these handle cell-sets + edits.

  // Rename a categorical FIELD (not a value). Only fields the agent created; rejects a name collision; follows colour.
  renameField(name: string, to: string): { ok?: string; error?: string } {
    if (name === "annotation") return { error: "the working annotation draft is managed in the Annotate workspace, not here" };
    const layer = this.annoLayers.get(name); if (!layer) return { error: `no custom category field "${name}" (only fields you created can be renamed)` };
    to = (to || "").trim(); if (!to) return { error: "empty field name" };
    if (to === name) return { ok: "unchanged" };
    if (this.annoLayers.has(to) || this.ctx.groupings().includes(to)) return { error: `a field "${to}" already exists — pick another name` };
    this.annoLayers.delete(name); this.ctx.removeAnnotationLayer(name);
    layer.name = to; this.annoLayers.set(to, layer); this.commitLayer(layer);   // re-registers under `to`
    if (this.coord.state.colorBy === "meta:" + name) { this.noteColor("meta:" + to); this.coord.setColor("meta:" + to); }
    return { ok: `renamed field "${name}" → "${to}"` };
  }

  // Delete a categorical field the agent created. Falls colour back to a default grouping if we were colouring by it.
  deleteCategory(name: string): { ok?: string; error?: string } {
    if (name === "annotation") return { error: "the working annotation draft can't be deleted here — use the Annotate workspace" };
    if (!this.annoLayers.has(name) && !this.ctx.isAnnotationLayer(name)) return { error: `no custom category field "${name}"` };
    this.annoLayers.delete(name); this.ctx.removeAnnotationLayer(name);
    if (this.coord.state.colorBy === "meta:" + name) {
      const gs = this.ctx.groupings(); const fb = gs.includes("cell_type") ? "cell_type" : gs[0];
      if (fb) { this.noteColor("meta:" + fb); this.coord.setColor("meta:" + fb); }
    }
    this.fullRender();
    return { ok: `deleted category field "${name}"` };
  }

  // The manage_category dispatcher — one tool, the full create/edit/delete lifecycle over a named categorical field.
  manageCategory(input: any): { ok?: string; error?: string } {
    const op = String(input?.op || "").trim();
    const name = String(input?.name || "").trim();
    if (!op) return { error: "manage_category: 'op' is required (create | set_cells | rename_value | merge_values | rename_field | delete)" };
    if (op === "rename_field") return this.renameField(name, String(input?.to || ""));
    if (op === "delete") return this.deleteCategory(name);
    if (!name) return { error: `manage_category ${op}: 'name' (the field) is required` };
    if (op === "create") {
      if (this.ctx.groupings().includes(name) && !this.annoLayers.has(name)) return { error: `"${name}" is an existing stored field — choose a new name` };
      const assigns = Array.isArray(input?.assignments) ? input.assignments : [];
      if (!assigns.length) return { error: "create: 'assignments' (array of {value, A}) is required" };
      const layer = seedLayer(name, "derived", { codes: new Int32Array(this.ctx.view.nCells).fill(-1), categories: [] });
      let total = 0;
      for (const a of assigns) {
        const value = String(a?.value || "").trim(); if (!value) return { error: "create: each assignment needs a non-empty 'value'" };
        if (!a?.A) return { error: `create: assignment "${value}" needs 'A' (a cell set)` };
        const { ids, error } = this.resolveCells(a.A); if (error) return { error: `create "${value}": ${error}` };
        setLabel(layer, ids, value); total += ids.length;
      }
      if (!layer.categories.length) return { error: "create: no cells were assigned to any value" };
      layer.provenance = { method: "manage_category" };
      this.commitLayer(layer); this.noteColor("meta:" + name); this.coord.setColor("meta:" + name);
      return { ok: `created field "${name}" (${layer.categories.length} categories: ${layer.categories.slice(0, 8).join(", ")}) — labeled ${total} cells; coloured by it` };
    }
    if (op === "set_cells") {
      const value = String(input?.value || "").trim(); if (!value) return { error: "set_cells: 'value' is required" };
      if (!input?.A) return { error: "set_cells: 'A' (a cell set) is required" };
      const { ids, error } = this.resolveCells(input.A); if (error) return { error: `set_cells: ${error}` };
      if (!ids.length) return { error: "set_cells: that cell set resolved to 0 cells" };
      this.labelCells(ids, value, name);
      return { ok: `labeled ${ids.length} cells as "${value}" in field "${name}"` };
    }
    if (op === "rename_value") return this.renameLabel(name, String(input?.from || ""), String(input?.to || ""));
    if (op === "delete_value") {
      const value = String(input?.value || "").trim(); if (!value) return { error: "delete_value: 'value' is required" };
      const layer = this.annoLayers.get(name); if (!layer) return { error: `no category field "${name}"` };
      const ci = layer.categories.indexOf(value); if (ci < 0) return { error: `delete_value: "${value}" is not a value in "${name}"` };
      let n = 0; const codes = layer.codes as Int32Array; for (let i = 0; i < codes.length; i++) if (codes[i] === ci) { codes[i] = -1; n++; }
      this.commitLayer(layer);   // compact() drops the now-empty category
      return { ok: `deleted value "${value}" (${n} cells unassigned) from "${name}"` };
    }
    if (op === "merge_values") {
      const into = String(input?.into || "").trim(); if (!into) return { error: "merge_values: 'into' is required" };
      const values = Array.isArray(input?.values) ? input.values.map((v: any) => String(v)) : [];
      if (!values.length) return { error: "merge_values: 'values' (array) is required" };
      const layer = this.annoLayers.get(name); if (!layer) return { error: `no category field "${name}"` };
      let merged = 0;
      for (const v of values) if (v !== into && layer.categories.includes(v)) { this.applyRename(layer, v, into); merged++; }
      if (!merged) return { error: `merge_values: none of [${values.join(", ")}] are values in "${name}"` };
      this.commitLayer(layer);
      return { ok: `merged ${merged} value(s) into "${into}" in field "${name}"` };
    }
    return { error: `manage_category: unknown op "${op}" — use create | set_cells | rename_value | merge_values | rename_field | delete` };
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
    return { title: patch.title, col: patch.col, full: patch.full, colorBy: patch.colorBy, embedding: patch.embedding, colormap: patch.colormap, heatMode: patch.heatMode, genes: patch.genes, group: patch.group, style: patch.style,
      scope: patch.scope === undefined ? undefined : (patch.scope === null ? null : { kind: "category", grouping: patch.scope.grouping, value: patch.scope.value } as EntityRef) };
  }

  // ----- compute primitive: a statistic over CELL-SET expressions (the "what to derive" narrow waist) -----
  // de(A, B=complement(A)) or overdispersion(A). A/B are CellSet exprs (category/selection/focus/all + boolean
  // ops), so the agent can test ANY set it can describe — not just the pre-baked selection-vs-rest etc. Binds
  // the result to the rail (or canvas with toCanvas) and returns a summary / error for the agent.
  // The selection a compute runs over: the LIVE selection if present, else the one PINNED when this agent turn started
  // (askScope). So a DE the user kicked off still runs on those cells even if they cleared the selection while the agent
  // was thinking. The pin never overrides a live selection — the agent can re-select mid-turn and that wins.
  selectionForCompute(): number[] | Int32Array {
    const live = this.ctx.selectedCells();
    if (live.length) return live;
    const s = this.askScope;
    return (s?.type === "selection" && s.ids && s.ids.length) ? s.ids : live;
  }

  async runCompute(input: { stat?: string; A?: CellSet; B?: CellSet; replicate?: string; paired?: boolean; toCanvas?: boolean; title?: string; source?: "user" | "agent" }): Promise<{ ok?: string; error?: string }> {
    const ctx = this.ctx;
    if (input.stat !== "de" && input.stat !== "overdispersion" && input.stat !== "pseudobulk") return { error: `unknown stat "${input.stat}" — use "de", "pseudobulk", or "overdispersion"` };
    if (!input.A) { if (input.stat === "overdispersion") input.A = { all: true } as CellSet; else return { error: "A (a cell set) is required" }; }   // global variable genes when no scope given
    const world: CellWorld = { categoricals: ctx.categoricalFields(), valuesOf: (f) => ctx.categoricalValues(f), hasSelection: this.selectionForCompute().length > 0, hasFocus: !!ctx.coord.state.focus };
    const eA = validateCellSet(input.A, world, "A"); if (eA) return { error: eA };
    const needsB = input.stat === "de" || input.stat === "pseudobulk";
    const Bexpr: CellSet | undefined = needsB ? (input.B ?? ({ complement: input.A } as CellSet)) : undefined;
    if (Bexpr) { const eB = validateCellSet(Bexpr, world, "B"); if (eB) return { error: eB }; }
    const env: CellEnv = { n: ctx.n, category: (g, v) => ctx.cellsOfCategory(g, v), selection: () => this.selectionForCompute(), focus: () => ctx.coord.state.focus?.ids ?? [] };
    let Aids = [...resolveCellSet(input.A, env)];
    if (!Aids.length) return { error: `A (${describeCellSet(input.A)}) resolves to no cells` };
    await ctx.view.genes();
    // The category a cell set RESOLVES to (so we can name it AUTHORITATIVELY), or null. {category} is itself; {selection}
    // resolves via the live OR ask-pinned selection ref; {focus} via the focus ref. Used both to label and to decide
    // whether the system title overrides a generic agent-supplied one.
    const catRefOf = (expr: any): { grouping: string; value: any } | null => {
      if (expr?.category) return expr.category;
      const r: any = expr?.selection ? (ctx.coord.state.selection || (this.askScope?.type === "selection" ? (this.askScope as any).sel : null)) : (expr?.focus ? ctx.coord.state.focus : null);
      return r?.kind === "category" ? { grouping: r.grouping, value: r.value } : null;
    };
    const catLabel = (g: string, v: any) => /^\d+$/.test(String(v)) ? `${g} ${v}` : String(v);   // bare-number cluster → name it ("leiden 4", not "4")
    // Human label that RESOLVES {selection}/{focus} to their LIVE identity — the chosen category (so a DE on the current
    // selection reads "CD14 mono vs rest" / "leiden 4 vs rest", not the generic "selection vs rest"), or a cell count for
    // a manual selection. Categories / all / set ops fall through to describeCellSet.
    const richLabel = (expr: any, ids: number[]): string => {
      const c = catRefOf(expr);
      if (c) return catLabel(c.grouping, c.value);
      if (expr?.selection) return `selection · ${ids.length.toLocaleString()} cells`;
      if (expr?.focus) { const f: any = ctx.coord.state.focus; return f?.label ? String(f.label) : "focus"; }
      return describeCellSet(expr);
    };
    const namedA = !!catRefOf(input.A);   // A is an authoritative category → the SYSTEM names the card (a generic agent `title` is ignored)
    const place = (spec: Partial<Panel>) => { if (input.toCanvas) this.addPanel(spec); else this.agent.addRail(spec); };
    // record EVERY result in the session registry (auto-accrue) — the spec makes it re-runnable, provenance + rows make
    // it browsable/exportable from the session ledger, regardless of whether the panel went to the canvas or the rail.
    const record = (kind: "de" | "pseudobulk" | "markers" | "hvg", name: string, summary: string, bind: string, rows: any[], aLabel?: string, bLabel?: string) =>
      this.results.add({ name, kind, spec: { stat: input.stat!, A: input.A, B: input.B, replicate: input.replicate, paired: input.paired }, who: input.source || "user", when: Date.now(), summary, bind, aLabel, bLabel, rows });

    if (input.stat === "overdispersion") {
      const hv = await ctx.view.overdispersedGenes(Aids, 1e9);   // ALL scored genes (topN caps the return; scoring is over every gene) — the panel filters/searches the full list
      if (!hv.length) return { error: "no overdispersion (store has no cell-major counts panel)" };
      const label = richLabel(input.A, Aids);
      const hvRows = hv.map((h) => ({ symbol: h.symbol, score: h.resid }));
      const hvName = namedA ? `Variable genes · ${label}` : (input.title || `Variable genes · ${label}`);
      place({ type: "GeneList", title: hvName, cap: "overdispersion", bind: "hvg:scope", rows: hvRows });
      record("hvg", hvName, `overdispersion · ${Aids.length.toLocaleString()} cells`, "hvg:scope", hvRows);
      return { ok: `top variable genes in ${label} (${Aids.length} cells), recomputed for this scope: ${hv.slice(0, 10).map((h) => h.symbol).join(", ")}` };
    }
    let Bids = [...resolveCellSet(Bexpr!, env)];
    if (!Bids.length) return { error: `B (${describeCellSet(Bexpr!)}) resolves to no cells` };
    // Exclude cells that fall in BOTH A and B — ambiguous for a contrast: drop from both sides, report the count. For
    // A-vs-rest or two values of one field the intersection is empty, so this is a no-op there; it only bites the
    // cross-field / selection cases that can actually overlap.
    let excludedBoth = 0;
    { const bset = new Set(Bids); const overlap = Aids.filter((i) => bset.has(i));
      if (overlap.length) { const oset = new Set(overlap); Aids = Aids.filter((i) => !oset.has(i)); Bids = Bids.filter((i) => !oset.has(i)); excludedBoth = overlap.length; } }
    if (!Aids.length || !Bids.length) return { error: `after excluding ${excludedBoth.toLocaleString()} cell(s) shared by A and B, one side is empty — the groups overlap too much to contrast` };
    const sharedNote = excludedBoth ? ` · ${excludedBoth.toLocaleString()} shared cells excluded` : "";
    const aL = richLabel(input.A, Aids), bL = input.B ? richLabel(Bexpr!, Bids) : "rest";
    // When either side is an authoritative category, the contrast IS the title — ignore a generic agent `title`. Only an
    // anonymous (manual-lasso) contrast falls back to the agent's title, so it can still NAME an otherwise-unlabelled set.
    const named = namedA || (input.B ? !!catRefOf(Bexpr!) : false);
    const titleOf = (sys: string) => named ? sys : (input.title || sys);

    // CLUSTER vs REST → the store's PRECOMPUTED 1-vs-rest markers (markers_<grouping>). Instant, NO matrix read — these
    // ARE the cluster-vs-rest DE. Reading the whole matrix to compare a cluster against everything is bytes-bound (the
    // 456MB cell-major copy); the precomputed markers exist exactly so this is free. Fires only when A is a single
    // grouping value, B is unspecified (= rest), and the store carries that grouping's markers.
    if (input.stat === "de" && !input.B && (input.A as any)?.category?.grouping) {
      const g = (input.A as any).category.grouping, val = (input.A as any).category.value;
      if (ctx.view.ds.hasField(`markers_${g}_lfc`)) {
        const rows0 = (await ctx.view.markers(g, 1e9)).get(val);
        if (rows0?.length) {
          const rows = rows0.map((r: any) => ({ gene: r.gene, symbol: r.symbol, lfc: r.lfc, p: r.padj }));
          place({ type: "DeTable", title: titleOf(`${aL} vs rest`), cap: "1-vs-rest markers", bind: "de:markers", aLabel: aL, bLabel: "rest", rows });
          record("markers", titleOf(`${aL} vs rest`), "1-vs-rest markers", "de:markers", rows, aL, "rest");
          const up = rows.filter((r: any) => r.lfc > 0).slice(0, 8).map((r: any) => r.symbol).join(", ");
          return { ok: `DE ${aL} vs rest from the store's precomputed 1-vs-rest markers — instant, no recompute. Up in ${aL}: ${up}. (To recompute at the cell level, compare ${aL} against a SPECIFIC other group instead of rest.)` };
        }
      }
    }

    // PSEUDOBULK (donor-level): aggregate A and B to per-REPLICATE means, t-test ACROSS replicates → REAL p-values.
    if (input.stat === "pseudobulk") {
      const rep = String(input.replicate || "").trim();
      if (!rep) return { error: "pseudobulk needs `replicate` — the donor/sample field that defines biological replicates (e.g. replicate:'sample'). The cells in A and B are aggregated to one value per replicate, then tested across replicates." };
      if (!ctx.categoricalFields().includes(rep)) return { error: `pseudobulk: replicate "${rep}" is not a categorical field (have: ${ctx.categoricalFields().join(", ")})` };
      const md: any = await ctx.view.metadata(rep);
      if (md.kind !== "categorical") return { error: `pseudobulk: replicate "${rep}" must be categorical` };
      const G = md.categories.length, ng = ctx.view.nGenes, minCells = 10;
      const sA = await ctx.view.groupStatsForCells(md.codes, G, Aids);
      const sB = await ctx.view.groupStatsForCells(md.codes, G, Bids);
      // PAIRED (the composer's Test 1): each replicate carries BOTH A and B cells → test the per-replicate A−B difference.
      if (input.paired) {
        const { rows: pr, reps } = pseudobulkPairedDECore(sA.mean, sA.n, sB.mean, sB.n, ng, G, minCells);
        if (reps.length < 2) return { error: `paired pseudobulk needs ≥2 ${rep}s carrying BOTH A and B cells (≥${minCells} each), but found ${reps.length}. Each ${rep} is its own paired control — pick a factor whose levels span both groups (or use cell-level).` };
        const genes = await ctx.view.genes();
        const rows = pr.map((r) => ({ gene: r.g, symbol: genes[r.g], lfc: r.lfc, p: r.p, meanA: r.meanA, meanB: r.meanB }));
        place({ type: "DeTable", title: titleOf(`${aL} vs ${bL}`), cap: `pseudobulk · paired across ${reps.length} ${rep}s${sharedNote}`, bind: "pseudobulk:paired", aLabel: aL, bLabel: bL, rows });
        record("pseudobulk", titleOf(`${aL} vs ${bL}`), `pseudobulk paired · ${rep} · ${reps.length} reps`, "pseudobulk:paired", rows, aL, bL);
        const sig = rows.filter((r) => r.p < 0.05).length;
        const top = rows.slice(0, 8).map((r) => `${r.symbol}${r.p < 0.05 ? "*" : ""}`).join(", ");
        return { ok: `paired pseudobulk DE ${aL} vs ${bL} across ${reps.length} ${rep}(s): ${sig} gene(s) at p<0.05 (paired t-test on the per-${rep} A−B difference — each ${rep} is its own control). Top by p: ${top}.` };
      }
      const { rows: pr, repsA, repsB } = pseudobulkDECore(sA.mean, sA.n, sB.mean, sB.n, ng, G, minCells);
      if (repsA.length < 2 || repsB.length < 2) return { error: `pseudobulk needs ≥2 replicates per group, but A has ${repsA.length} and B has ${repsB.length} ${rep}(s) with ≥${minCells} cells. Pick a replicate field with enough samples on each side (a 1-vs-1 or 3-vs-0 split can't carry a population claim).` };
      const genes = await ctx.view.genes();
      const rows = pr.map((r) => ({ gene: r.g, symbol: genes[r.g], lfc: r.lfc, p: r.p, meanA: r.meanA, meanB: r.meanB }));
      place({ type: "DeTable", title: titleOf(`${aL} vs ${bL}`), cap: `donor-level · ${repsA.length} vs ${repsB.length} ${rep}s${sharedNote}`, bind: "pseudobulk:donor", aLabel: aL, bLabel: bL, rows });
      record("pseudobulk", titleOf(`${aL} vs ${bL}`), `pseudobulk · ${rep} · ${repsA.length} vs ${repsB.length}`, "pseudobulk:donor", rows, aL, bL);
      const sig = rows.filter((r) => r.p < 0.05).length;
      const top = rows.slice(0, 8).map((r) => `${r.symbol}${r.p < 0.05 ? "*" : ""}`).join(", ");
      return { ok: `pseudobulk DE ${aL} vs ${bL} across ${rep}, ${repsA.length} vs ${repsB.length} replicates: ${sig} gene(s) at p<0.05 (Welch t-test on per-replicate mean log-expression). Top by p: ${top}. The replicate is the unit here, so unlike cell-level de this carries a real p-value and supports a population-level claim — but with few replicates power is limited; treat marginal hits cautiously.` };
    }

    // de (cell-level, ranking-grade)
    const { ranked, panel } = await ctx.view.subsampleDE(Aids, Bids);
    const rows = ranked.map((r: any) => ({ gene: r.gene, symbol: r.symbol, lfc: r.lfc, meanA: r.meanA, meanB: r.meanB }));   // ALL tested genes — the panel filters/searches the full list (render is capped)
    place({ type: "DeTable", title: titleOf(`${aL} vs ${bL}`), cap: "cell-level DE" + sharedNote, bind: "de:between", aLabel: aL, bLabel: bL, rows });   // title = the contrast (the identity); cap = the test TYPE (secondary, non-redundant) — the approx/ranking nature lives in the caveat
    record("de", titleOf(`${aL} vs ${bL}`), "cell-level DE" + sharedNote, "de:between", rows, aL, bL);
    const up = rows.filter((r: any) => r.lfc > 0).slice(0, 6).map((r: any) => r.symbol).join(", ");
    const dn = rows.filter((r: any) => r.lfc < 0).slice(0, 6).map((r: any) => r.symbol).join(", ");
    return { ok: `DE ${aL} (${Aids.length}) vs ${bL} (${Bids.length}), compared directly. Higher in ${aL}: ${up || "—"}. Higher in ${bL}: ${dn || "—"}.` };
  }

  // ----- the code escape hatch: sandboxed ad-hoc computation over a data snapshot, typed result binds to a panel -----
  async runComputeCode(input: { code?: string; genes?: string[]; grouping?: string; title?: string; toCanvas?: boolean }): Promise<{ ok?: string; error?: string }> {
    const ctx = this.ctx;
    if (typeof input.code !== "string" || !input.code.trim()) return { error: "code (an async function body returning {kind,…}) is required" };
    // build the worker snapshot (warmed categoricals, declared gene vectors, the embedding, optional grouping stats)
    // via the shared builder — the SAME snapshot a widget's pagoda.runCompute gets, so the two code paths can't drift.
    const { snapshot, unknown } = await buildComputeSnapshot(ctx, { genes: input.genes, grouping: input.grouping });
    const run = await runInWorker(input.code, snapshot, 5000);
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
    if (res.kind === "category") {
      // a new PERSISTENT categorical field (e.g. a numeric threshold → high/normal) — commit it as a derived
      // overlay (facetable/colourable/annotatable), then colour by it. Manage it afterwards via manage_category.
      if (this.ctx.groupings().includes(res.name) && !this.annoLayers.has(res.name)) return { error: `"${res.name}" is an existing stored field — choose a new field name` };
      const requested = res.categories.slice();
      const layer: AnnotationLayer = { name: res.name, source: "derived", codes: Int32Array.from(res.codes), categories: requested.slice(), records: {}, provenance: { method: "compute_code" } };
      this.commitLayer(layer);   // compacts → categories that ended up with 0 cells are dropped
      this.noteColor("meta:" + res.name); this.coord.setColor("meta:" + res.name);
      const got = layer.categories;   // the surviving (non-empty) categories
      const shown = got.slice(0, 8).join(", ") + (got.length > 8 ? ", …" : "");
      // A category that COLLAPSED (≥1 requested bucket empty) is almost always a threshold-on-the-wrong-SCALE
      // mistake — surface it so the agent can self-correct in the same turn rather than shipping a useless field.
      let warn = "";
      if (got.length < requested.length) {
        const empty = requested.filter((c) => !got.includes(c));
        warn = ` Note: ${empty.length} requested category(ies) ended up EMPTY (${empty.join(", ")}) — every cell fell into ${got.length === 1 ? `"${got[0]}"` : "the others"}. If that's unexpected, the cutoff is likely on the wrong SCALE (a QC field like mito may be a PERCENT 0–100, not a fraction 0–1 — inspect the field's min/max and re-create with a fitting threshold).`;
      }
      // Coverage: a SUBSET category (codes left at -1) is legitimate but looks "empty" when most cells are unlabeled —
      // disclose it so neither the agent nor the user mistakes a sparse field for a broken one.
      let unassigned = 0; for (let i = 0; i < layer.codes.length; i++) if (layer.codes[i] < 0) unassigned++;
      const cov = unassigned ? ` ${(this.ctx.n - unassigned).toLocaleString()}/${this.ctx.n.toLocaleString()} cells are labeled — ${unassigned.toLocaleString()} are left UNASSIGNED (they fall in no category; to put them in a bucket, assign them a value too).` : "";
      return { ok: `created categorical field "${res.name}" (${got.length} categories: ${shown}) and coloured the embedding by it — facet/annotate by it, or edit it with manage_category.${cov}${warn}${note}` };
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

  newPanel(p: Partial<Panel>): Panel {
    const np: Panel = { id: ++this.uid, type: p.type!, title: p.title || p.type!, cap: p.cap, full: p.full, col: p.col, bind: p.bind, text: p.text, q: p.q, group: p.group, gene: p.gene, aLabel: p.aLabel, bLabel: p.bLabel, heatMode: p.heatMode, genes: p.genes, view: p.view, split: p.split, rows: p.rows, source: p.source, controls: p.controls, params: p.params, version: p.version, description: p.description, permissions: p.permissions };   // widget module fields (P2 params, P4 version/description/permissions) MUST ride through restore — captureLayout serializes them, so newPanel (the reconstruct path for session/workspace restore) has to carry them or a reload silently drops a widget's knobs + its declared-permissions consent gate
    // panel-LOCAL persisted UI state (facet expand-set/sort/brush, record collapse) must ride through the same
    // reconstruct — else a workspace switch (which JSON-clones the canvas, then rebuilds via newPanel) silently
    // resets it. Carried as ad-hoc (p as any) fields so they don't need to bloat the Panel type.
    for (const k of ["facetOpen", "facetSort", "facetBrush"] as const) if ((p as any)[k] !== undefined) (np as any)[k] = (p as any)[k];
    return np;
  }

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
      h.appendChild(Object.assign(mk("span", "rtitle"), { textContent: p.title, title: p.title }));   // PRIMARY — tooltip recovers it if truncated
      if (p.cap) h.appendChild(Object.assign(mk("span", "rtcap"), { textContent: "· " + p.cap, title: p.cap }));   // SECONDARY — yields width first
      const sp = mk("div", "sp");
      const valid = this.agent.validate(p).ok;
      if (p.type !== "Note" && valid) { const pin = Object.assign(mk("button", "pin", "⤴"), { title: "pin to workbench" }); pin.onclick = () => { this.rail = this.rail.filter((z) => z.id !== p.id); this.canvas.push(this.newPanel(p)); this.fullRender(); if (!this.rail.length) this.setRail(false); this.checkpoint("pin " + p.title, "You promoted a disposable answer into your workbench — generation accretes only by your hand."); }; sp.appendChild(pin); }
      const ds = Object.assign(mk("button", "dismiss ico", "✕"), { title: "dismiss" }); ds.onclick = () => { this.rail = this.rail.filter((z) => z.id !== p.id); this.renderRail(); this.repaint(); if (!this.rail.length && !this.proposal) this.setRail(false); };
      sp.appendChild(ds); h.appendChild(sp); d.appendChild(h);
      if (p.q) d.appendChild(Object.assign(mk("div", "rq"), { textContent: "“" + p.q + "”" }));
      const H = this.ctx.handleOf(p.bind);
      if (H?.caveat) d.appendChild(this.caveatEl(p.bind, H.caveat));
      const built = await bodyFor(p, this.ctx, this.hooks());
      if (built.headerControls) { const ctrls = mk("div", "rctrls"); ctrls.appendChild(built.headerControls); d.appendChild(ctrls); }   // expose the gene-table filter in the disposable card too (was pin-only) — search/sort the FULL gene set without pinning first
      const b = mk("div", "pbody"); b.appendChild(built.el); d.appendChild(b);
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
    // A workspace is just a LAYOUT; the coordination space (selection, focus/subset) is global and travels across it —
    // so you can select a population here and keep interrogating it after rearranging panels. Only colourBy is per-WS
    // (each workspace remembers its own colouring). fullRender rebuilds the new panels' reactors and re-dispatches the
    // carried selection to them, so the new layout lights up the same cells.
    this.currentWS = name; this.coord.set({ colorBy: ws.colorBy });
    this.canvas = ws.panels.map((p) => this.newPanel(p));
    this.fullRender();
    if (name === "Annotate") this.ensureAnnotation();   // async: seed the working draft + an scType source, then re-render
    if (user) { this.toast("Switched to " + name, "A workspace is a named, reversible layout — your previous one is a step back in History."); this.checkpoint("workspace → " + name, "Deliberate workspace switch."); }
  }

  captureLayout(): Partial<Panel>[] { return this.canvas.map((p) => { const o: Partial<Panel> = { type: p.type, title: p.title, cap: p.cap, full: p.full, col: p.col, bind: p.bind, group: p.group, gene: p.gene, heatMode: p.heatMode, genes: p.genes, view: p.view ? JSON.parse(JSON.stringify(p.view)) : undefined, rows: this.capRows(p), source: p.source, controls: p.controls ? JSON.parse(JSON.stringify(p.controls)) : undefined, params: p.params ? JSON.parse(JSON.stringify(p.params)) : undefined, version: p.version, description: p.description, permissions: p.permissions ? JSON.parse(JSON.stringify(p.permissions)) : undefined, aLabel: p.aLabel, bLabel: p.bLabel, split: p.split ? JSON.parse(JSON.stringify(p.split)) : undefined };
    // same panel-local UI state newPanel carries — serialize it so a RELOAD (not just a workspace switch) restores
    // the facet expand-set/sort/brush + record collapse, instead of resetting to the default open category.
    for (const k of ["facetOpen", "facetSort", "facetBrush"] as const) if ((p as any)[k] !== undefined) (o as any)[k] = (p as any)[k];
    return o; }); }   // aLabel/bLabel: a pinned DE table's A/B column names; split: a concordance SplitHeat's gene×donor matrix (it's its ONLY data + lives on the canvas, so it must persist or the panel reloads empty)
  // Result tables now hold the FULL ranked gene list (all tested genes) for live search; cap what we PERSIST so a
  // big-gene-set DE/overdispersion panel doesn't bloat the session doc (the tail is recomputable; live search keeps all).
  private capRows(p: Panel): any[] | undefined { const r = p.rows; if (!r) return undefined; return (p.type === "DeTable" || p.type === "GeneList") && r.length > 500 ? r.slice(0, 500) : r; }

  // Add an author-written widget as a Widget panel on the workbench. Used by the agent's save_widget tool and the
  // custom-widget library menu. The iframe mounts via widgetBody; controls (if known) render in the header.
  // If a Widget panel with the SAME title is already on the canvas, UPDATE it in place (the re-author / "clean it up"
  // flow) instead of mounting a duplicate — mirrors the library's by-name upsert. fullRender re-mounts the iframe
  // from the new .source, so the running widget picks up the new code. Returns {id, updated}.
  addWidgetPanel(source: string, title?: string, controls?: { id: string; label: string }[], origin: "authored" | "imported" = "authored"): { id: number; updated: boolean; unchanged: boolean } {
    const name = title || "Widget";
    this.saveWidgetToLibrary(name, source, controls, origin);   // also keep it in the re-addable library (authored → trusted; imported → still gated)
    const existing = this.canvas.find((p) => p.type === "Widget" && p.title === name);
    if (existing) {
      const unchanged = existing.source === source;   // a no-op "revision" (e.g. an edit_widget that didn't apply) — surfaced so the agent doesn't claim a change that didn't happen
      existing.source = source; existing.controls = controls;
      this.fullRender(); this.checkpoint("update widget · " + name, "The agent revised an existing widget in place — same panel, new code; a reversible checkpoint.");
      return { id: existing.id, updated: true, unchanged };
    }
    return { id: this.addPanel({ type: "Widget", title: name, source, controls, bind: "widget:custom" }), updated: false, unchanged: false };
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
    const checks = widgetLint(target.source || "", h.manifest());   // REFLECT: well-formedness gaps to fix before declaring done (e.g. an internal slider that should be a param)
    return JSON.stringify({ panelId: target.id, title: target.title, manifest: h.manifest(), error: err ? err.message : null, checks, logs: h.logs().slice(-8), renderedText: (text || "").slice(0, 600) });
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
      { name: "Session", about: "ledger of everything you've made — categories, results, annotation, apps", spec: { type: "SessionLedger", title: "Session", cap: "session ledger" } },
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
      <div class="acsec"><div class="aclabel">AGENT CONNECTION</div>
        <div id="acconn">${this.agentStatusHtml()}</div>
        <button class="acbtn" id="acconnbtn" style="margin-top:8px">${resolveMode(getProvider()) === "off" ? "Set up agent…" : "Change…"}</button></div>
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
      else if (a === "reset") { c.classList.remove("show"); this.confirmReset(); } });   // confirm first — reset wipes the saved session
    c.querySelectorAll<HTMLElement>("[data-std]").forEach((el) => el.onclick = () => { const s = standard[Number(el.dataset.std)]; if (s) { this.addPanel({ ...s.spec }); this.toast(`Added ${s.name}`, null); } c.classList.remove("show"); });
    c.querySelectorAll<HTMLElement>("[data-add]").forEach((el) => el.onclick = () => { const w = this.widgetLib.find((x) => x.id === el.dataset.add); if (w) { this.addWidgetPanel(w.source, w.name, w.controls, w.origin === "imported" ? "imported" : "authored"); this.toast(`Added widget “${w.name}”`, null); } c.classList.remove("show"); });
    c.querySelectorAll<HTMLElement>("[data-del]").forEach((el) => el.onclick = (e) => { e.stopPropagation();   // confirm first — deleting from the library is irreversible
      const id = el.dataset.del!; const w = this.widgetLib.find((x) => x.id === id); const name = w ? w.name : "this widget";
      this.confirmModal({
        title: "Delete this widget?",
        body: `Remove <b>${esc(name)}</b> from your widget library? This can't be undone. Any copy already on the workbench stays — this only removes it from the add list.`,
        ok: "Delete",
        onConfirm: () => { this.deleteWidgetFromLibrary(id); this.openAccountMenu(); },   // re-render the list with it gone (menu was kept open behind the modal)
      }); });
    const sb = c.querySelector<HTMLInputElement>("#acwsearch");   // filter the combined list in place (no menu re-render → keeps focus)
    if (sb) sb.oninput = () => { const q = sb.value.trim().toLowerCase(); c.querySelectorAll<HTMLElement>(".acwrow").forEach((el) => { el.style.display = !q || (el.dataset.search || "").includes(q) ? "" : "none"; }); };
    // AGENT CONNECTION: the menu shows STATUS; "Change…" opens the full config card. (Outside-click dismiss is fine —
    // the card is its own overlay.)
    const connBtn = c.querySelector<HTMLElement>("#acconnbtn");
    if (connBtn) connBtn.onclick = (e) => { e.stopPropagation(); c.classList.remove("show"); this.showAgentConfig(); };
    if (resolveMode(getProvider()) === "proxy") void this.fillProxyStatus(this.$("acproxystat"));   // the proxy line needs a health round-trip
  }
  private fmtSecs(sec?: number): string { return sec == null ? "" : sec >= 3600 ? `~${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m` : `~${Math.max(1, Math.round(sec / 60))}m`; }
  // The active agent connection, as a short status line — mode-appropriate detail (proxy where + mode / OAuth expiry /
  // local where / API key). The proxy line is a placeholder filled by refreshProxyStatus (needs /api/health).
  agentStatusHtml(): string {
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
    const mode = resolveMode(getProvider());
    if (mode === "off") return `<div class="acsub">Copilot off.</div>`;
    if (mode === "local") { const lc = localCfg(); return `<div class="acsub" style="color:var(--good,#5abf8f)">Local model${lc?.model ? " · " + esc(lc.model) : ""} <span style="opacity:.7">at <span style="font-family:var(--mono)">${esc(lc?.url || "?")}</span></span></div>`; }
    if (mode === "oauth" || mode === "key") return this.credStatusHtml();
    return `<div class="acsub" id="acproxystat">Proxy · checking…</div>`;   // mode === "proxy"
  }
  // The pasted-credential status (OAuth countdown / API key / expired). Shared by the menu + the config card.
  credStatusHtml(): string {
    const s = credStatus();
    if (s.state === "none") return `<div class="acsub">No pasted credential.</div>`;
    const kind = s.kind === "oauth" ? "OAuth token" : "API key";
    if (s.state === "expired") return `<div class="acsub" style="color:#e2504a">${kind} expired — set a fresh one to continue.</div>`;
    if (s.state === "expiring") return `<div class="acsub" style="color:var(--amber,#e0a458)">${kind} · expires in ${this.fmtSecs(s.secondsLeft)} — re-paste soon.</div>`;
    if (s.kind === "oauth") return `<div class="acsub" style="color:var(--good,#5abf8f)">OAuth token · ${s.secondsLeft != null ? "active, expires in " + this.fmtSecs(s.secondsLeft) : "active (expires after a few hours; a credit balance isn't readable from a browser)"}</div>`;
    return `<div class="acsub" style="color:var(--good,#5abf8f)">API key · active <span style="opacity:.7">(balance isn't readable from a browser)</span></div>`;
  }
  // Fill a proxy status element in place after a /api/health round-trip: where it's reached + the server credential mode.
  async fillProxyStatus(el: HTMLElement | null): Promise<void> {
    if (!el) return;
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
    const base = proxyBase(); const where = base.startsWith("/") ? location.origin + base : base;
    try {
      const j = await (await fetch(base + "/health")).json();
      if (!j.ok) { el.innerHTML = `<span style="color:#e2504a">Proxy unreachable</span> <span style="opacity:.65">at ${esc(where)}</span>`; return; }
      const detail = j.mode === "oauth" ? `OAuth${j.expires_in ? " · server token expires in " + this.fmtSecs(j.expires_in) : ""}` : j.mode === "apikey" ? "server API key" : (j.mode || "");
      el.innerHTML = `<span style="color:var(--good,#5abf8f)">Proxy · ${esc(detail)}</span> <span style="opacity:.65">at ${esc(where)}</span>`;
    } catch { el.innerHTML = `<span style="color:#e2504a">Proxy unreachable</span> <span style="opacity:.65">at ${esc(where)}</span>`; }
  }
  // Called by the live agent on a 401/403 mid-run (an expired/invalid pasted token): open the config card so the
  // now-"expired" status + the field are right there to re-paste.
  onCredExpired(): void { this.showAgentConfig(); }

  // The comprehensive AGENT CONNECTION config card (modal): pick proxy / API-key-or-token / local model / off, fill the
  // mode's fields, Save. Everything is browser-local; only the proxy mode needs a running server. Opened from the
  // account menu's "Change…"/"Set up…" and auto-opened on a mid-run token expiry.
  showAgentConfig(): void {
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
    const cur = resolveMode(getProvider());
    let sel: string = (cur === "oauth" || cur === "key") ? "cred" : cur;   // one "cred" row covers key + OAuth
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)";
    const card = document.createElement("div");
    card.style.cssText = "width:440px;max-width:92vw;background:var(--panel);border:1px solid var(--line2);border-radius:12px;padding:16px 18px;box-shadow:0 18px 50px rgba(0,0,0,.5)";
    wrap.appendChild(card);
    const close = () => wrap.remove();
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
    const MODES = [
      { id: "proxy", title: "Shared proxy", sub: "bundled relay · server credential", badge: "needs a server", bad: true },
      { id: "cred", title: "API key or token", sub: "API key, or a subscription OAuth token", badge: "no server", bad: false },
      { id: "local", title: "Local model", sub: "vLLM / Ollama on your machine", badge: "no server", bad: false },
      { id: "off", title: "Off", sub: "pure viewer, no copilot", badge: "", bad: false },
    ];
    const body = (): string => {
      if (sel === "off") return `<div class="acsub">No copilot. The viewer, compute, and manual analysis all work on their own.</div>`;
      if (sel === "proxy") return `<label class="acsub" style="display:block;margin-bottom:4px">proxy url <span style="opacity:.7">(blank = same origin)</span></label><input id="acfp" type="text" class="acwsearch" value="${esc(proxyCfg() || "")}" placeholder="${esc(location.origin)}/api" style="font-family:var(--mono)"><div class="acsub" id="acproxystat" style="margin-top:8px">Checking the proxy…</div><div class="acsub" style="margin-top:6px;opacity:.7;line-height:1.45">The relay holds the server-side credential. The only mode that needs a running server; a cross-origin proxy must allow this page (CORS).</div>`;
      if (sel === "local") { const lc = localCfg(); return `<label class="acsub" style="display:block;margin-bottom:4px">endpoint url (OpenAI-compatible)</label><input id="acfu" type="text" class="acwsearch" value="${esc(lc?.url || "http://localhost:8000/v1")}" style="font-family:var(--mono)"><label class="acsub" style="display:block;margin:10px 0 4px">model</label><input id="acfm" type="text" class="acwsearch" value="${esc(lc?.model || "")}" placeholder="qwen3-8b" style="font-family:var(--mono)"><div class="acsub" style="margin-top:8px;opacity:.7;line-height:1.45">Runs in your browser, calling this endpoint directly — it must allow this page's origin (CORS).</div>`; }
      return `<div id="acfstat" style="margin-bottom:7px">${this.credStatusHtml()}</div><input id="acfk" type="password" autocomplete="off" class="acwsearch" placeholder="paste Anthropic API key…"><div id="acfdet" class="acsub" style="margin-top:5px;min-height:13px"></div><div class="acsub" style="margin-top:7px;opacity:.7;line-height:1.45">Stored only in this browser — requests go straight to Anthropic. A subscription OAuth token works too; it just expires after a few hours.</div>`;
    };
    const render = () => {
      card.innerHTML = `<div style="font-size:15px;font-weight:600;margin-bottom:3px">Agent connection</div>
        <div class="acsub" style="margin-bottom:12px;line-height:1.45">Where the copilot sends requests. Data, compute, and rendering always run in your browser.</div>
        <div style="display:flex;flex-direction:column;gap:6px">${MODES.map((m) => `<div class="acfmode" data-m="${m.id}" style="display:flex;align-items:center;gap:11px;padding:9px 11px;border:0.5px solid ${sel === m.id ? "var(--cyan,#78e0ff)" : "var(--line)"};border-radius:8px;cursor:pointer;background:${sel === m.id ? "var(--inset)" : "transparent"}"><div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:500">${m.title}</div><div class="acsub">${m.sub}</div></div>${m.badge ? `<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:${m.bad ? "rgba(224,164,88,.15)" : "rgba(90,191,143,.15)"};color:${m.bad ? "var(--amber,#e0a458)" : "var(--good,#5abf8f)"};white-space:nowrap">${m.badge}</span>` : ""}<span style="visibility:${sel === m.id ? "visible" : "hidden"};color:var(--cyan,#78e0ff)">✓</span></div>`).join("")}</div>
        <div style="margin-top:13px;border-top:0.5px solid var(--line);padding-top:13px">${body()}</div>
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end"><button class="acbtn" id="acfcancel" style="margin:0;width:auto;padding:0 14px">Cancel</button><button class="acbtn" id="acfsave" style="margin:0;width:auto;padding:0 18px">Save</button></div>`;
      card.querySelectorAll<HTMLElement>(".acfmode").forEach((el) => el.onclick = () => { sel = el.dataset.m!; render(); });
      if (sel === "proxy") void this.fillProxyStatus(card.querySelector<HTMLElement>("#acproxystat"));
      if (sel === "cred") { const k = card.querySelector<HTMLInputElement>("#acfk"), d = card.querySelector<HTMLElement>("#acfdet"); if (k && d) { k.oninput = () => { const det = detectCred(k.value); d.textContent = det ? (det.kind === "oauth" ? "detected: OAuth token" + (det.expiresAt ? " (with expiry)" : "") : "detected: API key") : ""; }; setTimeout(() => k.focus(), 0); } }
      (card.querySelector("#acfcancel") as HTMLElement).onclick = close;
      (card.querySelector("#acfsave") as HTMLElement).onclick = () => this.saveAgentConfig(sel, card, close);
    };
    render();
    document.body.appendChild(wrap);
  }
  // Apply the chosen mode from the config card, then re-check reachability + toast. Provider is derived: local→openai,
  // everything else→anthropic. "off" wins via the explicit flag.
  private saveAgentConfig(sel: string, card: HTMLElement, close: () => void): void {
    const setProv = (p: string) => { try { localStorage.setItem(PROVIDER_KEY, p); } catch { /* */ } };
    if (sel === "off") { setAgentOff(true); }
    else if (sel === "proxy") { const p = (card.querySelector("#acfp") as HTMLInputElement)?.value.trim() || ""; setProxyCfg(p); setAgentOff(false); setProv("anthropic"); clearCred(); }   // blank → same-origin
    else if (sel === "local") {
      const url = (card.querySelector("#acfu") as HTMLInputElement)?.value.trim() || "";
      const model = (card.querySelector("#acfm") as HTMLInputElement)?.value.trim() || "";
      if (!url) { this.toast("Enter the local endpoint URL", null); return; }
      setAgentOff(false); setProv("openai"); setLocalCfg(url, model);
    } else {   // cred (API key or OAuth token)
      const v = (card.querySelector("#acfk") as HTMLInputElement)?.value.trim() || "";
      setAgentOff(false); setProv("anthropic");
      if (v) { const cc = saveCred(v); if (!cc) { this.toast("Couldn't read that as a key or token", null); return; } }
      else if (!loadCred()) { this.toast("Paste an API key or token first", null); return; }
    }
    close();
    void checkLive(getProvider()).then((ok) => { this.agent.live = ok; });
    const m = resolveMode(getProvider());
    this.toast("Agent connection updated", m === "off" ? "Copilot is off — the viewer works on its own." : "Mode: " + (m === "oauth" ? "OAuth token" : m === "key" ? "API key" : m) + (m === "proxy" || m === "local" ? "" : " · browser-direct"));
  }
  // A small confirmation modal for a destructive action: spells it out, defaults focus to Cancel, dismisses on
  // Esc / backdrop / Cancel (→ onCancel), and runs onConfirm only on the explicit OK click. `title`/`body`/`ok`
  // are HTML (the caller escapes any dynamic text). All clicks are kept INSIDE the overlay so the page's
  // outside-click dismissers (e.g. the account-menu close on line ~1371) don't fire — that lets a menu stay open
  // behind the modal and re-render itself in onConfirm. The OK button is danger-styled (.mok = var(--bad)).
  confirmModal(o: { title: string; body: string; ok: string; onConfirm: () => void; onCancel?: () => void }) {
    const ov = mk("div", "modal");
    ov.innerHTML = `<div class="modalcard">
      <div class="mtitle">${o.title}</div>
      <div class="mbody">${o.body}</div>
      <div class="macts"><button class="mcancel">Cancel</button><button class="mok">${o.ok}</button></div></div>`;
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); o.onCancel?.(); } };
    ov.onclick = (e) => { e.stopPropagation(); if (e.target === ov) { close(); o.onCancel?.(); } };   // backdrop = cancel; stopPropagation isolates from outside-click dismissers
    (ov.querySelector(".mcancel") as HTMLElement).onclick = (e) => { e.stopPropagation(); close(); o.onCancel?.(); };
    (ov.querySelector(".mok") as HTMLElement).onclick = (e) => { e.stopPropagation(); close(); o.onConfirm(); };
    document.body.appendChild(ov); document.addEventListener("keydown", onKey);
    (ov.querySelector(".mcancel") as HTMLElement).focus();
  }
  // Reset wipes the saved session (destructive + irreversible once reloaded), so confirm first via a modal that
  // spells out exactly what's lost vs kept, and points at "Save to file…" as the escape.
  confirmReset() {
    const esc = (s: string) => String(s).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]!));
    this.confirmModal({
      title: "Reset this session?",
      body: `This permanently clears everything saved for <b>${esc(this.currentStore())}</b> — your <b>panel layout</b>, any <b>widgets you added</b> to the workbench, the <b>working annotation draft</b>, and the <b>chat history</b> — then reloads to the dataset's default.<br><br>Your saved widget <i>library</i> and theme are kept. To keep this session, <b>Save to file…</b> first instead.`,
      ok: "Reset &amp; reload",
      onConfirm: () => { try { localStorage.removeItem(SESSION_KEY); } catch { /* */ } location.reload(); },
    });
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
      const sel = this.coord.state.selection as any;
      this.scope = { type: "selection", ids: Array.from(ids), summary: `${ids.length} cells (mostly ${top?.[0] || "?"})`, sel } as any;
      const esc = (s: string) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
      const sp = this.$("selpop");
      // DE is direct (no agent). "Run DE" is the one-click selection-vs-rest; "Compare A vs B…" opens the composer
      // (prefilled with this selection as A) for the general case — two groups, unions, cross-field, cell-level or
      // paired pseudobulk. The composer replaced the old stateful group-B pin.
      sp.innerHTML = `<div class="head">${ids.length} cells · mostly ${top?.[0] || "?"}</div>` +
        `<div class="it" data-a="ask"><span class="ic">⌘K</span>Ask about these…</div>` +
        `<div class="it" data-a="de"><span class="ic">≢</span>Run DE <span style="opacity:.5;margin-left:auto;font-size:10px">vs rest</span></div>` +
        `<div class="it" data-a="compare"><span class="ic">⇄</span>Compare A vs B…</div>` +
        `<div class="it" data-a="subset"><span class="ic">⊙</span>Subset to these <span style="opacity:.5;margin-left:auto;font-size:10px">hide the rest</span></div>` +
        `<div class="it" data-a="label"><span class="ic">✎</span>Save selection…</div>` +
        `<div class="it" data-a="clear"><span class="ic">✕</span>Clear selection</div>`;
      this.showSelpop();   // reveal at lastSelAnchor + arm the popover's own outside-dismiss listener
      const A = () => this.selToCellSet(sel, ids); const aL = this.selLabel(sel, ids);
      sp.querySelectorAll<HTMLElement>(".it").forEach((it) => it.onclick = () => { const a = it.dataset.a;
        if (a === "label") { this.selpopLabelInput(Array.from(ids)); return; }   // sub-view — popover stays open
        this.hideSelpop();
        if (a === "ask") this.openPalette(this.scope!);
        else if (a === "de") this.runDEdirect(A(), aL, undefined, "rest");
        else if (a === "compare") this.openDEComposer({ sel, ids: Array.from(ids) });   // general A-vs-B composer, prefilled with this selection as A
        else if (a === "subset") {   // L3: promote the selection to the working subset — the rest is hidden from every view
          const op = sel?.kind === "category" ? { dim: sel.grouping, value: sel.value } : { set: Array.from(ids), label: `${ids.length.toLocaleString()} cells` };
          this.coord.setSelection(null);   // the subset becomes the frame — nothing is sub-selected within it
          const r = this.focusFromOp(op);
          if (r.error) this.toast(r.error, null); else { this.fullRender(); this.checkpoint(`subset · ${r.label}`, "Restricted the workspace to this subset — the rest is hidden from every view. “Back to full” restores."); }
        }
        else { this.coord.setSelection(null); this.scope = null; } });
    });
  }
  // current selection → a CellSet: a category selection keeps its identity (nice labels + the precomputed-markers fast
  // path); a manual lasso becomes a literal {set} so it can be pinned as a fixed group even after the live selection moves.
  private selToCellSet(sel: any, ids: ArrayLike<number>): CellSet {
    return sel?.kind === "category" ? { category: { grouping: sel.grouping, value: sel.value } } : { set: Array.from(ids as ArrayLike<number>) };
  }
  private selLabel(sel: any, ids: ArrayLike<number>): string {
    if (sel?.kind === "category") return /^\d+$/.test(String(sel.value)) ? `${sel.grouping} ${sel.value}` : String(sel.value);
    return `${ids.length.toLocaleString()} cells`;
  }
  // the heuristically-flagged donor/replicate field (for offering donor-level pseudobulk), or null
  private likelyReplicate(): string | null {
    const cats = this.ctx.categoricalFields().map((f) => ({ name: f, n: this.ctx.categoricalValues(f).length }));
    const numeric = this.ctx.metadataFields().filter((f) => f.kind === "numeric").map((f) => f.name);
    const b = fieldBuckets(this.ctx.groupings(), cats, numeric, this.ctx.view.nGenes, (f) => this.ctx.fieldRole(f) as any);
    return (b as any).replicate || null;
  }
  // run DE straight to the canvas (no agent). B omitted ⇒ vs rest; replicate set ⇒ donor-level pseudobulk.
  private async runDEdirect(A: CellSet, aLabel: string, B: CellSet | undefined, bLabel: string, replicate?: string) {
    this.toast(`computing ${replicate ? "donor-level " : ""}DE — ${aLabel} vs ${bLabel}…`, null);
    const r = await this.runCompute({ stat: replicate ? "pseudobulk" : "de", A, B, replicate, toCanvas: true, source: "user" });
    if (r.error) this.toast(`DE failed: ${r.error}`, null);
  }
  // The unified SESSION LEDGER list — categories (editable annoLayers + derived groupings), the annotation, results,
  // and apps, normalized to one row shape. Gathers live state and hands it to the pure builder (node-tested).
  sessionEntities(): SessionEntity[] {
    const categories: { name: string; values: number; who: "user" | "agent"; when: number; derived?: boolean }[] = [];
    for (const L of this.annoLayers.values()) if (L.name !== "annotation") categories.push({ name: L.name, values: L.categories.length, who: "user", when: 0 });
    for (const name of this.ctx.derivedGroupings()) categories.push({ name, values: this.ctx.categoricalValues(name).length, who: "user", when: 0, derived: true });
    const ann = this.annoLayers.get("annotation");
    const annotation = ann ? { labels: ann.categories.length, records: ann.records ? Object.keys(ann.records).length : 0 } : null;
    const apps = this.widgetLib.map((w) => ({ id: w.id, name: w.name, origin: w.origin || "authored", when: w.createdAt || 0 }));
    return buildSessionEntities({ categories, annotation, results: this.results.list(), apps });
  }

  // The session-ledger row action dispatcher — open / re-run / rename / delete / export, routed by entity type. Data
  // mutations end with a fullRender so the ledger panel (and anything keyed on the changed entity) rebuilds.
  ledgerDo(ent: SessionEntity, op: "open" | "rename" | "delete" | "rerun" | "export", arg?: string): void {
    const ref = ent.ref;
    if (op === "open") {
      if (ref.kind === "category") { this.noteColor("meta:" + ref.name); this.coord.setColor("meta:" + ref.name); this.switchWS("Metadata", true); }
      else if (ref.kind === "annotation") this.switchWS("Annotate", true);
      else if (ref.kind === "result") { const r = this.results.get(ref.id!); if (r) { this.addPanel({ type: r.kind === "hvg" ? "GeneList" : "DeTable", title: r.name, cap: r.summary, bind: r.bind, aLabel: r.aLabel, bLabel: r.bLabel, rows: r.rows }); this.fullRender(); } }
      else if (ref.kind === "app") { const w = this.widgetLib.find((x) => x.id === ref.id); if (w) { this.addWidgetPanel(w.source, w.name, w.controls, w.origin === "imported" ? "imported" : "authored"); this.fullRender(); } }
      return;
    }
    if (op === "rerun") { if (ref.kind === "result") this.rerunResult(ref.id!); return; }
    if (op === "rename") {
      const to = (arg || "").trim(); if (!to) return;
      if (ref.kind === "category") { if (this.annoLayers.has(ref.name!)) { const r = this.renameField(ref.name!, to); if (r.error) { this.toast(r.error, null); return; } } else { this.toast("derived categories are renamed from the Metadata panel", null); return; } }
      else if (ref.kind === "result") this.results.rename(ref.id!, to);
      else { this.toast("rename it from its own panel", null); return; }
      this.fullRender(); return;
    }
    if (op === "delete") {
      if (ref.kind === "category") { if (this.annoLayers.has(ref.name!)) { const r = this.deleteCategory(ref.name!); if (r.error) this.toast(r.error, null); } else { this.ctx.removeDerivedGrouping(ref.name!); this.fullRender(); } }
      else if (ref.kind === "result") { this.results.remove(ref.id!); this.fullRender(); }
      else if (ref.kind === "annotation") { this.annoLayers.delete("annotation"); this.ctx.removeAnnotationLayer("annotation"); this.fullRender(); }
      else if (ref.kind === "app") { this.deleteWidgetFromLibrary(ref.id!); this.fullRender(); }
      return;
    }
    if (op === "export") this.exportEntityCSV(ent);
  }
  // Per-item ONE-WAY export (write-only side-files, for taking an artifact into other tools): a result → gene table CSV;
  // a category / the annotation → cell→value CSV; an app → its widget source .js. The whole-session round-trip stays JSON.
  async exportEntityCSV(ent: SessionEntity): Promise<void> {
    const ref = ent.ref;
    const dl = (name: string, text: string, mime = "text/csv") => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
    const cell = (s: any) => { const v = String(s ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
    const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
    try {
      if (ref.kind === "result") {
        const r = this.results.get(ref.id!); if (!r) return;
        const hasMeans = r.rows.some((x: any) => x.meanA != null), hasP = r.rows.some((x: any) => x.p != null), isHvg = r.kind === "hvg";
        const cols = isHvg ? ["symbol", "score"] : (["symbol", "lfc"] as string[]).concat(hasP ? ["p"] : []).concat(hasMeans ? ["meanA", "meanB"] : []);
        const head = isHvg ? ["gene", "score"] : (["gene", "logFC"] as string[]).concat(hasP ? ["p"] : []).concat(hasMeans ? [r.aLabel || "A", r.bLabel || "B"] : []);
        dl(safe(r.name) + ".csv", [head.join(",")].concat(r.rows.map((x: any) => cols.map((c) => cell(x[c])).join(","))).join("\n"));
      } else if (ref.kind === "category" || ref.kind === "annotation") {
        const field = ref.name!;
        const m: any = await this.ctx.metaOf(field); if (!m || !m.codes) { this.toast("nothing to export", null); return; }
        const cells = await this.ctx.view.ds.axisLabels("cells");
        const records: any = ref.kind === "annotation" ? (this.annoLayers.get("annotation")?.records || {}) : {};
        const isAnn = ref.kind === "annotation";
        const lines = [isAnn ? "cell,label,parent" : "cell,value"];
        for (let i = 0; i < m.codes.length; i++) { const c = m.codes[i]; if (c < 0) continue; const v = m.categories[c]; lines.push(isAnn ? `${cell(cells[i])},${cell(v)},${cell(records[v]?.category || "")}` : `${cell(cells[i])},${cell(v)}`); }
        dl(safe(field) + ".csv", lines.join("\n"));
      } else if (ref.kind === "app") {
        const w = this.widgetLib.find((x) => x.id === ref.id); if (w) dl(safe(w.name) + ".js", w.source, "text/javascript");
      }
      this.toast(`exported ${ent.name}`, null);
    } catch (e) { this.toast(`export failed: ${(e as Error).message}`, null); }
  }

  // Re-run a stored result from its spec (e.g. after editing a category it depends on) → a fresh result + panel.
  async rerunResult(id: string): Promise<void> {
    const r = this.results.get(id); if (!r) { this.toast("result no longer available", null); return; }
    this.toast(`re-running ${r.name}…`, null);
    const res = await this.runCompute({ ...r.spec, toCanvas: true, source: "user" });
    if (res.error) this.toast(`re-run failed: ${res.error}`, null);
  }

  // The DE composer — build group A and B from any field's values (+ the current selection), drag chips between them,
  // pick cell-level or paired-pseudobulk, run. B empty ⇒ rest. Body-level modal so it survives a fullRender; A and B
  // resolve to CellSets handed to runCompute (which excludes A∩B and reports it). Replaces the old group-B pin.
  openDEComposer(prefill?: { sel?: any; ids?: number[] }) {
    if (document.getElementById("decomp")) return;
    const ctx = this.ctx;
    type Member = { kind: "category"; grouping: string; value: string } | { kind: "cells"; ids: number[]; label: string };
    const A: Member[] = [], B: Member[] = [];
    const sel = prefill?.sel ?? ctx.coord.state.selection;
    const selIds = prefill?.ids ?? Array.from(ctx.selectedCells());
    if ((sel as any)?.kind === "category") A.push({ kind: "category", grouping: (sel as any).grouping, value: String((sel as any).value) });
    else if (selIds.length) A.push({ kind: "cells", ids: selIds.slice(), label: `selection · ${selIds.length.toLocaleString()}` });
    let method: "de" | "pseudobulk" = "de";
    let replicate = this.likelyReplicate() || ctx.categoricalFields()[0] || "";
    let target: "A" | "B" = "B";
    let dragRef: { m: Member; from: "A" | "B" } | null = null;
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
    const fmt = (x: number) => x.toLocaleString();
    const memberCS = (m: Member): CellSet => m.kind === "category" ? { category: { grouping: m.grouping, value: m.value } } : { set: m.ids };
    const sideCS = (arr: Member[]): CellSet | null => arr.length ? (arr.length === 1 ? memberCS(arr[0]) : { union: arr.map(memberCS) }) : null;
    const memLabel = (m: Member) => m.kind === "category" ? m.value : m.label;
    const memField = (m: Member) => m.kind === "category" ? m.grouping : "cells";
    // the value picker's flat item list (option index → a member to clone): the current selection, then every category value
    const items: Member[] = [];
    if (selIds.length) items.push({ kind: "cells", ids: selIds.slice(), label: `selection · ${selIds.length.toLocaleString()}` });
    const selCount = items.length;
    for (const f of ctx.metadataFields()) if (f.kind === "categorical") for (const v of ctx.categoricalValues(f.name)) items.push({ kind: "category", grouping: f.name, value: String(v) });

    const back = document.createElement("div"); back.id = "decomp"; back.className = "demodal"; back.innerHTML = `<div class="decard"></div>`;
    const card = back.querySelector(".decard") as HTMLElement; document.body.appendChild(back);
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey, true);
    back.onpointerdown = (e) => { if (e.target === back) close(); };

    const addOptions = () => {
      let h = `<option value="">add a value…</option>`;
      if (selCount) h += `<optgroup label="selection"><option value="0">${esc((items[0] as any).label)}</option></optgroup>`;
      let cur = "", buf = "";
      for (let i = selCount; i < items.length; i++) { const m = items[i] as any;
        if (m.grouping !== cur) { if (cur) buf += `</optgroup>`; cur = m.grouping; buf += `<optgroup label="${esc(cur)}">`; }
        buf += `<option value="${i}">${esc(m.value)}</option>`; }
      return h + buf + (cur ? `</optgroup>` : "");
    };
    const chips = (arr: Member[], grp: "A" | "B") => arr.length
      ? arr.map((m, i) => `<span class="dechip" draggable="true" data-g="${grp}" data-i="${i}"><span class="df">${esc(memField(m))} ·</span> ${esc(memLabel(m))}<i class="x" data-rm="${grp}:${i}">✕</i></span>`).join("")
      : (grp === "B" ? `<span class="dehint">all other cells — everything not in A</span>` : `<span class="dehint">add a group…</span>`);

    const render = () => {
      const aIds = sideCS(A) ? this.resolveCells(sideCS(A)!).ids : null;
      const bExpl = sideCS(B) ? this.resolveCells(sideCS(B)!).ids : null;
      let overlap = 0; if (aIds && bExpl) { const bs = new Set<number>(Array.from(bExpl as any)); for (const i of aIds as any) if (bs.has(i)) overlap++; }
      const aN = aIds ? aIds.length : 0, bRest = !bExpl && !!aIds, bN = bExpl ? bExpl.length : (aIds ? ctx.n - aN : 0), pb = method === "pseudobulk";
      // Flag ONLY an actual A∩B overlap, and say what it is; stay silent when there's nothing to exclude.
      const note = overlap ? `⚠ <b>${fmt(overlap)}</b> cell${overlap === 1 ? "" : "s"} match a member of BOTH A and B — excluded from both sides so the contrast stays clean.` : "";
      card.innerHTML =
        `<div class="dehd"><b>Differential expression</b><span class="dex">✕</span></div>` +
        `<div class="delab a">Group A</div><div class="degrp${A.length ? "" : " empty"}" data-box="A">${chips(A, "A")}</div>` +
        `<div class="delab b">Group B</div><div class="degrp${B.length ? "" : " empty"}" data-box="B">${chips(B, "B")}</div>` +
        `<div class="derow">add <select class="deadd" style="flex:1;min-width:0">${addOptions()}</select> to <button class="detgt mini${target === "A" ? " ona" : ""}" data-t="A">A</button><button class="detgt mini${target === "B" ? " onb" : ""}" data-t="B">B</button></div>` +
        `<div class="derow" style="border-top:1px solid var(--line2);padding-top:9px">test <select class="demethod"><option value="de"${pb ? "" : " selected"}>cell-level (ranking)</option><option value="pseudobulk"${pb ? " selected" : ""}>pseudobulk (paired)</option></select>${pb ? ` across <select class="derep">${ctx.categoricalFields().map((f) => `<option value="${esc(f)}"${f === replicate ? " selected" : ""}>${esc(f)}</option>`).join("")}</select>` : ""}</div>` +
        `<div class="deread"><span class="ca">A:</span> ${fmt(Math.max(0, aN - overlap))} cells &nbsp;vs&nbsp; <span class="cb">B:</span> ${bRest ? "rest · " + fmt(bN) : fmt(Math.max(0, bN - overlap)) + " cells"}</div>` +
        (note ? `<div class="denote">${note}</div>` : "") +
        `<div class="defoot"><span style="font-size:11px;color:var(--faint);margin-right:auto">${pb ? "paired t across " + esc(replicate) + " → real p-value" : "ranking-grade · no p-value"}</span><button class="mini derun"${A.length ? "" : " disabled"}>Run DE</button></div>`;
      (card.querySelector(".dex") as HTMLElement).onclick = close;
      (card.querySelector(".deadd") as HTMLSelectElement).onchange = (e) => { const v = (e.target as HTMLSelectElement).value; if (!v) return; const s = items[+v]; (target === "A" ? A : B).push(s.kind === "category" ? { kind: "category", grouping: s.grouping, value: s.value } : { kind: "cells", ids: s.ids.slice(), label: s.label }); render(); };
      card.querySelectorAll<HTMLElement>(".detgt").forEach((b) => b.onclick = () => { target = b.dataset.t as any; render(); });
      (card.querySelector(".demethod") as HTMLSelectElement).onchange = (e) => { method = (e.target as HTMLSelectElement).value as any; render(); };
      const rep = card.querySelector(".derep") as HTMLSelectElement | null; if (rep) rep.onchange = () => { replicate = rep.value; render(); };
      card.querySelectorAll<HTMLElement>(".x").forEach((x) => x.onclick = () => { const p = x.dataset.rm!.split(":"); (p[0] === "A" ? A : B).splice(+p[1], 1); render(); });
      card.querySelectorAll<HTMLElement>(".dechip").forEach((c) => { c.ondragstart = () => { dragRef = { m: (c.dataset.g === "A" ? A : B)[+c.dataset.i!], from: c.dataset.g as any }; }; c.ondragend = () => { dragRef = null; }; });
      card.querySelectorAll<HTMLElement>(".degrp").forEach((box) => {
        box.ondragover = (e) => { e.preventDefault(); box.classList.add("drop"); };
        box.ondragleave = () => box.classList.remove("drop");
        box.ondrop = (e) => { e.preventDefault(); box.classList.remove("drop"); const to = box.dataset.box as "A" | "B"; if (!dragRef || dragRef.from === to) return; const src = dragRef.from === "A" ? A : B, idx = src.indexOf(dragRef.m); if (idx >= 0) src.splice(idx, 1); (to === "A" ? A : B).push(dragRef.m); dragRef = null; render(); };
      });
      (card.querySelector(".derun") as HTMLButtonElement).onclick = async () => {
        const aCS = sideCS(A); if (!aCS) return; close();
        this.toast(`computing ${method === "pseudobulk" ? "paired pseudobulk" : "cell-level"} DE…`, null);
        const r = await this.runCompute({ stat: method, A: aCS, B: sideCS(B) || undefined, replicate: method === "pseudobulk" ? replicate : undefined, paired: method === "pseudobulk" ? true : undefined, toCanvas: true, source: "user" });
        if (r.error) this.toast(`DE failed: ${r.error}`, null);
      };
    };
    render();
  }
  // selection → "Save selection…": name a VALUE and choose the target CATEGORY — the working draft, another editable
  // category you made, or a brand-new one. Writes via labelCells into ANY annotation layer (auto-creates it), then
  // colours by it. The free-form manual capture path that complements the agent + reconcile. A content-only re-render
  // of the OPEN popover — the dismiss listener stays armed and the position is unchanged (a sub-view, not a re-open).
  selpopLabelInput(ids: number[]) {
    const sp = this.$("selpop");
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
    // Save targets CUSTOM Metadata categories only — the cell-type annotation draft (layer "annotation") is the
    // Annotate panel's domain, NOT a save target here. Default to the last category you saved into, else the first
    // existing custom category, else new-category mode.
    const customCats = this.ctx.annotationLayers().filter((n) => n !== "annotation");
    const def = this.lastSaveCategory && customCats.includes(this.lastSaveCategory) ? this.lastSaveCategory : (customCats[0] || "__new__");
    const startNew = def === "__new__";
    const opts = customCats.map((n) => `<option value="${esc(n)}"${n === def ? " selected" : ""}>${esc(n)}</option>`)
      .concat([`<option value="__new__"${startNew ? " selected" : ""}>＋ new category…</option>`]);
    sp.innerHTML =
      `<div class="head">save ${ids.length} cells</div>` +
      `<input id="splabel" placeholder="value name (e.g. ‘activated’)…" style="width:90%;margin:5px 6px 3px;font-size:12px">` +
      `<div style="display:flex;align-items:center;gap:5px;margin:0 6px 4px"><span style="font-size:10px;color:var(--faint)">in</span><select id="spcat" style="flex:1;font-size:11px">${opts.join("")}</select></div>` +
      `<input id="spnewcat" placeholder="new category name…" style="display:${startNew ? "block" : "none"};width:90%;margin:0 6px 5px;font-size:12px">` +
      `<div class="it" data-a="apply"><span class="ic">✓</span>save</div>`;
    const val = sp.querySelector<HTMLInputElement>("#splabel")!;
    const cat = sp.querySelector<HTMLSelectElement>("#spcat")!;
    const newcat = sp.querySelector<HTMLInputElement>("#spnewcat")!;
    val.focus();
    cat.onchange = () => { const isNew = cat.value === "__new__"; newcat.style.display = isNew ? "block" : "none"; if (isNew) newcat.focus(); };
    const apply = () => {
      const value = val.value.trim(); if (!value) { val.focus(); return; }
      const target = cat.value === "__new__" ? newcat.value.trim() : cat.value;
      if (!target) { newcat.focus(); return; }
      if (cat.value === "__new__" && this.ctx.groupings().includes(target) && !this.annoLayers.has(target)) { this.toast(`“${target}” is an existing stored field — pick another name`, null); return; }
      const idsArr = Int32Array.from(ids), n = ids.length;
      this.hideSelpop();
      // Defer the commit + recolor (a full re-render) OFF this input's keydown handler — running a synchronous
      // fullRender inside event dispatch is the classic re-entrant-render hazard; let the key event unwind first.
      setTimeout(() => {
        this.labelCells(idsArr, value, target);
        this.noteColor("meta:" + target); this.coord.setColor("meta:" + target);   // make the just-saved value visible
        this.coord.setSelection(null); this.scope = null; this.lastSaveCategory = target;
        this.toast(`saved ${n} cells as “${value}” in category “${target}”`, "A custom category — colour, facet, DE, or edit it (✎) in the Metadata panel.");
      }, 0);
    };
    val.onkeydown = (e) => { if (e.key === "Enter") apply(); else if (e.key === "Escape") this.hideSelpop(); };
    newcat.onkeydown = (e) => { if (e.key === "Enter") apply(); else if (e.key === "Escape") this.hideSelpop(); };
    sp.querySelector<HTMLElement>('[data-a="apply"]')!.onclick = apply;
  }
  // Reveal the popover at lastSelAnchor and ARM its outside-dismiss listener (idempotent — content re-renders reuse it).
  // Dismissal is OUTSIDE pointerdown (capture phase): it fires before any content swap and ignores the lasso's trailing
  // click, so the menu → label-input transition (and future pickers) can never dismiss themselves.
  private showSelpop() {
    const sp = this.$("selpop");
    sp.classList.add("show");
    // position with the menu's REAL width: a `right` anchor (a right-aligned trigger like the facet "actions" button)
    // aligns the menu's right edge to it so it stays inside the panel; else open to the right of the anchor. Clamp.
    const a = this.lastSelAnchor || { left: 8, top: 8 }; const wpx = sp.offsetWidth || 210;
    const left = a.right != null ? a.right - wpx : a.left + 8;
    sp.style.left = Math.max(8, Math.min(left, innerWidth - wpx - 8)) + "px"; sp.style.top = a.top + "px";
    if (!this.selpopOutside) {
      this.selpopOutside = (e: Event) => { if (!this.$("selpop").contains(e.target as Node)) this.hideSelpop(); };
      document.addEventListener("pointerdown", this.selpopOutside, true);
    }
  }
  hideSelpop() {
    this.$("selpop").classList.remove("show");
    if (this.selpopOutside) { document.removeEventListener("pointerdown", this.selpopOutside, true); this.selpopOutside = undefined; }
  }

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
    // L3 SUBSET is a PROMINENT banner (vs the mild select chip) — the rest of the data is removed from every view, so it
    // must be unmistakable + offer the way back. Inline-styled with the accent so it stands out in the top bar.
    el.style.cssText = "display:inline-flex;align-items:center;gap:9px;font-size:12px;font-weight:600;color:var(--panel);background:var(--cyan);border-radius:12px;padding:3px 12px;box-shadow:0 1px 5px rgba(0,0,0,.35)";
    el.innerHTML = `<span>⊙ subset: <b>${lbl}</b> · ${f.ids.length.toLocaleString()} cells — other cells hidden from all views</span> <span class="x" id="focusX" title="exit the subset — show all cells" style="cursor:pointer;text-decoration:underline">Back to full</span>`;
    (this.$("focusX")).onclick = () => this.releaseFocus();
  }
  // Level-2 SELECT notice — a MILD status chip (lighter than the focus pill) so the user knows the views are reacting to
  // a sticky selection + can clear it. The embedding now dims the rest for a selection, so this is the "what's selected".
  renderSelChip() {
    const el = this.$("selchip"); const sel = this.coord.state.selection as any;
    const n = sel ? this.ctx.refToCells(sel).length : 0;
    if (!sel || !n) { el.style.display = "none"; return; }
    const esc = (s: string) => String(s).replace(/[<&]/g, (c) => c === "<" ? "&lt;" : "&amp;");
    el.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dim);background:var(--inset);border:1px solid var(--line);border-radius:11px;padding:2px 9px";
    const head = sel.kind === "category" ? `selected <b style="color:var(--text)">${esc(sel.value)}</b> · ${n.toLocaleString()} cells` : `<b style="color:var(--text)">${n.toLocaleString()} cells</b> selected`;
    el.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:var(--cyan);opacity:.8"></span>${head} <span class="x" id="selX" title="clear the selection" style="cursor:pointer;opacity:.7">clear ✕</span>`;
    (this.$("selX")).onclick = () => { this.coord.setSelection(null); this.repaint(); this.renderSelChip(); };
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
    // ctx + account menus dismiss on document click; the selection popover owns its OWN outside-dismiss listener
    // (pointerdown-based, in showSelpop/hideSelpop) so it isn't entangled here.
    document.addEventListener("click", (e) => { if (!this.$("ctx").contains(e.target as Node)) this.$("ctx").classList.remove("show"); const ac = this.$("acct"); if (!ac.contains(e.target as Node) && (e.target as HTMLElement).id !== "acctBtn" && !this.$("acctBtn").contains(e.target as Node)) ac.classList.remove("show"); });
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
