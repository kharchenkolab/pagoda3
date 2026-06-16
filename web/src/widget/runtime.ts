// Browser-side widget runtime: mount an author-written widget in a sandboxed iframe and bridge it to a WidgetHost
// (the app provides a real one over coord/ctx; the dev harness provides a mock). Decoupled from the app — it only
// speaks the contract.ts protocol + this WidgetHost interface.
import { ThemeInfo, CoordInfo, HintInfo, WidgetManifest, WidgetMsg, validateManifest, widgetSrcdoc } from "./contract.ts";

// What a host must provide. The runtime never touches app state directly — it asks the host.
export interface WidgetHost {
  theme(): ThemeInfo;
  coord(): CoordInfo;
  hint(): HintInfo;                                              // the ephemeral cross-panel hover (separate from coord)
  subscribe(cb: (what: "coord" | "theme" | "hint") => void): () => void;   // notify on coord/theme/hint change → re-pushed to the iframe
  apply(msg: WidgetMsg): void;                                    // host acts on setSelection/setColor/setHint/updateView
  data(kind: string, args: any): Promise<any>;                   // resolve a pagoda.data(kind,args) request
  fetchExternal?(url: string, opts?: { as?: string }): Promise<any>;   // host-mediated allowlisted external fetch (optional)
  loadLib?(name: string): Promise<string>;                       // returns an allowlisted, host-pinned library's JS source (optional)
}

export interface WidgetHandle {
  iframe: HTMLIFrameElement;
  manifest(): WidgetManifest | null;
  logs(): { level: string; args: string[] }[];
  lastError(): { message: string; stack?: string } | null;
  onManifest(cb: (m: WidgetManifest) => void): void;             // fired when the widget calls pagoda.ready() — host renders chrome
  onResize(cb: (h: number) => void): void;
  sendControl(id: string): void;                                 // host → widget: a declared header control was clicked
  snapshot(timeoutMs?: number): Promise<string>;                 // ask the widget for its rendered text (preview feedback)
  destroy(): void;
}

// Mount `source` into `container`. `actions` lets the caller pre-tap widget→host messages (the harness logs them);
// otherwise everything routes through `host`.
export function mountWidget(container: HTMLElement, source: string, host: WidgetHost, tap?: (m: WidgetMsg) => void): WidgetHandle {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");   // opaque origin → real isolation; postMessage still works (origin "null")
  iframe.style.cssText = "width:100%;border:0;display:block;background:transparent";
  iframe.srcdoc = widgetSrcdoc(source);

  let manifest: WidgetManifest | null = null;
  const logs: { level: string; args: string[] }[] = [];
  let lastErr: { message: string; stack?: string } | null = null;
  const manifestCbs: ((m: WidgetManifest) => void)[] = [];
  const resizeCbs: ((h: number) => void)[] = [];
  const snapWaiters: ((t: string) => void)[] = [];

  const post = (m: any) => { try { iframe.contentWindow?.postMessage(m, "*"); } catch { /* */ } };
  const onMsg = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return;   // only this iframe (origin is "null" under sandbox, so match by window)
    const m = e.data as WidgetMsg; if (!m || !(m as any).t) return;
    tap?.(m);
    switch (m.t) {
      case "ready": manifest = validateManifest(m.manifest); manifestCbs.forEach((f) => f(manifest!)); break;
      case "resize": resizeCbs.forEach((f) => f(m.height)); break;
      case "snapshotResult": snapWaiters.splice(0).forEach((f) => f(m.text)); break;
      case "log": logs.push({ level: m.level, args: m.args }); if (logs.length > 200) logs.shift(); break;
      case "error": lastErr = { message: m.message, stack: m.stack }; break;
      case "requestData": host.data(m.kind, m.args).then(
        (payload) => post({ t: "data", reqId: m.reqId, ok: true, payload }),
        (err) => post({ t: "data", reqId: m.reqId, ok: false, error: String(err?.message || err) }));
        break;
      case "fetchExternal":
        (host.fetchExternal ? host.fetchExternal(m.url, { as: m.as }) : Promise.reject(new Error("external fetch not available in this host"))).then(
          (payload) => post({ t: "extData", reqId: m.reqId, ok: true, payload }),
          (err) => post({ t: "extData", reqId: m.reqId, ok: false, error: String(err?.message || err) }));
        break;
      case "loadLib":
        (host.loadLib ? host.loadLib(m.name) : Promise.reject(new Error("loadLib not available in this host"))).then(
          (source) => post({ t: "libResult", reqId: m.reqId, ok: true, source }),
          (err) => post({ t: "libResult", reqId: m.reqId, ok: false, error: String(err?.message || err) }));
        break;
      case "setSelection": case "setColor": case "setHint": case "updateView": host.apply(m); break;
    }
  };
  window.addEventListener("message", onMsg);

  // push the initial state once the iframe is ready, then keep it in sync
  iframe.addEventListener("load", () => post({ t: "init", theme: host.theme(), coord: host.coord(), hint: host.hint() }));
  const unsub = host.subscribe((what) => post(
    what === "coord" ? { t: "coord", coord: host.coord() }
      : what === "hint" ? { t: "hint", hint: host.hint() }
        : { t: "theme", theme: host.theme() }));

  container.appendChild(iframe);

  return {
    iframe,
    manifest: () => manifest,
    logs: () => logs.slice(),
    lastError: () => lastErr,
    onManifest: (cb) => { if (manifest) cb(manifest); else manifestCbs.push(cb); },
    onResize: (cb) => resizeCbs.push(cb),
    sendControl: (id) => post({ t: "control", id }),
    snapshot: (timeoutMs = 1500) => new Promise<string>((res) => { snapWaiters.push(res); post({ t: "snapshot" }); setTimeout(() => res(""), timeoutMs); }),
    destroy: () => { window.removeEventListener("message", onMsg); unsub(); iframe.remove(); },
  };
}

// A preview-only sentinel: the probe wrapper logs this when it finishes, so previewWidget knows the (possibly async)
// interaction is done before it snapshots.
const PROBE_DONE = "__pg_probe_done__";

// Wrap an interaction probe so it runs in the widget's OWN scope (it's concatenated into the same <script> try-block,
// so it can call the widget's top-level functions/vars), catches its own errors, and signals completion.
function withProbe(source: string, probe: string): string {
  return source + `\n;(async function(){ try{ ${probe} \n}catch(__pe){ console.error("probe error: "+((__pe&&__pe.message)||__pe)); } finally{ console.log(${JSON.stringify(PROBE_DONE)}); } })();`;
}

// The agent's feedback channel: render a widget offscreen, wait for ready (or error/timeout), and report what
// happened — ok, manifest, any error, console logs, and the rendered text. This is what the preview_widget tool returns.
// `probe` (optional) is JS run in the widget's scope after mount — it can call the widget's functions and set input
// values to exercise interactive logic the initial render never reaches; its console output + the post-probe DOM are returned.
export async function previewWidget(source: string, host: WidgetHost, timeoutMs = 4000, probe?: string):
    Promise<{ ok: boolean; manifest: WidgetManifest | null; error: string | null; logs: { level: string; args: string[] }[]; text: string }> {
  // Offscreen but FULLY LAID OUT at a real size (not visibility:hidden, and the iframe sized in px below) — so canvas
  // widgets measure non-zero clientWidth/Height during preview, matching prod. Otherwise the agent burns an iteration
  // working around a 0×0 canvas that only exists in the headless preview.
  const off = document.createElement("div");
  off.style.cssText = "position:absolute;left:-9999px;top:0;width:480px;height:360px;overflow:hidden";
  document.body.appendChild(off);
  const h = mountWidget(off, probe ? withProbe(source, probe) : source, host);
  h.iframe.style.width = "480px"; h.iframe.style.height = "360px";
  const ready = await new Promise<boolean>((res) => {
    let done = false; const fin = (v: boolean) => { if (!done) { done = true; res(v); } };
    h.onManifest(() => fin(true));
    const poll = setInterval(() => { if (h.lastError()) { clearInterval(poll); fin(false); } }, 60);
    setTimeout(() => { clearInterval(poll); fin(!!h.manifest()); }, timeoutMs);
  });
  // If a probe is running, wait for it to signal done (it may be async — e.g. awaiting data) before snapshotting.
  if (ready && probe) {
    await new Promise<void>((res) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        const done = h.logs().some((l) => l.args.some((a) => a === PROBE_DONE));
        if (done || h.lastError() || Date.now() - t0 > Math.max(2000, timeoutMs)) { clearInterval(poll); res(); }
      }, 60);
    });
  }
  const text = ready ? await h.snapshot(1200) : "";
  // Make the failure reason actionable: a caught error wins; otherwise a no-manifest result means it timed out
  // (the widget never called pagoda.ready()) — say so explicitly instead of returning a null error.
  const error = h.lastError()?.message
    || (!h.manifest() ? `widget did not call pagoda.ready() within ${timeoutMs}ms (it timed out — call pagoda.ready({title}) once your UI is set up, and check for a script error above it)` : null);
  const logs = h.logs().filter((l) => !l.args.some((a) => a === PROBE_DONE));   // hide the internal sentinel
  const out = { ok: ready && !h.lastError(), manifest: h.manifest(), error, logs, text };
  h.destroy(); off.remove();
  return out;
}
