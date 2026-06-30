// Gene-set COLLECTION REGISTRY for the viewer (over-representation input). A "collection" is a (source, organism,
// split) gene-set library — e.g. Reactome/human, GO:BP/human, a BYO .gmt. A small manifest (public/genesets/index.json)
// lists what's available; each collection is a lazy gzipped asset fetched ON FIRST USE and parsed once, cached by id —
// never on page load. The geneSpace (union of all set genes) is the "annotated" universe an enrichment background
// intersects with. Everything is SYMBOL-keyed (no ID/ortholog layer). See enrich.ts (the ORA engine) + build_genesets.mjs.
import type { PathwaySet } from "./enrich.ts";

export interface GeneSetDB { id: string; label: string; source: string; organism: string; split?: string; pathways: PathwaySet[]; geneSpace: Set<string>; nPathways: number; }
// A manifest entry — enough to populate the picker + locate the asset. `custom` marks a session-imported .gmt (Phase D).
export interface Collection { id: string; label: string; source: string; organism: string; split?: string; license?: string; file?: string; nPathways?: number; nGenes?: number; custom?: boolean; }

// Pure parse (testable): the {pathways:{id:{name,genes}}} doc → arrays + the union gene space. `meta` (the manifest
// entry) supplies id/label/source/split; the doc's own fields are the fallback so a bare asset still loads.
export function parseGeneSetDoc(raw: string | any, meta?: Partial<Collection>): GeneSetDB {
  const o = typeof raw === "string" ? JSON.parse(raw) : raw;
  const pathways: PathwaySet[] = [];
  const geneSpace = new Set<string>();
  for (const [id, p] of Object.entries<any>(o.pathways || {})) {
    const genes: string[] = Array.isArray(p.genes) ? p.genes.map(String) : [];
    if (!genes.length) continue;
    pathways.push({ id, name: String(p.name || id), genes });
    for (const g of genes) geneSpace.add(g);
  }
  const source = String(meta?.source || o.source || "Reactome");
  const organism = String(meta?.organism || o.organism || "human");
  return {
    id: String(meta?.id || o.id || `${source.toLowerCase()}_${organism}`),
    label: String(meta?.label || o.label || source),
    source, organism, split: meta?.split ?? o.split ?? undefined,
    pathways, geneSpace, nPathways: pathways.length,
  };
}

// Back-compat: with no index.json present, assume the one bundled Reactome-human asset (the pre-registry world).
const DEFAULT_MANIFEST: Collection[] = [{ id: "reactome_human", label: "Reactome", source: "Reactome", organism: "human", license: "CC0", file: "reactome_human.json" }];

// Same-origin asset root = Vite's configured base, so /genesets resolves under a SUBPATH deploy (e.g. /peterk/pagoda3/).
// Dev base "/" → "" → /genesets; built with --base=/peterk/pagoda3/ → /peterk/pagoda3/genesets. Empty in node tests.
const ASSET_BASE = ((((import.meta as any).env?.BASE_URL) as string) || "/").replace(/\/$/, "");

let manifestP: Promise<Collection[]> | null = null;
// Session-imported collections (Phase D, BYO .gmt) live here — not in the manifest, merged into listCollections.
const custom = new Map<string, GeneSetDB>();

export function loadManifest(base = ASSET_BASE): Promise<Collection[]> {
  if (!manifestP) {
    manifestP = fetch(`${base}/genesets/index.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((o) => (Array.isArray(o?.collections) ? (o.collections as Collection[]) : DEFAULT_MANIFEST))
      .catch(() => DEFAULT_MANIFEST);
  }
  return manifestP;
}

// The picker's source of truth: bundled collections (optionally filtered to an organism) + any session-imported ones.
export function listCollections(filter?: { organism?: string }, base = ASSET_BASE): Promise<Collection[]> {
  return loadManifest(base).then((all) => {
    const bundled = filter?.organism ? all.filter((c) => c.organism === filter.organism) : all;
    const customCs: Collection[] = [...custom.values()].map((d) => ({ id: d.id, label: d.label, source: d.source, organism: d.organism, split: d.split, nPathways: d.nPathways, nGenes: d.geneSpace.size, custom: true }));
    return [...bundled, ...customCs];
  });
}

// Fetch a collection's JSON text. The committed asset is GZIPPED (<file>.gz) and inflated in the browser via the native
// DecompressionStream — the same "compressed static, decompress client-side" model as the zarr chunks, so it needs no
// host gzip config and works on any dumb static host. The gzip magic-byte check (1f 8b) also makes it correct if a host
// transparently Content-Encodes the file (the browser already inflated → just decode); falls back to the raw <file>.
async function fetchCollectionText(base: string, file: string): Promise<string> {
  if (typeof DecompressionStream !== "undefined") {
    const r = await fetch(`${base}/genesets/${file}.gz`);
    if (r.ok) {
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
      return new TextDecoder().decode(buf);   // a host already inflated it (Content-Encoding) → these are the JSON bytes
    }
  }
  const r2 = await fetch(`${base}/genesets/${file}`);   // fall back to the raw .json (no DecompressionStream, or no .gz)
  if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
  return r2.text();
}

const cache = new Map<string, Promise<GeneSetDB>>();
// Load one collection by id (manifest-bundled or session-custom). Cached; a failure isn't cached so a retry can succeed.
export function loadCollection(id: string, base = ASSET_BASE): Promise<GeneSetDB> {
  if (custom.has(id)) return Promise.resolve(custom.get(id)!);
  let p = cache.get(id);
  if (!p) {
    p = loadManifest(base)
      .then((all) => {
        const c = all.find((x) => x.id === id) || DEFAULT_MANIFEST.find((x) => x.id === id);
        if (!c || !c.file) throw new Error(`unknown gene-set collection "${id}"`);
        return fetchCollectionText(base, c.file).then((raw) => parseGeneSetDoc(raw, c));
      })
      .catch((e) => { cache.delete(id); throw e; });
    cache.set(id, p);
  }
  return p;
}

// Register a session-imported collection (Phase D). Returns its id. Held in memory; the host persists it in the session.
export function registerCustomCollection(db: GeneSetDB): string { custom.set(db.id, db); return db.id; }
export function customCollections(): GeneSetDB[] { return [...custom.values()]; }
export function clearCustomCollections(): void { custom.clear(); }

// Parse a .gmt (each line: name \t description \t gene1 \t gene2 …) into a custom GeneSetDB. SYMBOL-only; a .gmt carries
// no organism, so the caller supplies the dataset's. id is namespaced "custom:<slug>" so it never collides with bundled.
export function parseGmt(text: string, opts: { name: string; organism?: string }): GeneSetDB {
  const pathways: PathwaySet[] = [];
  const geneSpace = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line[0] === "#") continue;
    const cols = line.split("\t");
    const name = (cols[0] || "").trim(); if (!name) continue;
    const genes = cols.slice(2).map((g) => g.trim()).filter(Boolean);   // col0 = name, col1 = description, rest = genes
    if (!genes.length) continue;
    pathways.push({ id: name, name, genes });
    for (const g of genes) geneSpace.add(g);
  }
  const slug = opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "set";
  return { id: `custom:${slug}`, label: opts.name, source: "Custom", organism: opts.organism || "human", pathways, geneSpace, nPathways: pathways.length };
}

// Serialize / restore the in-memory custom collections for the session document (so a BYO .gmt survives a reload).
export function serializeCustomCollections(): any[] {
  return customCollections().map((d) => ({ id: d.id, label: d.label, source: d.source, organism: d.organism, split: d.split, pathways: Object.fromEntries(d.pathways.map((p) => [p.id, { name: p.name, genes: p.genes }])) }));
}
export function restoreCustomCollections(arr?: any[] | null): void {
  if (!Array.isArray(arr)) return;
  for (const o of arr) { try { registerCustomCollection(parseGeneSetDoc(o, { id: o.id, label: o.label, source: o.source || "Custom", organism: o.organism, split: o.split })); } catch { /* skip malformed */ } }
}
