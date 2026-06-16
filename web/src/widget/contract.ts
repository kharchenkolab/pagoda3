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

// A widget's self-declared metadata. controls become standard header buttons the HOST renders (uniform ⋯/toolbar
// policy); a click comes back as a {t:"control"} message. height lets a widget request its natural body height.
export interface WidgetManifest { title?: string; height?: number; controls?: { id: string; label: string }[]; }

// host → widget
export type HostMsg =
  | { t: "init"; theme: ThemeInfo; coord: CoordInfo; hint: HintInfo }
  | { t: "coord"; coord: CoordInfo }
  | { t: "hint"; hint: HintInfo }                                 // cross-panel hover changed (ephemeral)
  | { t: "theme"; theme: ThemeInfo }
  | { t: "control"; id: string }                                  // a host-rendered header control was clicked
  | { t: "data"; reqId: number; ok: boolean; payload?: any; error?: string }   // reply to a requestData
  | { t: "snapshot" };                                            // ask the widget to report its rendered text (preview feedback)

// widget → host
export type WidgetMsg =
  | { t: "ready"; manifest: WidgetManifest }
  | { t: "setSelection"; sel: { cells?: number[]; category?: { grouping: string; value: string } | null } | null }
  | { t: "setColor"; handle: string }
  | { t: "setHint"; hint: any }
  | { t: "updateView"; patch: any }
  | { t: "requestData"; reqId: number; kind: string; args?: any }
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
  }
  return out;
}

// The data kinds a widget may request (host resolves them). Documented so the agent + the host stay in step.
export const DATA_KINDS = ["n", "fields", "categories", "category", "cellsOf", "expr", "numeric", "selectedCells"] as const;

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
  "`pagoda.on('coord'|'hint'|'theme'|'control', cb)` → subscribe (returns an unsubscribe fn). HOVER/CLICK like a native " +
  "panel: EMIT hover with pagoda.setHint({cells:[i]}|{category:{grouping,value}}|null) and clicks with " +
  "pagoda.setSelection(...); REACT to cross-panel hover via pagoda.on('hint', h => …) where h is null|{kind:'cells',ids}|" +
  "{kind:'category',grouping,value} (`pagoda.hint` is the current one) — the ephemeral hover tier, separate from coord; " +
  "react to clicks/selection via pagoda.on('coord', c => c.selection). " +
  "`pagoda.setSelection({cells:[...]}|{category:{grouping,value}}|null)`, `pagoda.setColor('gene:CD3E'|'meta:cell_type'|'qc:mito')`, " +
  "`pagoda.setHint(ref)`, `pagoda.updateView(patch)` (same patch shape as the update_view tool); " +
  "`await pagoda.data(kind, args)` to pull data on demand — kinds: " +
  "'n' (cell count), 'fields' (→ {categorical:[names], numeric:[names]}), 'categories' (args:{field} → {categories,counts}), 'category' (args:{field} → {codes,categories}), " +
  "'cellsOf' (args:{field,value} → number[]), 'expr' (args:{gene} → Float32Array of log-norm expression), " +
  "'numeric' (args:{field} → {values,min,max}), 'selectedCells' (→ number[] of the currently selected cell indices). " +
  "Errors/console are forwarded to the host for debugging; an uncaught " +
  "throw shows an error state. Header `controls` you declare are rendered by the host in the standard panel chrome; " +
  "a click arrives as pagoda.on('control', id => …). Keep it self-contained — no external network/CDN.";

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
  var pending={}, reqId=0, coord=null, theme=null, hint=null, listeners={coord:[],theme:[],control:[],hint:[]}, parentWin=window.parent;
  function post(m){ try{ parentWin.postMessage(m,'*'); }catch(e){} }
  function fire(ev,arg){ (listeners[ev]||[]).forEach(function(f){ try{ f(arg); }catch(err){ reportError(err); } }); }
  function reportError(err){ post({t:'error', message:String(err&&err.message?err.message:err), stack: err&&err.stack ? String(err.stack) : undefined }); }
  function applyTheme(t){ if(!t) return; var s=document.getElementById('pg-theme'); if(!s){ s=document.createElement('style'); s.id='pg-theme'; document.head.appendChild(s); } var v=t.vars||{}; s.textContent=':root{'+Object.keys(v).map(function(k){return k+':'+v[k];}).join(';')+'}'; document.documentElement.setAttribute('data-theme', t.dark?'dark':'light'); }
  window.addEventListener('message', function(e){ var m=e.data; if(!m||!m.t) return;
    if(m.t==='init'){ coord=m.coord; theme=m.theme; hint=m.hint||null; applyTheme(theme); fire('theme',theme); fire('coord',coord); if(hint) fire('hint',hint); }
    else if(m.t==='coord'){ coord=m.coord; fire('coord',coord); }
    else if(m.t==='hint'){ hint=m.hint||null; fire('hint',hint); }
    else if(m.t==='theme'){ theme=m.theme; applyTheme(theme); fire('theme',theme); }
    else if(m.t==='control'){ fire('control', m.id); }
    else if(m.t==='snapshot'){ post({t:'snapshotResult', text:(document.body.innerText||'').replace(/\\s+/g,' ').trim().slice(0,3000)}); }
    else if(m.t==='data'){ var p=pending[m.reqId]; if(p){ delete pending[m.reqId]; m.ok ? p.resolve(m.payload) : p.reject(new Error(m.error||'data error')); } }
  });
  ['log','warn','error'].forEach(function(lv){ var orig=console[lv]; console[lv]=function(){ try{ post({t:'log', level:lv, args:[].map.call(arguments, function(x){ try{return typeof x==='string'?x:JSON.stringify(x);}catch(e){return String(x);} })}); }catch(e){} try{ orig.apply(console, arguments); }catch(e){} }; });
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
