// Browser-side widget runtime: mount an author-written widget in a sandboxed iframe and bridge it to a WidgetHost
// (the app provides a real one over coord/ctx; the dev harness provides a mock). Decoupled from the app — it only
// speaks the contract.ts protocol + this WidgetHost interface.
import { ThemeInfo, CoordInfo, WidgetManifest, WidgetMsg, validateManifest, widgetSrcdoc } from "./contract.ts";

// What a host must provide. The runtime never touches app state directly — it asks the host.
export interface WidgetHost {
  theme(): ThemeInfo;
  coord(): CoordInfo;
  subscribe(cb: (what: "coord" | "theme") => void): () => void;   // notify on coord/theme change → re-pushed to the iframe
  apply(msg: WidgetMsg): void;                                    // host acts on setSelection/setColor/setHint/updateView
  data(kind: string, args: any): Promise<any>;                   // resolve a pagoda.data(kind,args) request
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
      case "setSelection": case "setColor": case "setHint": case "updateView": host.apply(m); break;
    }
  };
  window.addEventListener("message", onMsg);

  // push the initial state once the iframe is ready, then keep it in sync
  iframe.addEventListener("load", () => post({ t: "init", theme: host.theme(), coord: host.coord() }));
  const unsub = host.subscribe((what) => post(what === "coord" ? { t: "coord", coord: host.coord() } : { t: "theme", theme: host.theme() }));

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

// The agent's feedback channel: render a widget offscreen, wait for ready (or error/timeout), and report what
// happened — ok, manifest, any error, console logs, and the rendered text. This is what the preview_widget tool returns.
export async function previewWidget(source: string, host: WidgetHost, timeoutMs = 4000):
    Promise<{ ok: boolean; manifest: WidgetManifest | null; error: string | null; logs: { level: string; args: string[] }[]; text: string }> {
  const off = document.createElement("div");
  off.style.cssText = "position:absolute;left:-9999px;top:0;width:480px;height:360px;visibility:hidden";
  document.body.appendChild(off);
  const h = mountWidget(off, source, host);
  const ready = await new Promise<boolean>((res) => {
    let done = false; const fin = (v: boolean) => { if (!done) { done = true; res(v); } };
    h.onManifest(() => fin(true));
    const poll = setInterval(() => { if (h.lastError()) { clearInterval(poll); fin(false); } }, 60);
    setTimeout(() => { clearInterval(poll); fin(!!h.manifest()); }, timeoutMs);
  });
  const text = ready ? await h.snapshot(1200) : "";
  const out = { ok: ready && !h.lastError(), manifest: h.manifest(), error: h.lastError()?.message || null, logs: h.logs(), text };
  h.destroy(); off.remove();
  return out;
}
