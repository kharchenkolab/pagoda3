// Field-role classification. L* just regularizes AnnData/Seurat, which rarely mark which obs column is a
// cell-type annotation vs a covariate/QC — so we can't read a role from the store. This pre-filter cheaply
// discards the OBVIOUS non-annotations (numeric metrics, id-like high-cardinality columns); whatever is left
// is a "candidate" the AGENT classifies by reading the category values (its strength). Pure + testable.

export type Role = "annotation" | "partition" | "covariate" | "qc" | "candidate";

export interface FieldInfo { name: string; kind: "categorical" | "numeric"; cardinality: number }

// Coarse role from shape alone — deliberately conservative: only call the clearly-mechanical ones, leave the
// genuine ambiguity (covariate vs partition vs annotation, all mid-cardinality) to the agent's value read.
export function prefilterRole(f: FieldInfo, nCells: number, nSamples: number): Role {
  if (f.kind === "numeric") return "qc";                       // continuous metric (mito %, n_genes, score)
  const c = f.cardinality;
  if (c < 2) return "covariate";                               // constant / single value
  if (c >= Math.min(nCells * 0.5, Math.max(50, nSamples * 4))) return "covariate";   // id-like (per-cell barcodes, free text)
  return "candidate";                                          // mid-cardinality categorical → agent decides
}

export function prefilterRoles(fields: FieldInfo[], nCells: number, nSamples: number): { name: string; role: Role }[] {
  return fields.map((f) => ({ name: f.name, role: prefilterRole(f, nCells, nSamples) }));
}

// The fields worth showing the agent for semantic classification (the candidates) — those the pre-filter
// couldn't settle. The agent reads their values and assigns annotation | partition | covariate.
export function candidateFields(fields: FieldInfo[], nCells: number, nSamples: number): string[] {
  return prefilterRoles(fields, nCells, nSamples).filter((r) => r.role === "candidate").map((r) => r.name);
}
