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

let manifestP: Promise<Collection[]> | null = null;
// Session-imported collections (Phase D, BYO .gmt) live here — not in the manifest, merged into listCollections.
const custom = new Map<string, GeneSetDB>();

export function loadManifest(base = ""): Promise<Collection[]> {
  if (!manifestP) {
    manifestP = fetch(`${base}/genesets/index.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((o) => (Array.isArray(o?.collections) ? (o.collections as Collection[]) : DEFAULT_MANIFEST))
      .catch(() => DEFAULT_MANIFEST);
  }
  return manifestP;
}

// The picker's source of truth: bundled collections (optionally filtered to an organism) + any session-imported ones.
export function listCollections(filter?: { organism?: string }, base = ""): Promise<Collection[]> {
  return loadManifest(base).then((all) => {
    const bundled = filter?.organism ? all.filter((c) => c.organism === filter.organism) : all;
    const customCs: Collection[] = [...custom.values()].map((d) => ({ id: d.id, label: d.label, source: d.source, organism: d.organism, split: d.split, nPathways: d.nPathways, nGenes: d.geneSpace.size, custom: true }));
    return [...bundled, ...customCs];
  });
}

const cache = new Map<string, Promise<GeneSetDB>>();
// Load one collection by id (manifest-bundled or session-custom). Cached; a failure isn't cached so a retry can succeed.
export function loadCollection(id: string, base = ""): Promise<GeneSetDB> {
  if (custom.has(id)) return Promise.resolve(custom.get(id)!);
  let p = cache.get(id);
  if (!p) {
    p = loadManifest(base)
      .then((all) => {
        const c = all.find((x) => x.id === id) || DEFAULT_MANIFEST.find((x) => x.id === id);
        if (!c || !c.file) throw new Error(`unknown gene-set collection "${id}"`);
        return fetch(`${base}/genesets/${c.file}`).then((r) => { if (!r.ok) throw new Error(`no gene sets for ${id} (HTTP ${r.status})`); return r.text(); }).then((raw) => parseGeneSetDoc(raw, c));
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
