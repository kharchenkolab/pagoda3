// A small modal shown while a local dataset is being opened (drag/drop or the file picker). Opening an
// .h5ad/.zip loads + parses the whole file in the browser, which can take several seconds with no other
// feedback — so we show a spinner + a status line that the open path advances through its stages, and on
// failure we show the actual error (with a Close button) instead of failing silently.
let el: HTMLDivElement | null = null;

function ensure(): HTMLDivElement {
  if (el) return el;
  const style = document.createElement("style");
  style.textContent = `
    #ldov{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;
      background:rgba(8,10,14,.55);backdrop-filter:blur(2px);font:13px/1.5 ui-sans-serif,system-ui,sans-serif}
    #ldov.show{display:flex}
    #ldov .ldcard{min-width:300px;max-width:440px;padding:22px 24px;border-radius:12px;
      background:var(--panel,#161a22);color:var(--fg,#e6e9ef);border:1px solid var(--line,#2a2f3a);
      box-shadow:0 12px 40px rgba(0,0,0,.5)}
    #ldov .ldrow{display:flex;align-items:center;gap:13px}
    #ldov .ldspin{width:20px;height:20px;border-radius:50%;flex:0 0 auto;
      border:2.5px solid var(--line,#2a2f3a);border-top-color:var(--accent,#5b9cff);animation:ldspin .8s linear infinite}
    @keyframes ldspin{to{transform:rotate(360deg)}}
    #ldov .ldtitle{font-weight:600}
    #ldov .ldstatus{opacity:.65;margin-top:3px;font-size:12px}
    #ldov.err .ldspin{display:none}
    #ldov .lderr{display:none;color:#ff9b9b;white-space:pre-wrap;margin-top:10px;font-size:12px;
      max-height:240px;overflow:auto;background:rgba(0,0,0,.25);padding:9px 11px;border-radius:7px}
    #ldov.err .lderr{display:block}
    #ldov .ldx{display:none;margin-top:14px;text-align:right}
    #ldov.err .ldx{display:block}
    #ldov .ldx button{font:inherit;color:var(--fg,#e6e9ef);background:var(--line,#2a2f3a);
      border:0;border-radius:7px;padding:6px 16px;cursor:pointer}`;
  document.head.appendChild(style);
  const d = document.createElement("div");
  d.id = "ldov";
  d.innerHTML =
    '<div class="ldcard"><div class="ldrow"><div class="ldspin"></div>' +
    '<div><div class="ldtitle"></div><div class="ldstatus"></div></div></div>' +
    '<div class="lderr"></div><div class="ldx"><button>Close</button></div></div>';
  d.querySelector<HTMLButtonElement>(".ldx button")!.onclick = () => hideLoading();
  document.body.appendChild(d);
  el = d;
  return d;
}

/** Show the overlay with a title (e.g. the file name) and an initial status line. */
export function showLoading(title: string, status = "Reading file…"): void {
  const d = ensure();
  d.classList.remove("err");
  d.querySelector(".ldtitle")!.textContent = title;
  d.querySelector(".ldstatus")!.textContent = status;
  d.classList.add("show");
}

/** Advance the status line under the spinner. */
export function setLoadingStatus(status: string): void {
  if (el) el.querySelector(".ldstatus")!.textContent = status;
}

/** Hide the overlay (on success, or when the user dismisses an error). */
export function hideLoading(): void {
  if (el) el.classList.remove("show", "err");
}

/** Turn the overlay into an error state showing the real message + a Close button. */
export function showLoadError(title: string, message: string): void {
  const d = ensure();
  d.querySelector(".ldtitle")!.textContent = "Couldn't open " + title;
  d.querySelector(".ldstatus")!.textContent = "";
  d.querySelector(".lderr")!.textContent = message;
  d.classList.add("show", "err");
}
