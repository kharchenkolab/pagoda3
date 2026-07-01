// The overlay shown while a local dataset is being opened. Two shapes:
//   • SMALL — a spinner + one status line (a trivial open: a ready store, a zip, a file with everything).
//   • CARD  — a live CHECKLIST, shown only when non-trivial work happens (a raw .h5ad we must normalize →
//             PCA → cluster → UMAP → markers). Each row ticks from queued → working → done, tagged "in file"
//             when it was already present vs freshly computed, with Cancel mid-way and OK at the end.
// On failure either shape flips to an error state with the real message (+ optional "Try it anyway").

export type StepStatus = "pending" | "active" | "done" | "present";
/** The progress channel the open path drives (UI-agnostic; loading.ts renders it). */
export interface OpenProgress {
  stage(msg: string): void;                                                   // small one-liner
  step(id: string, label: string, status: StepStatus, detail?: string): void; // a checklist row (first call → card)
  readonly signal?: AbortSignal;                                              // set when the user can Cancel
}

let el: HTMLDivElement | null = null;
let onCancelCb: (() => void) | null = null;
let onOkCb: (() => void) | null = null;
const steps = new Map<string, { label: string; status: StepStatus; detail?: string }>();

function ensure(): HTMLDivElement {
  if (el) return el;
  const style = document.createElement("style");
  style.textContent = `
    #ldov{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;
      background:rgba(8,10,14,.55);backdrop-filter:blur(2px);font:13px/1.5 ui-sans-serif,system-ui,sans-serif}
    #ldov.show{display:flex}
    #ldov .ldcard{min-width:320px;max-width:460px;padding:22px 24px;border-radius:12px;
      background:var(--panel,#161a22);color:var(--fg,#e6e9ef);border:1px solid var(--line,#2a2f3a);box-shadow:0 12px 40px rgba(0,0,0,.5)}
    #ldov .ldspin{width:20px;height:20px;border-radius:50%;flex:0 0 auto;
      border:2.5px solid var(--line,#2a2f3a);border-top-color:var(--accent,#5b9cff);animation:ldspin .8s linear infinite}
    @keyframes ldspin{to{transform:rotate(360deg)}}
    #ldov .ldtitle{font-weight:600}
    #ldov .ldstatus{opacity:.6;margin-top:3px;font-size:12px}
    /* small vs card visibility */
    #ldov .ldsmall{display:flex;align-items:center;gap:13px}
    #ldov.card:not(.err) .ldsmall{display:none}
    #ldov.err .ldspin,#ldov.err .ldstatus{display:none}
    #ldov .ldbig{display:none}
    #ldov.card:not(.err) .ldbig{display:block}
    #ldov .ldbigtitle{font-weight:600}
    #ldov .ldbigsub{opacity:.6;font-size:12px;margin-top:2px}
    #ldov .ldlist{margin:14px 0 2px;display:flex;flex-direction:column;gap:2px}
    #ldov .ldstep{display:flex;align-items:center;gap:11px;padding:4px 2px;font-size:12.5px;
      opacity:.45;transition:opacity .3s ease}
    #ldov .ldstep.on{opacity:1}
    #ldov .ldico{width:16px;height:16px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:13px}
    #ldov .ldico .ldspin{width:13px;height:13px;border-width:2px}
    #ldov .ldico.done{color:#57c98a}
    #ldov .ldico.present{color:#7c8794}
    #ldov .ldico.pending{color:var(--line,#3a4150)}
    #ldov .ldlabel{flex:1}
    #ldov .lddetail{opacity:.5;font-size:11.5px;font-variant-numeric:tabular-nums}
    #ldov .ldtag{font-size:10px;opacity:.5;border:1px solid var(--line,#2a2f3a);border-radius:5px;padding:0 5px;margin-left:2px}
    #ldov .ldtag.calc{opacity:.85;color:var(--accent,#5b9cff);border-color:rgba(91,156,255,.4)}   /* computed vs read-from-file — accent-tinted to stand apart from the muted "in file" */
    /* error */
    #ldov .lderr{display:none;color:#ff9b9b;white-space:pre-wrap;margin-top:10px;font-size:12px;
      max-height:240px;overflow:auto;background:rgba(0,0,0,.25);padding:9px 11px;border-radius:7px}
    #ldov.err .lderr{display:block}
    /* buttons */
    #ldov .ldbtns{display:none;margin-top:16px;justify-content:flex-end;gap:8px;align-items:center}
    #ldov.card .ldbtns,#ldov.err .ldbtns{display:flex}
    #ldov .ldbtns button{font:inherit;color:var(--fg,#e6e9ef);background:var(--line,#2a2f3a);border:0;border-radius:7px;padding:6px 16px;cursor:pointer}
    #ldov .ldbtns button:disabled{opacity:.4;cursor:default}
    #ldov .ldbtns .ldok,#ldov .ldbtns .ldretry{background:var(--accent,#5b9cff);color:#fff}
    #ldov .ldcancel,#ldov .ldok,#ldov .ldretry,#ldov .ldclose{display:none}
    /* card mode shows Cancel on the LEFT and OK on the RIGHT throughout the run; the disabled state (set in JS) says which is actionable — Cancel while running, OK when done */
    #ldov.card:not(.err) .ldcancel{display:inline-block;margin-right:auto}
    #ldov.card:not(.err) .ldok{display:inline-block}
    #ldov.err .ldclose{display:inline-block}
    #ldov.err.hasretry .ldretry{display:inline-block}`;   /* retry ("Try it anyway") is class-driven — NOT an inline style — so leaving the error state (→ loading card) actually hides it */
  document.head.appendChild(style);
  const d = document.createElement("div");
  d.id = "ldov";
  d.innerHTML =
    '<div class="ldcard">' +
      '<div class="ldsmall"><div class="ldspin"></div><div><div class="ldtitle"></div><div class="ldstatus"></div></div></div>' +
      '<div class="ldbig"><div class="ldbigtitle"></div><div class="ldbigsub"></div><div class="ldlist"></div></div>' +
      '<div class="lderr"></div>' +
      '<div class="ldbtns"><button class="ldcancel">Cancel</button><button class="ldretry"></button><button class="ldclose">Close</button><button class="ldok">Open</button></div>' +
    '</div>';
  d.querySelector<HTMLButtonElement>(".ldclose")!.onclick = () => hideLoading();
  d.querySelector<HTMLButtonElement>(".ldcancel")!.onclick = () => { const cb = onCancelCb; hideLoading(); cb?.(); };
  d.querySelector<HTMLButtonElement>(".ldok")!.onclick = () => { const cb = onOkCb; hideLoading(); cb?.(); };
  // Enter confirms — click the OK button when it's live (card finished). Ignored while running (OK disabled) and in
  // the small/error modes. Capture phase so it fires before any panel handler.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !el || !el.classList.contains("show") || !el.classList.contains("card") || el.classList.contains("err")) return;
    const ok = el.querySelector<HTMLButtonElement>(".ldok");
    if (ok && !ok.disabled) { e.preventDefault(); e.stopPropagation(); ok.click(); }
  }, true);
  document.body.appendChild(d);
  el = d;
  return d;
}

const ICON: Record<StepStatus, string> = { pending: "○", active: '<span class="ldspin"></span>', done: "✓", present: "✓" };

function renderSteps(): void {
  if (!el) return;
  const list = el.querySelector(".ldlist")!;
  list.innerHTML = "";
  for (const [, s] of steps) {
    const row = document.createElement("div");
    row.className = "ldstep" + (s.status !== "pending" ? " on" : "");
    const detail = s.detail ? `<span class="lddetail">${s.detail}</span>` : "";
    const tag = s.status === "present" ? '<span class="ldtag">in file</span>' : '<span class="ldtag calc">calculated</span>';   // read from the file vs. computed on the fly
    row.innerHTML = `<span class="ldico ${s.status}">${ICON[s.status]}</span><span class="ldlabel">${s.label}</span>${detail}${tag}`;
    list.appendChild(row);
  }
}

/** SMALL mode: a spinner + one status line. */
export function showLoading(title: string, status = "Reading file…"): void {
  const d = ensure();
  d.classList.remove("err", "card", "done", "hasretry");
  steps.clear();
  d.querySelector(".ldtitle")!.textContent = title;
  d.querySelector(".ldstatus")!.textContent = status;
  d.classList.add("show");
}

/** Advance the small status line. */
export function setLoadingStatus(status: string): void { if (el) el.querySelector(".ldstatus")!.textContent = status; }

/** CARD mode: switch the overlay to a checklist. `onCancel` wires the Cancel button (mid-run). */
export function beginChecklist(title: string, subtitle: string, onCancel?: () => void): void {
  const d = ensure();
  d.classList.remove("err", "done", "hasretry"); d.classList.add("show", "card");
  steps.clear();
  d.querySelector(".ldbigtitle")!.textContent = title;
  d.querySelector(".ldbigsub")!.textContent = subtitle;
  onCancelCb = onCancel || null;
  d.querySelector<HTMLButtonElement>(".ldcancel")!.disabled = false;   // while running: Cancel (left) is actionable…
  d.querySelector<HTMLButtonElement>(".ldok")!.disabled = true;        // …OK (right) waits until the run finishes
  renderSteps();
}

/** Add or update a checklist row. */
export function setStep(id: string, label: string, status: StepStatus, detail?: string): void {
  ensure();
  const prev = steps.get(id);
  steps.set(id, { label, status, detail: detail ?? prev?.detail });
  renderSteps();
}

/** Finish the checklist: all rows done, swap Cancel → OK. `onOk` fires when the user clicks Open. */
export function finishChecklist(onOk?: () => void): void {
  if (!el) return;
  onOkCb = onOk || null;
  el.classList.add("done");
  el.querySelector<HTMLButtonElement>(".ldcancel")!.disabled = true;   // run finished: Cancel (left) is spent…
  el.querySelector<HTMLButtonElement>(".ldok")!.disabled = false;      // …OK (right) is now the action (Enter also triggers it)
}

/** Hide the overlay (success dismissed, or an error closed). */
export function hideLoading(): void { if (el) el.classList.remove("show", "err", "card", "done", "hasretry"); }

/** Error state with the real message + a Close button; `retry` adds an override (e.g. "Try it anyway"). */
export function showLoadError(title: string, message: string, retry?: { label: string; run: () => void }): void {
  const d = ensure();
  d.querySelector(".ldtitle")!.textContent = "Couldn't open " + title;   // small-mode title (in case not card)
  d.querySelector(".ldstatus")!.textContent = "";
  d.querySelector(".lderr")!.textContent = message;
  const rb = d.querySelector<HTMLButtonElement>(".ldretry")!;
  if (retry) { rb.textContent = retry.label; rb.onclick = () => { hideLoading(); retry.run(); }; d.classList.add("hasretry"); }
  else d.classList.remove("hasretry");
  d.classList.remove("done", "card"); d.classList.add("show", "err");   // fall back to the titled small+error layout even if a card was showing
}
