// Lazy loader for the bundled gene-set asset (web/public/genesets/reactome_<organism>.json — CC0, built by
// server/build_genesets.mjs). Fetched ON FIRST USE (an enrichment query), parsed once, cached per organism — never on
// page load. The geneSpace (union of all pathway genes) is the "annotated" universe an enrichment background intersects
// with. See enrich.ts (the ORA engine) + docs (gene-set sourcing / delivery model).
import type { PathwaySet } from "./enrich.ts";

export interface GeneSetDB { source: string; organism: string; pathways: PathwaySet[]; geneSpace: Set<string>; nPathways: number; }

// Pure parse (testable): the {pathways:{id:{name,genes}}} doc → arrays + the union gene space.
export function parseGeneSetDoc(raw: string): GeneSetDB {
  const o = JSON.parse(raw);
  const pathways: PathwaySet[] = [];
  const geneSpace = new Set<string>();
  for (const [id, p] of Object.entries<any>(o.pathways || {})) {
    const genes: string[] = Array.isArray(p.genes) ? p.genes.map(String) : [];
    if (!genes.length) continue;
    pathways.push({ id, name: String(p.name || id), genes });
    for (const g of genes) geneSpace.add(g);
  }
  return { source: String(o.source || "Reactome"), organism: String(o.organism || "human"), pathways, geneSpace, nPathways: pathways.length };
}

const cache = new Map<string, Promise<GeneSetDB>>();
// `base` lets a test/host point elsewhere; default is the app origin (vite serves /public at /).
export function loadGeneSets(organism = "human", base = ""): Promise<GeneSetDB> {
  let p = cache.get(organism);
  if (!p) {
    p = fetch(`${base}/genesets/reactome_${organism}.json`)
      .then((r) => { if (!r.ok) throw new Error(`no gene sets for ${organism} (HTTP ${r.status})`); return r.text(); })
      .then(parseGeneSetDoc)
      .catch((e) => { cache.delete(organism); throw e; });   // don't cache a failure → a later retry can succeed
    cache.set(organism, p);
  }
  return p;
}
