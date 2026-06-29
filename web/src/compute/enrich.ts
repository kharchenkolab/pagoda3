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
