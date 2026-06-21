// Pure heuristic that buckets a dataset's fields by ROLE, so the agent picks the right field for the right slot —
// the DATA analog of describe_panel. groupings() is authoritative for "can be a Heatmap grouping / has markers";
// the remaining categoricals read as COVARIATES (the facet / scope / pseudobulk-replicate dimensions); numeric fields
// are colour/threshold inputs; genes are their own namespace. A name that looks like a donor/sample id is flagged as
// the likely biological REPLICATE (for pseudobulk). A role the agent SET via set_field_roles overrides the heuristic.
export type FieldRole = "annotation" | "partition" | "covariate" | "qc";

export interface FieldBuckets {
  groupings: { name: string; n: number }[];
  covariates: { name: string; n: number; replicate?: boolean }[];
  numeric: string[];
  geneCount: number;
  replicate?: string;   // the covariate that looks like the biological replicate (donor/sample) — the natural pseudobulk unit
}

// Does a field NAME denote the unit of biological replication (so pseudobulk knows its default replicate)? Split on
// separators AND camelCase ("PatientID" → patient/id, "orig.ident" → orig/ident) so a replicate token is matched whole.
const REPLICATE_WORDS = new Set(["sample", "samples", "donor", "donors", "patient", "patients", "subject", "subjects", "individual", "individuals", "replicate", "replicates", "biosample", "specimen", "ident"]);
export function looksLikeReplicate(name: string): boolean {
  const toks = name.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^a-zA-Z]+/).filter(Boolean).map((s) => s.toLowerCase());
  return toks.some((t) => REPLICATE_WORDS.has(t));
}

export function fieldBuckets(
  groupings: string[],
  categoricals: { name: string; n: number }[],
  numeric: string[],
  geneCount: number,
  roleOf?: (f: string) => FieldRole | undefined,
): FieldBuckets {
  const grpSet = new Set(groupings);
  // A field is a grouping if it has markers (groupings()) OR the agent classified it as a clustering/annotation.
  const isGrouping = (f: string) => grpSet.has(f) || roleOf?.(f) === "partition" || roleOf?.(f) === "annotation";
  const covs = categoricals.filter((c) => !isGrouping(c.name)).map((c) => looksLikeReplicate(c.name) ? { ...c, replicate: true } : { name: c.name, n: c.n });
  return {
    groupings: categoricals.filter((c) => isGrouping(c.name)).map((c) => ({ name: c.name, n: c.n })),
    covariates: covs,
    numeric,
    geneCount,
    replicate: covs.find((c) => (c as any).replicate)?.name,
  };
}
