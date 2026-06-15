// scType-style marker scoring (Ianevski et al., Nat Commun 2022) — a cluster-level, in-browser variant.
// Cheap and transparent: from per-group mean expression (which the viewer already computes), z-score each
// gene ACROSS groups (its specificity signal), then for each group score every cell type as
// (Σ positive z − Σ negative z) / √(#markers present). Assign each group its top-scoring type. PURE.

export interface MarkerIdx { positive: number[]; negative: number[] }   // gene INDICES (caller resolves symbols)

// z-score each gene's mean across groups. groupMean is [G × nGenes] row-major. Returns same shape.
export function zscoreByGroup(groupMean: Float32Array, G: number, nGenes: number): Float32Array {
  const z = new Float32Array(G * nGenes);
  for (let j = 0; j < nGenes; j++) {
    let sum = 0; for (let g = 0; g < G; g++) sum += groupMean[g * nGenes + j];
    const mu = sum / G;
    let ss = 0; for (let g = 0; g < G; g++) { const d = groupMean[g * nGenes + j] - mu; ss += d * d; }
    const sd = Math.sqrt(ss / G);
    if (sd < 1e-9) continue;   // constant gene → z stays 0 (uninformative)
    for (let g = 0; g < G; g++) z[g * nGenes + j] = (groupMean[g * nGenes + j] - mu) / sd;
  }
  return z;
}

export interface ScoreRow { group: number; ranked: { cellType: string; score: number }[] }

// Score every cell type for every group from the z-scored means. markers values hold gene indices already
// filtered to those present in the dataset (caller drops missing symbols).
export function scoreClusters(z: Float32Array, G: number, nGenes: number, markers: Record<string, MarkerIdx>): ScoreRow[] {
  const types = Object.keys(markers);
  const out: ScoreRow[] = [];
  for (let g = 0; g < G; g++) {
    const base = g * nGenes;
    const ranked = types.map((ct) => {
      const { positive, negative } = markers[ct];
      let pos = 0; for (const j of positive) pos += z[base + j];
      let neg = 0; for (const j of negative) neg += z[base + j];
      const nPresent = Math.max(1, positive.length + negative.length);
      return { cellType: ct, score: (pos - neg) / Math.sqrt(nPresent) };
    }).sort((a, b) => b.score - a.score);
    out.push({ group: g, ranked });
  }
  return out;
}

// Per group: the winning cell type, its score, and the margin to the runner-up (confidence proxy).
export interface Assignment { group: number; cellType: string; score: number; margin: number }
export function assignClusters(rows: ScoreRow[]): Assignment[] {
  return rows.map((r) => ({
    group: r.group,
    cellType: r.ranked[0]?.cellType ?? "Unknown",
    score: r.ranked[0]?.score ?? 0,
    margin: (r.ranked[0]?.score ?? 0) - (r.ranked[1]?.score ?? 0),
  }));
}
