// Dependency-free sanity checks for a REMOTE `.lstar.zarr` store — the sibling of h5adcheck.ts, which
// does this for the local .h5ad intake. Same philosophy: catch a store that is genuinely broken with a
// clear message, flag a degraded-but-usable one so the viewer explains itself, and never fail the open
// over either. Kept pure (plain descriptors in, issues out) so the hostile cases are unit-testable
// without a server — the bug that motivated this survived a 72-test suite because its fake was more
// cooperative than the real thing.
//
// Three independent classes, cheapest first:
//   contract      — metadata only, free: is this shaped like a viewer store the app can actually use?
//   nnz agreement — one small read (indptr) against declared shapes: is the store internally consistent?
//   reachability  — can the server actually deliver each array's full extent? (see expectedChunkBytes)

export type StoreIssue = {
  level: "error" | "warn";
  code: string;
  message: string;
};

const err = (code: string, message: string): StoreIssue => ({ level: "error", code, message });
const warn = (code: string, message: string): StoreIssue => ({ level: "warn", code, message });

export interface FieldSpec {
  encoding?: string;
  span?: string[];
  role?: string;
  shape?: number[];
  provenance?: Record<string, unknown> | null;
}

export interface StoreSpec {
  fields: Record<string, FieldSpec>;
  axes: string[];
}

/** The count basis — the field a gene column is read from. `extend_for_viewer` stamps it
 *  `provenance.viewer = "basis"`; stores prepped before that stamp fall back to the field named
 *  `counts`. The name is NOT always `counts`: a store with no raw measure is prepped from e.g.
 *  `logcounts`, and resolving by name alone reports a defect on a perfectly good store. */
export function findBasis(spec: StoreSpec): { name: string; field: FieldSpec } | null {
  for (const [name, f] of Object.entries(spec.fields)) {
    if ((f.provenance as any)?.viewer === "basis") return { name, field: f };
  }
  const c = spec.fields["counts"];
  return c ? { name: "counts", field: c } : null;
}

/** Contract checks over METADATA ONLY — no reads, so this can run synchronously at open.
 *
 *  Mirrors, on the read side, what lstar's `validate._check_viewer_profile` enforces on the write side.
 *  A store that trips these still opens: the viewer degrades (it derives gene columns from the
 *  cell-major copy, for one) and the caller surfaces the message so the user knows to re-prep.
 *  `viewerProfile` gates the checks that only make sense for a prepped store. */
export function checkViewerContract(spec: StoreSpec, viewerProfile = true): StoreIssue[] {
  const out: StoreIssue[] = [];
  const basis = findBasis(spec);
  if (!basis) {
    out.push(err("no-basis", "No count basis: no measure is stamped provenance.viewer='basis' and there is no field named `counts`. Gene expression cannot be read."));
    return out;                                            // everything below is relative to the basis
  }
  const span = basis.field.span ?? [];
  const cellAxis = span[0] ?? "cells", geneAxis = span[1] ?? "genes";
  if (basis.field.encoding !== "csc") {
    out.push(warn("basis-not-gene-major",
      `The count basis \`${basis.name}\` is ${basis.field.encoding ?? "of unknown encoding"}, not csc (gene-major), so a gene column is not a byte range. ` +
      "Colouring by a gene and the dotplot's subset recompute fall back to the cell-major copy — correct, but they load the whole matrix. Re-run the viewer prep."));
  }
  if (!viewerProfile) return out;

  const cm = spec.fields["counts_cellmajor"];
  if (!cm) {
    out.push(warn("no-cellmajor", "No `counts_cellmajor`: per-cell reads and on-the-fly compute recompute from the basis each session."));
  } else if (cm.encoding !== "csr" || (cm.span ?? []).join() !== [cellAxis, geneAxis].join()) {
    out.push(err("cellmajor-orientation",
      `\`counts_cellmajor\` must be csr over [${cellAxis}, ${geneAxis}]; got ${cm.encoding} over [${(cm.span ?? []).join(", ")}]. Reading it as cell-major would return the wrong axis.`));
  }

  // stats are GROUP-major [<g>, genes]; markers are GENE-major [genes, <g>]. The two orientations are
  // deliberately different and load-bearing — a transposed table reads as plausible numbers, not an error.
  for (const [name, f] of Object.entries(spec.fields)) {
    const st = /^stats_(.+)_(sum|sumsq|nexpr)$/.exec(name);
    if (st) {
      const s = f.span ?? [];
      if (s.length !== 2 || s[1] !== geneAxis || s[0] === geneAxis)
        out.push(err("stats-orientation", `\`${name}\` must be group-major [<${st[1]}>, ${geneAxis}]; got [${s.join(", ")}].`));
      continue;
    }
    const mk = /^markers_(.+)_(lfc|padj)$/.exec(name);
    if (mk) {
      const s = f.span ?? [];
      if (s.length !== 2 || s[0] !== geneAxis || s[1] === geneAxis)
        out.push(err("markers-orientation", `\`${name}\` must be gene-major [${geneAxis}, <${mk[1]}>]; got [${s.join(", ")}]. Markers are gene-major — do not transpose.`));
    }
  }

  // a summarized grouping needs all three stat tables and its induced axis, or the reader mis-shapes it
  const groupings = new Set(Object.keys(spec.fields)
    .map((n) => /^stats_(.+)_sum$/.exec(n)?.[1]).filter((g): g is string => !!g));
  for (const g of groupings) {
    for (const part of ["sumsq", "nexpr"]) {
      if (!spec.fields[`stats_${g}_${part}`]) out.push(err("stats-incomplete", `\`stats_${g}_sum\` exists but \`stats_${g}_${part}\` is missing.`));
    }
    if (!spec.axes.includes(`groups_${g}`)) out.push(err("stats-no-axis", `\`stats_${g}_*\` exists but the \`groups_${g}\` axis does not, so its rows cannot be labelled.`));
  }
  return out;
}

export interface ArrayMeta {
  dataType?: string;
  shape?: number[];
  chunkShape?: number[];
  codecs?: string[];
}

const WIDTH: Record<string, number> = {
  int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4,
  int64: 8, uint64: 8, float32: 4, float64: 8,
};

/** Exact on-disk byte length of an array's SINGLE chunk, or null when it isn't computable.
 *
 *  Only uncompressed, single-chunk arrays qualify: compression makes the stored size unpredictable and
 *  sharding splits it across objects. That is not a narrow case — the viewer prep writes the gene-major
 *  basis exactly this way ON PURPOSE, so a gene column is an exact byte range with no decode. It is
 *  therefore the one array in a viewer store big enough to trip a per-object size limit anywhere in the
 *  serving path, and the only one whose true length a client can verify. */
export function expectedChunkBytes(meta: ArrayMeta): number | null {
  const n = meta.shape?.[0];
  const w = meta.dataType ? WIDTH[meta.dataType] : undefined;
  if (!Number.isFinite(n as number) || !w || (meta.shape ?? []).length !== 1) return null;
  if (meta.chunkShape?.[0] !== n) return null;                       // multi-chunk: no single object to size
  const codecs = meta.codecs ?? [];
  if (codecs.some((c) => c !== "bytes")) return null;                // compressed / sharded
  return (n as number) * w;
}

/** Compare the size a server DECLARES for an array's chunk against the size its own metadata implies.
 *
 *  The failure this exists for: a proxy, cache, or CDN that serves a truncated object while reporting a
 *  self-consistent (but invented) length. Nothing derived from the response alone can detect that — the
 *  Content-Length matched the bytes delivered, and a range past the end returned a genuine 416. Only
 *  `shape × itemsize` from the array's own metadata disagrees. A real occurrence served 16,777,216 bytes
 *  of an 87,822,584-byte array; downstream it surfaced as an opaque WASM abort. */
export function shortReadIssue(path: string, expected: number, declared: number | null | undefined): StoreIssue | null {
  if (declared === null || declared === undefined || !Number.isFinite(declared)) return null;   // server said nothing — can't tell
  if (declared === expected) return null;
  const pct = ((100 * declared) / expected).toFixed(1);
  if (declared < expected) {
    return err("short-object", `\`${path}\` is truncated in transit: the server serves ${declared.toLocaleString()} bytes of ${expected.toLocaleString()} (${pct}%). ` +
      "The file itself may be intact — a cache or proxy in the path is capping it. Computed results from this store would be silently wrong.");
  }
  return warn("oversized-object", `\`${path}\` is ${declared.toLocaleString()} bytes where its metadata implies ${expected.toLocaleString()}.`);
}

/** `indptr`'s last entry must equal the declared nnz of `data`/`indices`. One small read plus metadata —
 *  catches a store whose arrays disagree with each other without reading the matrix. */
export function nnzMismatch(field: string, indptrEnd: number, declaredNnz: number): StoreIssue | null {
  if (!Number.isFinite(indptrEnd) || !Number.isFinite(declaredNnz)) return null;
  if (indptrEnd === declaredNnz) return null;
  return err("nnz-mismatch",
    `\`${field}\` is inconsistent: indptr ends at ${indptrEnd.toLocaleString()} but data declares ${declaredNnz.toLocaleString()} nonzeros.`);
}

/** One line per issue, worst first — for the banner and the load log. */
export function summarize(issues: StoreIssue[]): string {
  const order = { error: 0, warn: 1 };
  return [...issues].sort((a, b) => order[a.level] - order[b.level]).map((i) => `${i.level === "error" ? "✕" : "⚠"} ${i.message}`).join("\n");
}
