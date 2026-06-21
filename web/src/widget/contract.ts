// The UI escape hatch — the analog of codeapi.ts for *interactive widgets*. A widget is author-written code that
// runs in a SANDBOXED iframe and talks to the app only through a typed postMessage protocol (this file). The host
// owns the panel chrome (header / ⋯ menu / theme); the iframe renders only the body. The widget reads the
// coordination space and calls back into it — never touches app state directly.
//
// Pure-loadable (no DOM at import time — the bootstrap is a string, like WORKER_SRC), so node --test can unit-test
// the protocol + manifest validation. The DOM side lives in runtime.ts.

export interface ThemeInfo { dark: boolean; vars: Record<string, string>; }   // CSS custom-property snapshot
// Selection is a lightweight DESCRIPTOR — never the (potentially 100k-long) cell-id array, which would be costly to
// postMessage on every change. A widget that needs the actual ids pulls them on demand via data('selectedCells').
export type SelectionInfo =
  | null
  | { kind: "cells"; count: number }
  | { kind: "category"; grouping: string; value: string; count: number };
export interface CoordInfo { colorBy: string; selection: SelectionInfo; focus: { label: string } | null; }
// The ephemeral HOVER tier (the hint), delivered on its OWN channel (pagoda.on('hint')) — separate from coord so
// hover churn never re-fires coord handlers. Hints are small (a hovered cell, or a category), so they carry content.
export type HintInfo = null | { kind: "cells"; ids: number[] } | { kind: "category"; grouping: string; value: string };

// A typed PARAMETER a widget declares — a VALUE knob (vs a control, which is an action button). The host renders it as
// a header input AND exposes it to describe_panel/update_view, so the agent + user drive it uniformly with built-in
// style knobs (the strong-C completion). A change arrives as a {t:"param"} message; the widget reacts via on('param').
export interface WidgetParam { id: string; label: string; type: "number" | "select" | "bool" | "color" | "text"; value: any; min?: number; max?: number; step?: number; options?: string[]; }

// A module's declared PERMISSIONS — the capabilities it intends to use, declared up front so an IMPORTED widget can be
// trusted by INSPECTION (the consent gate shows them) and (future) ENFORCED (the host narrows fetchExternal to the
// declared hosts). external = the biodata hosts it fetches from (a subset of the global allowlist); compute = it runs
// off-thread runCompute. Captured when the author runs the widget + persisted, so they're known at gate time (pre-run).
export interface WidgetPermissions { external?: string[]; compute?: boolean; }

// A widget's self-declared metadata. controls become standard header buttons the HOST renders (uniform ⋯/toolbar
// policy); a click comes back as a {t:"control"} message. params become header INPUTS + describe_panel knobs. height
// lets a widget request its natural body height. version/description/permissions make it an installable MODULE (P4).
export interface WidgetManifest { title?: string; height?: number; controls?: { id: string; label: string }[]; params?: WidgetParam[]; version?: string; description?: string; permissions?: WidgetPermissions; }

// host → widget
export type HostMsg =
  | { t: "init"; theme: ThemeInfo; coord: CoordInfo; hint: HintInfo }
  | { t: "coord"; coord: CoordInfo }
  | { t: "hint"; hint: HintInfo }                                 // cross-panel hover changed (ephemeral)
  | { t: "theme"; theme: ThemeInfo }
  | { t: "control"; id: string }                                  // a host-rendered header control was clicked
  | { t: "param"; id: string; value: any }                        // a host-rendered/agent-set parameter changed
  | { t: "data"; reqId: number; ok: boolean; payload?: any; error?: string }   // reply to a requestData
  | { t: "extData"; reqId: number; ok: boolean; payload?: any; error?: string }   // reply to a fetchExternal
  | { t: "libResult"; reqId: number; ok: boolean; source?: string; error?: string }   // reply to a loadLib (the pinned library JS source)
  | { t: "computeResult"; reqId: number; ok: boolean; payload?: any; error?: string }   // reply to a runCompute (the worker's free-form result)
  | { t: "snapshot" };                                            // ask the widget to report its rendered text (preview feedback)

// widget → host
export type WidgetMsg =
  | { t: "ready"; manifest: WidgetManifest }
  | { t: "setSelection"; sel: { cells?: number[]; category?: { grouping: string; value: string } | null } | null }
  | { t: "setColor"; handle: string }
  | { t: "setHint"; hint: any }
  | { t: "updateView"; patch: any }
  | { t: "requestData"; reqId: number; kind: string; args?: any }
  | { t: "fetchExternal"; reqId: number; url: string; as?: string }   // host-mediated, allowlisted external data fetch
  | { t: "loadLib"; reqId: number; name: string }                 // request an allowlisted, host-pinned library
  | { t: "requestCompute"; reqId: number; code: string; opts?: any }   // run author compute code in the host's terminable worker (render/compute split)
  | { t: "resize"; height: number }
  | { t: "snapshotResult"; text: string }
  | { t: "log"; level: string; args: string[] }
  | { t: "error"; message: string; stack?: string };

export function validateManifest(m: any): WidgetManifest {
  const out: WidgetManifest = {};
  if (m && typeof m === "object") {
    if (typeof m.title === "string") out.title = m.title;
    if (typeof m.height === "number" && m.height > 0) out.height = Math.min(2000, m.height);
    if (Array.isArray(m.controls)) out.controls = m.controls.filter((c: any) => c && typeof c.id === "string" && typeof c.label === "string").map((c: any) => ({ id: c.id, label: c.label }));
    if (Array.isArray(m.params)) out.params = m.params.filter((p: any) => p && typeof p.id === "string" && typeof p.label === "string" && ["number", "select", "bool", "color", "text"].includes(p.type)).map((p: any) => {
      const o: WidgetParam = { id: p.id, label: p.label, type: p.type, value: p.value };
      if (typeof p.min === "number") o.min = p.min; if (typeof p.max === "number") o.max = p.max; if (typeof p.step === "number") o.step = p.step;
      if (Array.isArray(p.options)) o.options = p.options.map((x: any) => String(x));
      return o;
    });
    if (typeof m.version === "string") out.version = m.version.slice(0, 40);
    if (typeof m.description === "string") out.description = m.description.slice(0, 400);
    if (m.permissions && typeof m.permissions === "object") {
      const perm: WidgetPermissions = {};
      if (Array.isArray(m.permissions.external)) perm.external = m.permissions.external.filter((h: any) => typeof h === "string" && h.trim()).map((h: any) => h.trim().toLowerCase());
      if (m.permissions.compute === true) perm.compute = true;
      if (perm.external?.length || perm.compute) out.permissions = perm;
    }
  }
  return out;
}

// REFLECTION checks — heuristic well-formedness lint on an authored widget, run by inspect_widget so the agent can
// review what it built and FIX gaps before declaring done. Source-string + manifest based (the host has both); advisory,
// not errors. The big one: a tunable VALUE built as an internal DOM control instead of a declared param (undriveable,
// not persisted) — the slider-N class. Pure → node-testable.
export function widgetLint(source: string, manifest: WidgetManifest | null): string[] {
  const s = String(source || ""), m = manifest || {};
  const params = m.params || [], controls = m.controls || [];
  const w: string[] = [];
  // 1) a tunable knob (slider / number input / dropdown) built in the widget's OWN DOM rather than declared as a param.
  const buildsKnob = /type\s*=\s*['"]?(range|number)\b/i.test(s) || /setAttribute\(\s*['"]type['"]\s*,\s*['"](range|number)/i.test(s) || /<select\b/i.test(s) || /createElement\(\s*['"]select['"]/i.test(s);
  if (buildsKnob && !params.length) w.push("builds a slider / number-input / <select> in its own DOM but declares NO params — an internal control can't be set by the agent or by voice and isn't persisted across reload. Declare each tunable VALUE as a param (ready({params:[{id,type:'number'|'select',…}]})) and react via on('param'); seed the first render from the param's value.");
  // 2) declared params/controls that are never wired up → a dead knob/button.
  if (params.length && !/on\(\s*['"]param['"]/.test(s)) w.push("declares params but never calls on('param', …) — setting one will do nothing. Subscribe and re-render on change.");
  if (controls.length && !/on\(\s*['"]control['"]/.test(s)) w.push("declares controls but never calls on('control', …) — clicking the header button will do nothing.");
  // 3) capability used but not declared → declaration out of sync with the code (shown at ⓘ inspector / import gate).
  if (/fetchExternal\s*\(/.test(s) && !(m.permissions?.external?.length)) w.push("calls fetchExternal but declares no permissions.external — add the host(s) you fetch so it's documented (and allowed when the widget is imported).");
  if (/runCompute\s*\(/.test(s) && !(m.permissions?.compute)) w.push("calls runCompute but didn't declare permissions.compute:true.");
  return w;
}

// The data kinds a widget may request (host resolves them). Documented so the agent + the host stay in step.
export const DATA_KINDS = ["n", "fields", "categories", "category", "cellsOf", "expr", "numeric", "selectedCells", "groupStats", "rankGenes", "compute"] as const;

// Agent-facing reference — what the widget code can do. Kept next to the protocol so they can't drift (mirrors
// codeapi.CODE_API_DOC). Surfaced via the read_widget_contract tool + injected into the authoring prompt.
export const WIDGET_API_DOC =
  "A widget is plain HTML/JS that runs in a sandboxed iframe and talks to the app through the `pagoda` global. " +
  "Draw into document.body; call pagoda.ready({title, controls?, height?}) once you've set up. THEME: never hardcode " +
  "colours — use the injected CSS variables (var(--text), --dim, --faint, --panel, --inset, --line, --cyan, --amber, " +
  "--bad, --good, --sans, --mono); they flip with the app theme automatically. API: " +
  "`pagoda.coord` (current {colorBy, selection, focus}); selection is a small descriptor — null, {kind:'cells',count} or " +
  "{kind:'category',grouping,value,count} — NOT the cell ids (pull those with data('selectedCells') when you need them); " +
  "`pagoda.theme` ({dark, vars}); " +
  "`pagoda.on('coord'|'hint'|'theme'|'control'|'param', cb)` → subscribe (returns an unsubscribe fn). HOVER/CLICK like a native " +
  "panel: EMIT hover with pagoda.setHint({cells:[i]}|{category:{grouping,value}}|null) and clicks with " +
  "pagoda.setSelection(...); REACT to cross-panel hover via pagoda.on('hint', h => …) where h is null|{kind:'cells',ids}|" +
  "{kind:'category',grouping,value} (`pagoda.hint` is the current one) — the ephemeral hover tier, separate from coord; " +
  "react to clicks/selection via pagoda.on('coord', c => c.selection). " +
  "`pagoda.setSelection({cells:[...]}|{category:{grouping,value}}|null)`, `pagoda.setColor('gene:CD3E'|'meta:cell_type'|'qc:mito')`, " +
  "`pagoda.setHint(ref)`, `pagoda.updateView(patch)` (same patch shape as the update_view tool); " +
  "`await pagoda.data(kind, args)` to pull data on demand — kinds: " +
  "'n' (cell count), 'fields' (→ {categorical:[names], numeric:[names]}), 'categories' (args:{field} → {categories,counts}), 'category' (args:{field} → {codes,categories}), " +
  "'cellsOf' (args:{field,value} → number[]), 'expr' (args:{gene} → Float32Array of log-norm expression), " +
  "'numeric' (args:{field} → {values,min,max}), 'selectedCells' (→ number[] of the currently selected cell indices), " +
  "'groupStats' (args:{field, genes:[...]} → {groups, genes, mean:[gene][group], frac:[gene][group]}) — per-group MEAN expression + " +
  "FRACTION expressing for each gene in one call; use it for dot-plots/heatmaps/violins instead of looping raw expr. " +
  "'rankGenes' (args:{cells?:[...]|field+value?, n?=20, dir?:'up'|'down'|'abs'} → {genes:[{symbol,lfc,meanA,meanB}], nA}) — the TOP MARKER genes for a CELL SET vs the rest, " +
  "computed app-side in ONE call (whole transcriptome, subsampled → fast). Use this for 'top/marker genes for the selection' — do NOT loop expr over a hand-picked gene list (slow, and raw-mean ranking just surfaces housekeeping genes). Omit cells to rank the CURRENT selection. " +
  "`await pagoda.compute(name, args)` (the 'compute' data kind) runs a KERNEL-BACKED analytic primitive — the SAME analyses you can run as `compute` tools, now available INSIDE a widget. Names: 'overdispersion' (variable / most-variable / HVG genes for a cell set → {genes:[{symbol,score}]}), 'de' (A-vs-B differential expression → {genes:[{symbol,lfc,meanA,meanB}]}), 'markers' (a cell set vs the rest), 'groupStats' (per-group mean + %expressing). Each takes a cell set as {cells:[…]} | {field,value} | omit → the current selection (de takes {A, B}). PREFER pagoda.compute over hand-rolling statistics from raw expr — it's the kernel, genome-wide, in one call, faster AND more correct. (The agent tool `list_widget_capabilities` lists every primitive's params + an example.) " +
  "`await pagoda.fetchExternal(url, {as:'json'|'text'})` pulls EXTERNAL biodata through the host (server-side, so no " +
  "CORS) from an ALLOWLIST — PDB/RCSB, UniProt, Ensembl, NCBI, AlphaFold, STRING, Reactome (e.g. " +
  "data.rcsb.org/rest/v1/core/entry/4HHB, rest.uniprot.org, rest.ensembl.org). NEVER call fetch()/XHR or load a CDN " +
  "directly — the iframe is sandboxed; route every network request through pagoda.fetchExternal (data) or the data() kinds. " +
  "`await pagoda.loadLib(name)` loads an ALLOWLISTED, host-pinned JS LIBRARY at runtime (the host injects it; you never " +
  "touch a CDN) — for capabilities the snippets don't cover, e.g. a 3D viewer or a heavy chart lib. Available: '3dmol' " +
  "(then use the $3Dmol global — molecular structures) and 'd3' (the d3 global); after it resolves the global is ready. " +
  "`await pagoda.runCompute(code, {genes?, grouping?, args?, timeoutMs?})` is the RENDER/COMPUTE SPLIT — when neither " +
  "pagoda.compute (the fixed kernels) nor a few data() calls fit, run your OWN heavy computation OFF the main thread in a " +
  "host-spawned, TERMINABLE worker next to the data (so the UI never freezes and a runaway loop is killed). `code` is the " +
  "BODY of an async function that receives `api` and RETURNS any JSON value (your widget renders it): api.n (cell count); " +
  "api.expr(sym) → Float32Array log-expr (only for genes you DECLARE in `genes`); api.cat(field) → {codes,categories}; " +
  "api.catOf(field,i); api.numeric(field) → Float32Array of a NUMERIC field per cell (QC: mito/n_umi/n_gene, …; api.numericFields lists them); " +
  "api.embedding (Float32Array, x,y per cell); api.stats (if you pass `grouping`); api.args (your `args`). " +
  "The KERNELS are available INSIDE the worker too (over ALL genes, no declaration needed): api.de(A, B, {topN?, genes?}) → " +
  "[{symbol, lfc, meanA, meanB}] (A,B are cell-index arrays); api.overdispersion(cells, {topN?, genes?}) → [{symbol, score, mean}]; " +
  "and await api.meanVar({cells?, genes?}) → [{symbol, mean, var, nnz}] per gene — genome-wide over ALL cells via the native " +
  "libstar WASM kernel when `cells` is omitted (use it for a mean-variance / HVG plot: log(mean) vs log(var)), or over a cell " +
  "SUBSET when you pass `cells`. SUBSETTING: every kernel takes optional `genes` (a symbol list to restrict the result to) and " +
  "scopes CELLS via its natural arg (de's A/B, overdispersion's & meanVar's cells). These run OFF the main thread — " +
  "so you can FUSE a kernel with your own post-processing in one off-thread call (e.g. DE for many sub-clusters, then build " +
  "a network). Use runCompute for the long tail the primitives don't cover — co-expression/correlation networks, signature " +
  "scoring, custom clustering — over MANY genes at once (declare them; the raw vectors stay in the worker, only your small result returns). " +
  "Example: pagoda.runCompute(\"const gs=api.genesAvailable, M=gs.map(g=>api.expr(g)); /*…correlate…*/ return {genes:gs, corr};\", {genes:['CD3D','CD8A','NKG7','MS4A1']}). " +
  "Errors/console are forwarded to the host for debugging; an uncaught " +
  "throw shows an error state. Header `controls` you declare are rendered by the host in the standard panel chrome; " +
  "a click arrives as pagoda.on('control', id => …). Declare typed PARAMS (value knobs) in ready({params:[{id, label, " +
  "type:'number'|'select'|'bool'|'color'|'text', value, min?, max?, step?, options?}]}) — the host renders them as header " +
  "inputs AND exposes them to the agent (describe_panel shows each param's current value/range; update_view sets them); " +
  "react to a change via pagoda.on('param', (id, value) => …), and SEED the first render from the param's initial value " +
  "(don't hardcode a separate default). Use controls for ACTIONS, params for VALUES. CRITICAL: ANY value a user might " +
  "tune — a top-N, a threshold, a cutoff, a mode — MUST be a declared PARAM. Do NOT build an internal <input>/<select>/" +
  "range slider in your widget DOM for it: an internal control is invisible outside the iframe — the agent can't read or " +
  "set it (describe_panel/update_view only know DECLARED params), the user can't drive it by voice, and it isn't " +
  "persisted across reload. Declaring it as a param makes the SAME knob settable by the header input, by you (the agent), " +
  "and saved with the session. (e.g. a 'top N markers' widget: declare params:[{id:'n',type:'number',value:10,min:1,max:50}], NOT an <input type=range>.) " +
  "Declare in ready(): version, description, and permissions:{external:['uniprot.org', …] (EVERY biodata host you " +
  "fetchExternal from — list a host BEFORE you fetch it, and when you add a fetch, add its host), compute:true (if you " +
  "use runCompute)}. Permissions are DOCUMENTATION of what the widget touches — shown in the ⓘ inspector and at the " +
  "import consent gate so someone running it can trust it by inspection; keep them in sync with the code as you edit. " +
  "(They're only ENFORCED for an imported widget — held to what it declared; a widget authored here is never blocked by " +
  "its own declaration.) The declaration is AMENDABLE: if the user asks to give a widget access to a new host (even an " +
  "imported one), the user's request IS the approval — ADD the host to permissions.external and wire the fetch, then say " +
  "you did. Never refuse a user-requested capability change as 'blocked by permissions'; the binding only stops SILENT " +
  "reach beyond what was agreed, not changes the user explicitly asks for. Keep it self-contained — no external network/CDN.";

// Escape a source string so it can't break out of the <script> it's injected into.
export function escapeForScript(src: string): string { return String(src).replace(/<\/(script)/gi, "<\\/$1"); }

// Base stylesheet every widget gets — themed via the injected vars, transparent bg so the panel shows through,
// and pre-styled form controls so authored widgets look native without each widget restyling them.
export const WIDGET_BASE_CSS = `
*{box-sizing:border-box} html,body{margin:0;height:100%;font-family:var(--sans,-apple-system,system-ui,sans-serif);font-size:12px;color:var(--text,#223);background:transparent}
body{padding:10px}
button{font:inherit;font-size:11px;color:var(--dim,#667);background:var(--inset,#eee);border:1px solid var(--line,#ccc);border-radius:6px;padding:3px 9px;cursor:pointer}
button:hover{color:var(--cyan,#1f7faf);border-color:var(--cyan,#1f7faf)}
input,select{font:inherit;font-size:11px;color:var(--text,#223);background:var(--inset,#eee);border:1px solid var(--line,#ccc);border-radius:6px;padding:3px 7px;outline:none}
input[type=range]{padding:0;accent-color:var(--cyan,#1f7faf);background:transparent;border:0}
label{font-size:11px;color:var(--dim,#667);display:flex;align-items:center;gap:6px}
a{color:var(--cyan,#1f7faf)}
.pg-row{display:flex;align-items:center;gap:8px;margin:4px 0}
.pg-muted{color:var(--faint,#9aa)}
`;

// The bootstrap injected into every widget iframe (before the author source). Defines window.pagoda over
// postMessage, applies theme vars, forwards console/errors, auto-resizes. A string (no app import).
export const WIDGET_BOOTSTRAP = `
(function(){
  var pending={}, reqId=0, coord=null, theme=null, hint=null, loadedLibs={}, listeners={coord:[],theme:[],control:[],hint:[],param:[]}, parentWin=window.parent;
  function post(m){ try{ parentWin.postMessage(m,'*'); }catch(e){} }
  // serialize a console arg so it's USEFUL to the agent: an Error JSON.stringifies to "{}" (message/stack are
  // non-enumerable), so pull them out explicitly; for other objects that stringify to "{}" fall back to String(x).
  function ser(x){ if(x instanceof Error){ return (x.name||'Error')+': '+(x.message||String(x))+(x.stack?(' | '+String(x.stack).split('\\n').slice(0,3).join(' / ')):''); } if(typeof x==='string') return x; if(x==null) return String(x); try{ var s=JSON.stringify(x); return (s===undefined||s==='{}')?String(x):s; }catch(e){ return String(x); } }
  function fire(ev){ var args=[].slice.call(arguments,1); (listeners[ev]||[]).forEach(function(f){ try{ f.apply(null,args); }catch(err){ reportError(err); } }); }
  function reportError(err){ post({t:'error', message:String(err&&err.message?err.message:err), stack: err&&err.stack ? String(err.stack) : undefined }); }
  function applyTheme(t){ if(!t) return; var s=document.getElementById('pg-theme'); if(!s){ s=document.createElement('style'); s.id='pg-theme'; document.head.appendChild(s); } var v=t.vars||{}; s.textContent=':root{'+Object.keys(v).map(function(k){return k+':'+v[k];}).join(';')+'}'; document.documentElement.setAttribute('data-theme', t.dark?'dark':'light'); }
  window.addEventListener('message', function(e){ var m=e.data; if(!m||!m.t) return;
    if(m.t==='init'){ coord=m.coord; theme=m.theme; hint=m.hint||null; applyTheme(theme); fire('theme',theme); fire('coord',coord); if(hint) fire('hint',hint); }
    else if(m.t==='coord'){ coord=m.coord; fire('coord',coord); }
    else if(m.t==='hint'){ hint=m.hint||null; fire('hint',hint); }
    else if(m.t==='theme'){ theme=m.theme; applyTheme(theme); fire('theme',theme); }
    else if(m.t==='control'){ fire('control', m.id); }
    else if(m.t==='param'){ fire('param', m.id, m.value); }
    else if(m.t==='snapshot'){
      // text alone is blind to SVG/canvas charts (no innerText) — so also summarize the VISUAL content (element counts +
      // sizes) so a preview can tell whether a chart actually drew, without the author writing a DOM-counting probe.
      var viz=[];
      var svgs=document.querySelectorAll('svg'); for(var i=0;i<svgs.length;i++){ var s=svgs[i], r=s.getBoundingClientRect();
        var parts=['circle','rect','path','line','text'].map(function(t){ var n=s.querySelectorAll(t).length; return n? n+' '+t : null; }).filter(Boolean);
        viz.push('svg '+Math.round(r.width)+'x'+Math.round(r.height)+(parts.length? ' ('+parts.join(', ')+')' : ' (empty)')); }
      var cans=document.querySelectorAll('canvas'); for(var j=0;j<cans.length;j++){ var cr=cans[j].getBoundingClientRect(); viz.push('canvas '+Math.round(cr.width)+'x'+Math.round(cr.height)); }
      var txt=(document.body.innerText||'').replace(/\\s+/g,' ').trim();
      post({t:'snapshotResult', text:((viz.length? '[viz: '+viz.join(' · ')+']\\n' : '')+txt).slice(0,3000)});
    }
    else if(m.t==='data'){ var p=pending[m.reqId]; if(p){ delete pending[m.reqId]; m.ok ? p.resolve(m.payload) : p.reject(new Error(m.error||'data error')); } }
    else if(m.t==='extData'){ var pe=pending[m.reqId]; if(pe){ delete pending[m.reqId]; m.ok ? pe.resolve(m.payload) : pe.reject(new Error(m.error||'external fetch error')); } }
    else if(m.t==='libResult'){ var pl=pending[m.reqId]; if(pl){ delete pending[m.reqId]; if(m.ok){ try{ var sc=document.createElement('script'); sc.textContent=m.source; document.head.appendChild(sc); pl.resolve(true); }catch(le){ pl.reject(le); } } else pl.reject(new Error(m.error||'loadLib error')); } }
    else if(m.t==='computeResult'){ var pc=pending[m.reqId]; if(pc){ delete pending[m.reqId]; m.ok ? pc.resolve(m.payload) : pc.reject(new Error(m.error||'runCompute error')); } }
  });
  ['log','warn','error'].forEach(function(lv){ var orig=console[lv]; console[lv]=function(){ try{ post({t:'log', level:lv, args:[].map.call(arguments, ser)}); }catch(e){} try{ orig.apply(console, arguments); }catch(e){} }; });
  window.onerror=function(msg,src,ln,col,err){ reportError(err||msg); return false; };
  window.addEventListener('unhandledrejection', function(e){ reportError(e.reason||'unhandled rejection'); });
  var ro=null;
  function startResize(){ if(ro) return; var send=function(){ post({t:'resize', height: Math.ceil(document.body.scrollHeight)}); }; ro=new ResizeObserver(send); ro.observe(document.body); send(); }
  window.pagoda={
    get coord(){ return coord; }, get theme(){ return theme; }, get hint(){ return hint; },
    on:function(ev,cb){ (listeners[ev]=listeners[ev]||[]).push(cb); return function(){ var a=listeners[ev]||[]; var i=a.indexOf(cb); if(i>=0) a.splice(i,1); }; },
    ready:function(m){ post({t:'ready', manifest:m||{}}); startResize(); },
    setSelection:function(sel){ post({t:'setSelection', sel: sel||null}); },
    setColor:function(h){ post({t:'setColor', handle: String(h)}); },
    setHint:function(h){ post({t:'setHint', hint: h||null}); },
    updateView:function(p){ post({t:'updateView', patch: p||{}}); },
    data:function(kind,args){ var id=++reqId; return new Promise(function(res,rej){ pending[id]={resolve:res,reject:rej}; post({t:'requestData', reqId:id, kind:String(kind), args:args||{}}); }); },
    compute:function(name,args){ var a={name:String(name)}; if(args&&typeof args==='object'){ for(var k in args){ a[k]=args[k]; } } var id=++reqId; return new Promise(function(res,rej){ pending[id]={resolve:res,reject:rej}; post({t:'requestData', reqId:id, kind:'compute', args:a}); }); },
    fetchExternal:function(url,opts){ var id=++reqId; return new Promise(function(res,rej){ pending[id]={resolve:res,reject:rej}; post({t:'fetchExternal', reqId:id, url:String(url), as:(opts&&opts.as)||null}); }); },
    loadLib:function(name){ name=String(name); if(loadedLibs[name]) return loadedLibs[name]; var id=++reqId; loadedLibs[name]=new Promise(function(res,rej){ pending[id]={resolve:res,reject:function(e){ delete loadedLibs[name]; rej(e); }}; post({t:'loadLib', reqId:id, name:name}); }); return loadedLibs[name]; },
    runCompute:function(code,opts){ var id=++reqId; return new Promise(function(res,rej){ pending[id]={resolve:res,reject:rej}; post({t:'requestCompute', reqId:id, code:String(code), opts:(opts&&typeof opts==='object')?opts:{}}); }); },
    cssVar:function(name){ try{ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }catch(e){ return ''; } }
  };
})();
`;

// Compose the full iframe document (srcdoc) for a widget source.
export function widgetSrcdoc(source: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${WIDGET_BASE_CSS}</style></head><body></body>`
    + `<script>${WIDGET_BOOTSTRAP}</script>`
    + `<script>try{\n${escapeForScript(source)}\n}catch(e){window.onerror&&window.onerror(e.message,'',0,0,e);}</script></html>`;
}
