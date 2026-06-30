// Gene-set ENRICHMENT (over-representation analysis, ORA): is a query gene list — DE hits, a cluster's markers, a manual
// list — over-represented in any pathway's genes vs a background universe? Hypergeometric upper tail per pathway +
// Benjamini-Hochberg FDR across the tested pathways. Pure (no DOM / data deps) → node-testable. Pathway sets come from
// the bundled Reactome asset (web/public/genesets/reactome_human.json, CC0). See docs (gene-set sourcing).

// log-Gamma (Lanczos g=607/128) → log-factorial → log-binomial, so the hypergeometric tail stays stable at genome N.
const LG = 607 / 128;
const LC = [0.99999999999999709182, 57.156235665862923517, -59.597960355475491248, 14.136097974741747174, -0.49191381609762019978, 0.33994649984811888699e-4, 0.46523628927048575665e-4, -0.98374475304879564677e-4, 0.15808870322491248884e-3, -0.21026444172410488319e-3, 0.21743961811521264320e-3, -0.16431810653676389022e-3, 0.84418223983852743293e-4, -0.26190838401581408670e-4, 0.36899182659531622704e-5];
function lgamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = LC[0]; for (let i = 1; i < 15; i++) x += LC[i] / (z + i);
  const t = z + LG + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
const lfact = (n: number) => lgamma(n + 1);
const lchoose = (n: number, k: number) => (k < 0 || k > n) ? -Infinity : lfact(n) - lfact(k) - lfact(n - k);

// P(X >= k) for X ~ Hypergeometric(N population, K successes in population, n draws). Upper tail summed in linear space
// (terms are small probabilities); lchoose keeps each term from overflowing.
export function hyperUpperTail(k: number, n: number, K: number, N: number): number {
  const lo = Math.max(0, n + K - N), hi = Math.min(n, K);
  if (k <= lo) return 1; if (k > hi) return 0;
  const lDen = lchoose(N, n); let p = 0;
  for (let i = k; i <= hi; i++) p += Math.exp(lchoose(K, i) + lchoose(N - K, n - i) - lDen);
  return Math.min(1, p);
}

export interface PathwaySet { id: string; name: string; genes: string[]; }
export interface EnrichRow { id: string; name: string; k: number; m: number; n: number; N: number; p: number; fdr: number; fold: number; genes: string[]; }

// ORA: `query` symbols vs `pathways`, both intersected with `universe` (the measured + annotated background — the right
// N is the genes you COULD have detected, not the whole genome). minK gates noise (need ≥2 overlapping genes by default).
export function enrich(query: string[], pathways: PathwaySet[], universe: Set<string>, opts?: { minK?: number }): EnrichRow[] {
  const minK = opts?.minK ?? 2;
  const N = universe.size;
  const Q = new Set(query.filter((g) => universe.has(g))); const n = Q.size;
  const rows: EnrichRow[] = [];
  if (!n || !N) return rows;
  for (const pw of pathways) {
    let m = 0; const hit: string[] = [];
    for (const g of pw.genes) { if (!universe.has(g)) continue; m++; if (Q.has(g)) hit.push(g); }
    const k = hit.length; if (k < minK || !m) continue;
    rows.push({ id: pw.id, name: pw.name, k, m, n, N, p: hyperUpperTail(k, n, m, N), fold: (k / n) / (m / N), genes: hit.sort(), fdr: 1 });
  }
  // Benjamini-Hochberg: sort by p asc, q_i = min over j>=i of p_j * M / j  (enforced via the running min from the tail)
  rows.sort((a, b) => a.p - b.p); const M = rows.length; let prev = 1;
  for (let i = M - 1; i >= 0; i--) { prev = Math.min(prev, rows[i].p * M / (i + 1)); rows[i].fdr = prev; }
  return rows;
}

// ---- enrichment of a RANKED gene list (a DE / marker result), with the background COUPLED to that test ----
// A DE result already carries every TESTED gene (subsampleDE ranks the contender set) with per-gene means, so the right
// background is exactly those genes detected above a floor — NOT a global constant. We pick the query by thresholding the
// SAME ranking (top-N by effect size), split by direction so an up-pathway and a down-pathway don't cancel.
export interface RankedGene { symbol: string; lfc?: number; meanA?: number; meanB?: number; score?: number; }
export interface EnrichResult { direction: "up" | "down" | "all" | "ranked"; n: number; N: number; topN: number; rows: EnrichRow[]; }

export function enrichRanked(ranked: RankedGene[], pathways: PathwaySet[], geneSpace: Set<string>, opts?: { topN?: number; direction?: "up" | "down" | "both" | "ranked"; minDetect?: number }): EnrichResult[] {
  const topN = opts?.topN ?? 200, minDetect = opts?.minDetect ?? 0;
  // background = the TESTED genes detected above the floor (max group mean, or the score for unsigned lists), restricted
  // to the annotated space — the "world that could be a hit", so genes too sparsely observed to rank never enter it.
  // When the ranking carries NO expression signal at all (a marker/vs-rest table that omits means), we can't apply a
  // detection floor, so the tested set is every ranked gene ∩ annotated (still excludes the un-annotated and un-ranked).
  const hasDetect = ranked.some((g) => g.meanA != null || g.meanB != null || g.score != null);
  const universe = new Set<string>();
  for (const g of ranked) {
    if (!geneSpace.has(g.symbol)) continue;
    if (!hasDetect) { universe.add(g.symbol); continue; }
    if (Math.max(g.meanA ?? 0, g.meanB ?? 0, g.score ?? 0) > minDetect) universe.add(g.symbol);
  }
  // "ranked" = honour the INPUT order (the gene table's current sort) — top-N as the user staged it, no re-sort. Else
  // split a signed list up/down by logFC; an unsigned list is "all" (also input order).
  const signed = ranked.some((g) => g.lfc != null);
  const dirs: EnrichResult["direction"][] = opts?.direction === "ranked" ? ["ranked"] : !signed ? ["all"] : opts?.direction === "up" ? ["up"] : opts?.direction === "down" ? ["down"] : ["up", "down"];
  const out: EnrichResult[] = [];
  for (const d of dirs) {
    let q = ranked;
    if (d === "up") q = ranked.filter((g) => (g.lfc ?? 0) > 0).slice().sort((a, b) => (b.lfc! - a.lfc!));
    else if (d === "down") q = ranked.filter((g) => (g.lfc ?? 0) < 0).slice().sort((a, b) => (a.lfc! - b.lfc!));
    const query = q.slice(0, topN).map((g) => g.symbol);   // "ranked"/"all" → q is the input order untouched
    const n = query.filter((s) => universe.has(s)).length;
    out.push({ direction: d, n, N: universe.size, topN, rows: enrich(query, pathways, universe, { minK: 2 }) });
  }
  return out;
}
