// Choose the viewer-prep count measure by CONTENT/STATE, not the literal field name "counts" — so a
// converter that named its raw matrix "X" or a modality is still preppable, and a count-less file
// fails with a clear message. This mirrors lstar's Python/R `viewer._select_counts_basis` exactly; it
// lives HERE (not imported from lstar) so pagoda3's prep is self-contained and doesn't depend on an
// lstar internal. (lstar owns its own copy for its `extendForViewer`.)
//
// Returns { field, log1p }: `log1p` is true for a RAW basis (kernels log1p it), false for a LOGNORM
// basis (values used as-is → stats are var-of-lognorm, not var-of-log1p(counts)).

export interface CountsBasis { field: string; log1p: boolean; }

// Just the slice of an lstar dataset this needs — structural, so there's no lstar type dependency.
interface FieldLike { role?: string; span?: string[]; state?: string }
interface DatasetLike { fieldNames(): string[]; field(name: string): FieldLike | undefined }

export function selectCountsBasis(ds: DatasetLike, opts: { counts?: string; basis?: string } = {}): CountsBasis {
  const { counts, basis } = opts;
  const twod = ds.fieldNames().filter((n) => {
    const f = ds.field(n);
    return !!f && f.role === "measure" && Array.isArray(f.span) && f.span.length === 2 && String(f.span[0]).startsWith("cells");
  });
  const present = twod.map((n) => `${n}[${ds.field(n)!.state ?? "?"}]`).join(", ") || "(none)";

  if (counts != null) {
    const f = ds.field(counts);
    if (!f) throw new Error(`prep: counts="${counts}" is not a measure (present cells×genes measures: ${present})`);
    return { field: counts, log1p: basis !== "lognorm" && f.state !== "lognorm" };
  }
  if (basis === "lognorm") {
    const pick = twod.find((n) => ds.field(n)!.state === "lognorm") ?? twod.find((n) => ["X", "data", "logcounts"].includes(n));
    if (!pick) throw new Error(`prep: basis="lognorm" but no log-normalized measure found (present: ${present})`);
    return { field: pick, log1p: false };
  }
  const pick = (twod.includes("counts") ? "counts" : undefined) ?? twod.find((n) => ds.field(n)!.state === "raw");
  if (pick) return { field: pick, log1p: true };
  throw new Error(
    `prep: not viewer-optimizable — no raw counts measure found (present cells×genes measures: ${present}). ` +
    `Pass counts=<field>, provide a raw-counts measure, or basis="lognorm" to prep from a log-normalized measure.`);
}
