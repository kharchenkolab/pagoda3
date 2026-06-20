// Session + custom-widget persistence. The pure (de)serialize + library helpers live here so they can be unit-tested;
// shell.ts owns the wiring (when to capture/restore, the File System Access I/O). Theme persists separately ("p2-theme").
//
// THREE artifacts (see the persistence design): VIEWS (layout — recompute-free), AUTHORED DATA (the annotation draft —
// materialized here), and the WIDGET LIBRARY (dataset-agnostic). localStorage is the auto-save CONTINUITY layer; the
// exportable BUNDLE (serializeBundle) is the portable DOCUMENT — a self-contained file (session + widgets) the user can
// save, reopen on another machine, or share, with no server.
export const SESSION_KEY = "p3-session";
export const WIDGETS_KEY = "p3-widgets";
const VERSION = 2;

export interface SavedWidget { id: string; name: string; source: string; controls?: { id: string; label: string }[]; createdAt: number; origin?: "authored" | "imported"; }

// A stable content hash of a widget's source — the IDENTITY used for the trust registry (Item 2/C). Trust follows the
// CODE, not a mutable flag: authoring (or consenting to) a source trusts that exact text, so re-importing identical
// source is already trusted, and any edit re-gates. FNV-1a 32-bit → 8-hex; collision-resistant enough for a local
// allow-list of a user's own widgets (not a security primitive against a crafted preimage — it gates accidental
// auto-execution of FOREIGN code, paired with the sandbox/worker bounds that already contain every widget).
export function widgetHash(source: string): string {
  let h = 0x811c9dc5;
  const s = String(source);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
// Dataset IDENTITY guard: a session/annotation is bound to a dataset's shape. `n` is decisive (annotation codes are
// cell-indexed — they only align to a store with the same cell count); `fields` is informational (a view may colour by
// a field a different dataset lacks). Used to refuse applying authored data to the wrong/changed dataset.
export interface Fingerprint { n: number; fields: string[]; }
// A serialized annotation layer (the working draft + any sources): per-cell codes + label names + CAP records. This is
// AUTHORED data (not a recompute), so it's materialized in full.
export interface SerAnnoLayer { name: string; source: string; categories: string[]; codes: number[]; records?: any; provenance?: any; }
// The agent CONVERSATION — the chat log. `messages` is the agent's raw context (bounded ~40 turns; lets the agent
// CONTINUE after reopen) and `history` is the user-visible timeline/docked-chat cards. Part of "the session" → saved.
export interface SerConversation { messages: any[]; history: any[]; }
// `store` scopes the session to its DATASET — a session saved for one store must NOT be restored onto another (it would
// clobber the new dataset's view with a stale colorBy/scope/widget). Restore only when the store matches.
export interface SessionDoc { v: number; store: string; fingerprint?: Fingerprint; currentWS: string; colorBy: string; canvas: any[]; userWS: { name: string; ws: any }[]; annotation?: SerAnnoLayer[]; conversation?: SerConversation; catColors?: Record<string, [number, number, number]>; style?: Record<string, any>; }

export function serializeSession(d: { store: string; fingerprint?: Fingerprint; currentWS: string; colorBy: string; canvas: any[]; userWS: { name: string; ws: any }[]; annotation?: SerAnnoLayer[]; conversation?: SerConversation; catColors?: Record<string, [number, number, number]>; style?: Record<string, any> }): string {
  return JSON.stringify({ v: VERSION, store: d.store, fingerprint: d.fingerprint, currentWS: d.currentWS, colorBy: d.colorBy, canvas: d.canvas, userWS: d.userWS, annotation: d.annotation, conversation: d.conversation, catColors: d.catColors, style: d.style });
}
// Tolerant parse: anything malformed / from an older version → null (start fresh, never throw on boot).
export function parseSession(raw: string | null): SessionDoc | null {
  if (!raw) return null;
  try { const o = JSON.parse(raw); if (!o || o.v !== VERSION || !Array.isArray(o.canvas)) return null;
    return { v: o.v, store: String(o.store || ""), fingerprint: parseFingerprint(o.fingerprint), currentWS: String(o.currentWS || ""), colorBy: String(o.colorBy || ""), canvas: o.canvas, userWS: Array.isArray(o.userWS) ? o.userWS : [], annotation: parseAnnotation(o.annotation), conversation: parseConversation(o.conversation), catColors: (o.catColors && typeof o.catColors === "object") ? o.catColors : undefined, style: (o.style && typeof o.style === "object") ? o.style : undefined };
  } catch { return null; }
}
function parseConversation(c: any): SerConversation | undefined {
  if (!c || (!Array.isArray(c.messages) && !Array.isArray(c.history))) return undefined;
  return { messages: Array.isArray(c.messages) ? c.messages : [], history: Array.isArray(c.history) ? c.history : [] };
}
function parseFingerprint(f: any): Fingerprint | undefined {
  if (!f || typeof f.n !== "number") return undefined;
  return { n: f.n, fields: Array.isArray(f.fields) ? f.fields.map(String) : [] };
}
function parseAnnotation(a: any): SerAnnoLayer[] | undefined {
  if (!Array.isArray(a)) return undefined;
  const out = a.filter((L: any) => L && typeof L.name === "string" && Array.isArray(L.categories) && Array.isArray(L.codes))
    .map((L: any) => ({ name: String(L.name), source: String(L.source || "derived"), categories: L.categories.map(String), codes: L.codes as number[], records: L.records, provenance: L.provenance }));
  return out.length ? out : undefined;
}

// ---- the portable session DOCUMENT: a self-contained file (session state + the widget library it references) ----
export const BUNDLE_KIND = "pagoda-session";
export function serializeBundle(d: { session: SessionDoc; widgets: SavedWidget[]; savedAt: number }): string {
  return JSON.stringify({ kind: BUNDLE_KIND, v: VERSION, savedAt: d.savedAt, session: d.session, widgets: d.widgets }, null, 2);
}
export function parseBundle(raw: string | null): { session: SessionDoc; widgets: SavedWidget[]; savedAt: number } | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw); if (!o || o.kind !== BUNDLE_KIND) return null;
    const session = parseSession(JSON.stringify(o.session)); if (!session) return null;
    return { session, widgets: loadWidgets(JSON.stringify(o.widgets ?? [])), savedAt: Number(o.savedAt) || 0 };
  } catch { return null; }
}
// Compare a doc's fingerprint against the live dataset's. Returns a human reason when they DON'T align (so the caller
// can warn / refuse cell-indexed restore), or null when they match (or can't be compared — older docs have none).
export function fingerprintMismatch(doc?: Fingerprint, live?: Fingerprint): string | null {
  if (!doc || !live) return null;
  if (doc.n !== live.n) return `different dataset — ${doc.n.toLocaleString()} cells in the session vs ${live.n.toLocaleString()} loaded`;
  const missing = doc.fields.filter((f) => !live.fields.includes(f));
  if (missing.length) return `some saved fields aren't in this dataset: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "…" : ""}`;
  return null;
}

// Upsert an authored widget into the library by NAME (re-saving the same name updates its source). Pure → returns a
// new array. `now`/`id` are passed in so the caller controls timestamping (and tests stay deterministic).
export function upsertWidget(list: SavedWidget[], w: { name: string; source: string; controls?: { id: string; label: string }[]; origin?: "authored" | "imported" }, now: number, id: string): SavedWidget[] {
  const name = (w.name || "Widget").trim();
  const i = list.findIndex((x) => x.name === name);
  const entry: SavedWidget = { id: i >= 0 ? list[i].id : id, name, source: w.source, controls: w.controls, createdAt: i >= 0 ? list[i].createdAt : now, origin: w.origin ?? (i >= 0 ? list[i].origin : undefined) };
  const out = list.slice();
  if (i >= 0) out[i] = entry; else out.push(entry);
  return out;
}

export function loadWidgets(raw: string | null): SavedWidget[] {
  if (!raw) return [];
  try { const o = JSON.parse(raw); const arr = Array.isArray(o) ? o : o?.widgets; return Array.isArray(arr) ? arr.filter((w: any) => w && typeof w.source === "string") : []; } catch { return []; }
}
