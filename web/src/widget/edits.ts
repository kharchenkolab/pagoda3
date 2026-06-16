// Search/replace patch editing for widget source — so the agent fixes a widget by sending the CHANGED REGION, not by
// re-emitting the whole 2–4K-token source each iteration (the dominant authoring latency; see the proxy agent log).
// Deliberately mirrors the text-editor `str_replace` tool the models are trained on: fields are `old_str`/`new_str`,
// each `old_str` must match the source EXACTLY and UNIQUELY (add surrounding context to disambiguate). For robustness
// we also accept the adjacent trained spellings (`old_string`/`new_string` — Claude Code's Edit tool — and `old`/`new`).
// ATOMIC: if any edit fails, none are committed — the caller keeps the prior source and the agent retries cleanly.

export interface WidgetEdit { old_str?: string; new_str?: string; old_string?: string; new_string?: string; old?: string; new?: string }
export interface EditResult { source: string; ok: boolean; applied: string[]; failed: { old_str: string; why: string }[] }

const clip = (s: string) => (s.length > 60 ? s.slice(0, 60) + "…" : s);
const pickOld = (e: WidgetEdit) => e.old_str ?? e.old_string ?? e.old ?? "";
const pickNew = (e: WidgetEdit) => e.new_str ?? e.new_string ?? e.new ?? "";

export function applyEdits(source: string, edits: WidgetEdit[]): EditResult {
  let s = source; const applied: string[] = []; const failed: { old_str: string; why: string }[] = [];
  for (const e of edits || []) {
    const oldS = String(pickOld(e)), newS = String(pickNew(e));
    if (!oldS) { failed.push({ old_str: "", why: "empty 'old_str'" }); continue; }
    const i = s.indexOf(oldS);
    if (i < 0) { failed.push({ old_str: clip(oldS), why: "not found in the current source" }); continue; }
    if (s.indexOf(oldS, i + oldS.length) >= 0) { failed.push({ old_str: clip(oldS), why: "matches more than one place — add surrounding context to make it unique" }); continue; }
    s = s.slice(0, i) + newS + s.slice(i + oldS.length);
    applied.push(clip(oldS));
  }
  // atomic: a partial apply leaves the source in a half-edited state the agent can't reason about, so commit only if all applied
  if (failed.length) return { source, ok: false, applied: [], failed };
  return { source: s, ok: true, applied, failed: [] };
}
