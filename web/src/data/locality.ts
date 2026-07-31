// How a cell set sits in the STORED row order, and what that implies about how to read it.
//
// `counts_cellmajor` is written in a locality order — cluster code first, then a Hilbert index over the
// embedding — so whether a group is cheap to read has nothing to do with how many cells it has and
// everything to do with whether those cells land next to each other in the file. Cells side by side cost
// ONE coalesced range request for the whole block; cells scattered through the file cost one request
// each, which is what produces "Failed to fetch" on a real selection.
//
// Measured on a 13,533-cell store, two sets of almost identical size:
//   a lassoed region of the embedding  1,500 cells ->    40 runs   (compact: the Hilbert order keeps it together)
//   imported per-cell donor labels     1,504 cells -> 1,333 runs   (orthogonal to the order: ~one run per cell)
// Three orders of magnitude apart, and computable with no I/O at all — which is what makes it usable as a
// decision rule rather than something to discover by timing out.
//
// Pure functions, no store: the plan is arithmetic over data already in memory.

/** Each cell's physical row in the reordered field, or null when the field is in canonical cell order. */
export type RowOrder = ArrayLike<number> | null;

/** Maximal runs of CONSECUTIVE physical rows that `cells` occupy — i.e. how many coalesced range reads
 *  it takes to fetch them. `posOf` null means the field is in cell order, so a cell IS its row. */
export function runCount(cells: ArrayLike<number>, posOf: RowOrder): number {
  const n = cells.length;
  if (!n) return 0;
  const rows = new Int32Array(n);
  for (let i = 0; i < n; i++) { const c = cells[i]; rows[i] = posOf ? Number(posOf[c]) : c; }
  rows.sort();
  let runs = 1;
  for (let i = 1; i < n; i++) if (rows[i] !== rows[i - 1] + 1) runs++;
  return runs;
}

export interface ReadPlanOpts {
  /** Request-count ceiling for reading a grouping outright. Beyond this, one-request-per-cell dominates. */
  maxRuns?: number;
  /** How many cells the SAMPLED path would read. Doubles as the byte budget for the exact path: if
   *  reading the whole grouping is no more data than the sample would be, there is no reason to sample. */
  sampleCells?: number;
}

export interface ReadPlan {
  /** `read` = fetch every labelled cell, statistics are EXACT. `sample` = estimate, and say so. */
  mode: "read" | "sample";
  /** Coalesced range requests reading the whole grouping would take. */
  runs: number;
  /** Labelled cells in the grouping (unlabelled cells carry no statistics). */
  cells: number;
  /** Why this mode — for the log and for the panel's caption. */
  reason: string;
}

/** Decide how to compute a grouping's sufficient statistics, from its layout alone. No I/O.
 *
 *  Read it outright when that is BOTH few enough requests and no more data than a sample would be.
 *  The second condition is what stops a grouping that covers most of the dataset from qualifying just
 *  because it is contiguous — "read every cell of a full partition" is the whole-matrix pass this tier
 *  exists to avoid.
 *
 *  Decided per GROUPING, not per group: a grouping with some compact groups and some scattered ones
 *  takes the sampled path for all of them, so every row of one table is computed the same way rather
 *  than silently mixing exact and estimated rows.
 */
export function planGroupStats(codes: ArrayLike<number>, posOf: RowOrder, opts: ReadPlanOpts = {}): ReadPlan {
  const maxRuns = opts.maxRuns ?? 512;
  const sampleCells = opts.sampleCells ?? 6000;
  const labelled: number[] = [];
  for (let i = 0; i < codes.length; i++) if (codes[i] >= 0) labelled.push(i);
  const cells = labelled.length;
  if (!cells) return { mode: "read", runs: 0, cells: 0, reason: "no labelled cells" };
  const runs = runCount(labelled, posOf);
  if (cells > sampleCells)
    return { mode: "sample", runs, cells, reason: `${cells.toLocaleString()} cells is more than the ${sampleCells.toLocaleString()}-cell sample budget` };
  if (runs > maxRuns)
    return { mode: "sample", runs, cells, reason: `${cells.toLocaleString()} cells scattered over ${runs.toLocaleString()} blocks of the store` };
  return { mode: "read", runs, cells, reason: `${cells.toLocaleString()} cells in ${runs.toLocaleString()} contiguous blocks` };
}
