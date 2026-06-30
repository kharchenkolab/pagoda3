// Deep-link encoding for shareable views (Phase 3a): a compact session VIEW doc <-> a URL-safe token.
// gzip (native CompressionStream) + base64url keeps a typical view (layout + colouring + colours) to a
// few hundred bytes — well under URL limits. Heavy / cell-indexed state (annotation codes, result rows,
// the chat log, widget source) is intentionally NOT in a view link; that travels via the published
// session doc (?session=<url>) or the portable file export.

async function gzip(s: string): Promise<Uint8Array> {
  const cs = new (globalThis as any).CompressionStream("gzip");
  const stream = new Blob([new TextEncoder().encode(s)]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(u: Uint8Array): Promise<string> {
  const ds = new (globalThis as any).DecompressionStream("gzip");
  const stream = new Blob([u as BlobPart]).stream().pipeThrough(ds);
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

function b64urlEncode(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** Compress a session-doc JSON string into a URL-safe `?view=` token. */
export async function encodeViewToken(json: string): Promise<string> {
  return b64urlEncode(await gzip(json));
}

/** Inverse of {@link encodeViewToken}: a `?view=` token back to the session-doc JSON string. */
export async function decodeViewToken(token: string): Promise<string> {
  return gunzip(b64urlDecode(token));
}
