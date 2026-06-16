// Session + custom-widget persistence (localStorage). The pure (de)serialize + library helpers live here so they
// can be unit-tested; shell.ts owns the wiring (when to capture/restore). Theme persists separately ("p2-theme").
export const SESSION_KEY = "p3-session";
export const WIDGETS_KEY = "p3-widgets";
const VERSION = 1;

export interface SavedWidget { id: string; name: string; source: string; controls?: { id: string; label: string }[]; createdAt: number; }
export interface SessionDoc { v: number; currentWS: string; colorBy: string; canvas: any[]; userWS: { name: string; ws: any }[]; }

export function serializeSession(d: { currentWS: string; colorBy: string; canvas: any[]; userWS: { name: string; ws: any }[] }): string {
  return JSON.stringify({ v: VERSION, currentWS: d.currentWS, colorBy: d.colorBy, canvas: d.canvas, userWS: d.userWS });
}
// Tolerant parse: anything malformed / from an older version → null (start fresh, never throw on boot).
export function parseSession(raw: string | null): SessionDoc | null {
  if (!raw) return null;
  try { const o = JSON.parse(raw); if (!o || o.v !== VERSION || !Array.isArray(o.canvas)) return null;
    return { v: o.v, currentWS: String(o.currentWS || ""), colorBy: String(o.colorBy || ""), canvas: o.canvas, userWS: Array.isArray(o.userWS) ? o.userWS : [] };
  } catch { return null; }
}

// Upsert an authored widget into the library by NAME (re-saving the same name updates its source). Pure → returns a
// new array. `now`/`id` are passed in so the caller controls timestamping (and tests stay deterministic).
export function upsertWidget(list: SavedWidget[], w: { name: string; source: string; controls?: { id: string; label: string }[] }, now: number, id: string): SavedWidget[] {
  const name = (w.name || "Widget").trim();
  const i = list.findIndex((x) => x.name === name);
  const entry: SavedWidget = { id: i >= 0 ? list[i].id : id, name, source: w.source, controls: w.controls, createdAt: i >= 0 ? list[i].createdAt : now };
  const out = list.slice();
  if (i >= 0) out[i] = entry; else out.push(entry);
  return out;
}

export function loadWidgets(raw: string | null): SavedWidget[] {
  if (!raw) return [];
  try { const o = JSON.parse(raw); const arr = Array.isArray(o) ? o : o?.widgets; return Array.isArray(arr) ? arr.filter((w: any) => w && typeof w.source === "string") : []; } catch { return []; }
}
