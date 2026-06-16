// Search/replace patch editing for widget source — so the agent fixes a widget by sending the CHANGED REGION, not by
// re-emitting the whole 2–4K-token source each iteration (the dominant authoring latency; see the proxy agent log).
// Same discipline as a str-replace editor: each `old` must match EXACTLY ONCE (add surrounding context to disambiguate).
// ATOMIC: if any edit fails, none are committed — the caller keeps the prior source and the agent retries cleanly.

export interface WidgetEdit { old: string; new: string }
export interface EditResult { source: string; ok: boolean; applied: string[]; failed: { old: string; why: string }[] }

const clip = (s: string) => (s.length > 60 ? s.slice(0, 60) + "…" : s);

export function applyEdits(source: string, edits: WidgetEdit[]): EditResult {
  let s = source; const applied: string[] = []; const failed: { old: string; why: string }[] = [];
  for (const e of edits || []) {
    const oldS = String(e && e.old != null ? e.old : ""), newS = String(e && e.new != null ? e.new : "");
    if (!oldS) { failed.push({ old: "", why: "empty 'old'" }); continue; }
    const i = s.indexOf(oldS);
    if (i < 0) { failed.push({ old: clip(oldS), why: "not found in the current source" }); continue; }
    if (s.indexOf(oldS, i + oldS.length) >= 0) { failed.push({ old: clip(oldS), why: "matches more than one place — add surrounding context to make it unique" }); continue; }
    s = s.slice(0, i) + newS + s.slice(i + oldS.length);
    applied.push(clip(oldS));
  }
  // atomic: a partial apply leaves the source in a half-edited state the agent can't reason about, so commit only if all applied
  if (failed.length) return { source, ok: false, applied: [], failed };
  return { source: s, ok: true, applied, failed: [] };
}
