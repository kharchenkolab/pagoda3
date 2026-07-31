// How an ESTIMATED result says so. One place, because the same computation used to be labelled when the
// agent produced it ("vs rest · approx") and unlabelled when the UI did, and marker tables had no notion
// of it at all.
//
// A result is estimated when its statistics came from a sample of the cells rather than all of them —
// which happens only for a grouping the store's row order scatters (see data/locality.ts). Mean, fraction
// and log-fold-change converge on more cells: they are the same quantity, measured less precisely. A
// count-dependent significance surrogate does not — a sampled one reads as "less significant" when the
// truth is "fewer cells were measured" — so the compute layer emits NaN for it rather than a number whose
// meaning shifted, and everything downstream has to render that as absent, not as zero or as one.

export interface StatsQuality {
  /** true when the statistics came from a sample of the cells. */
  approx: boolean;
  /** cells in the grouping. */
  cells?: number;
  /** cells actually read. */
  measured?: number;
}

/** The suffix a panel caption carries when its numbers are estimated — "" when they are exact.
 *  Says how much was measured, because "approx" alone doesn't tell anyone whether to trust it. */
export function approxNote(q: StatsQuality | null | undefined): string {
  if (!q?.approx) return "";
  const { measured, cells } = q;
  if (typeof measured === "number" && typeof cells === "number" && cells > 0)
    return `estimated · ${measured.toLocaleString()} of ${cells.toLocaleString()} cells`;
  return "estimated";
}

/** Append the estimated-note to an existing caption without producing a stray separator. */
export function withApproxNote(cap: string | undefined, q: StatsQuality | null | undefined): string {
  const note = approxNote(q);
  if (!note) return cap ?? "";
  return cap ? `${cap} · ${note}` : note;
}

/** A significance value is PLOTTABLE only if it is a finite number in (0, 1]. NaN means "not measured"
 *  (a sampled table), and 0 would take -log10 to Infinity. Callers must check before scaling an axis:
 *  `NaN ?? 1` is NaN — the nullish default does NOT catch it, which is how a blank column becomes a
 *  circle at cy="NaN". */
export function isPlottableP(padj: unknown): padj is number {
  return typeof padj === "number" && Number.isFinite(padj) && padj > 0 && padj <= 1;
}

/** A significance value as a table cell: "—" when it wasn't measured. */
export function significanceText(padj: unknown): string {
  if (!isPlottableP(padj)) return "—";
  return padj < 0.001 ? padj.toExponential(1) : padj.toFixed(3);
}
