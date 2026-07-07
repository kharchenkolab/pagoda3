// Shared intake tail: turn a parsed DatasetSpec into a ready in-memory L* store. Every local reader (.h5ad,
// 10x .h5, 10x mtx triplet) parses its own format into a spec, then hands off here — so QC, the counts-only
// embedding, marker precompute, the load-checklist and the provenance note are written ONCE and behave the same
// regardless of source. `(spec as any).__unnamed` (set by a reader when a file carries no gene/cell names) is
// surfaced in the notes.
import { writeStore, type DatasetSpec } from "../../../../lstar/js/core/writer.ts";
import type { LstarStore } from "./store.ts";
import type { OpenProgress } from "../ui/loading.ts";
import { MemStore } from "./localstore.ts";
import { applyQCFilter, type QCReport } from "../compute/qc.ts";

const EMBED_LIMIT = 30000;   // in-browser PCA+UMAP is tuned up to ~this many cells; beyond it, gate (overridable)

/** An already-OPENED L* store with no embedding → a DatasetSpec `finalizeSpec` can compute a layout for.
 *  Reads `counts` (transposing CSR→CSC via the shared kernel, since computeEmbedding is gene-major CSC) plus
 *  every per-cell label / numeric field, remapped onto the standard `cells`/`genes` axes finalizeSpec expects.
 *  Only called for a bare store (no embedding) — the full-counts read is the unavoidable cost of laying it out. */
export async function storeToSpec(ds: any): Promise<DatasetSpec> {
  const cf = ds.field("counts");
  if (!cf || (cf.span?.length ?? 0) !== 2) throw new Error("This store has no 2-D `counts` measure, so a layout can't be computed for it.");
  const [cellAx, geneAx] = cf.span as [string, string];
  const cells = await ds.axisLabels(cellAx), genes = await ds.axisLabels(geneAx);
  const ncells = cells.length, ngenes = genes.length;
  const sp = await ds.fieldAsCsc("counts");   // dense/csr/csc → gene-major CSC (what computeEmbedding needs); the lstar reader single-sources the densify/transpose (was: crash on a dense measure, hand-rolled CSR transpose)
  const spec: any = {
    kind: "sample",
    axes: { cells: { labels: cells, role: "observation" }, genes: { labels: genes, role: "feature" } },
    fields: { counts: { role: "measure", span: ["cells", "genes"], encoding: "csc", state: cf.state ?? "raw", shape: [ncells, ngenes], data: sp.data, indices: sp.indices, indptr: sp.indptr } },
  };
  // carry over the store's PER-CELL fields (labels to colour by; numeric QC measures) onto the `cells` axis
  for (const nm of ds.fieldNames()) {
    if (nm === "counts") continue;
    const f = ds.field(nm);
    if (!f || f.role === "embedding" || (f.span?.length ?? 0) !== 1 || f.span[0] !== cellAx) continue;   // per-cell only
    try {
      if (f.encoding === "categorical") { const c = await ds.fieldCategorical(nm); spec.fields[nm] = { role: "label", span: ["cells"], encoding: "utf8", values: Array.from(c.codes, (k: number) => (k >= 0 ? c.categories[k] : "")) }; }
      else if (f.encoding === "utf8") spec.fields[nm] = { role: "label", span: ["cells"], encoding: "utf8", values: await ds.fieldStrings(nm) };
      else if (f.encoding === "dense") spec.fields[nm] = { role: f.role || "measure", span: ["cells"], encoding: "dense", shape: [ncells], data: (await ds.fieldDense(nm)).data };
    } catch { /* skip an unreadable field rather than fail the whole open */ }
  }
  return spec;
}

/** spec → in-memory L* store: compute a layout if the file has none (QC → PCA → UMAP → Louvain → markers),
 *  precompute marker navigators, and record a provenance note. `progress` drives the load checklist. */
export async function finalizeSpec(spec: DatasetSpec, progress?: OpenProgress, opts: { force?: boolean } = {}): Promise<LstarStore> {
  const force = !!opts.force;
  const hasEmbedding = Object.values(spec.fields).some((x) => (x as any).role === "embedding");
  if (!spec.fields.counts && !hasEmbedding) throw new Error("No count matrix or embedding found in this file.");
  // Declare the WHOLE checklist upfront (the plan is known once parsed) so the card shows every row from the
  // start and just ticks each from pending → active → done — no expanding list. 'present' = read from the file.
  const cf0: any = spec.fields.counts;
  // A scaled / z-scored expression matrix (negative values) is NOT a valid basis for variable genes or markers —
  // lstar's prep trusts a measure literally named "counts" and would produce degenerate/misleading stats. Fail loud
  // (overridable): re-export with raw counts, or "Try it anyway" to browse the embedding + metadata.
  if (cf0 && cf0.state === "scaled" && !force)
    throw Object.assign(new Error(
      "This file's expression matrix is scaled / z-scored (it has negative values) and carries no raw counts " +
      "(no layers['counts']) — pagoda3 needs raw counts or log-normalized values to compute variable genes and markers. " +
      "Re-export with raw counts in layers['counts'] (or .raw), or open anyway to browse the embedding + metadata (gene statistics will be unreliable)."),
      { overridable: true });
  const labelsNow = Object.entries(spec.fields).filter(([, x]) => (x as any).role === "label" && (x as any).encoding === "utf8").map(([k]) => k);
  const clusteringNow = labelsNow.filter((n) => /leiden|louvain|cluster|cell.?type|annotation/i.test(n));
  const willEmbed = !hasEmbedding && !!cf0;
  if (cf0) progress?.step("counts", "Count matrix", "present", `${Number(cf0.shape[0]).toLocaleString()} cells × ${Number(cf0.shape[1]).toLocaleString()} genes`);
  if (hasEmbedding) {
    progress?.step("embed", "Embedding", "present");
    if (clusteringNow.length) progress?.step("clusters", "Clusters", "present", clusteringNow[0]);
  } else if (cf0) {
    progress?.step("qc", "Quality filter", "pending");
    progress?.step("embed", "Compute embedding", "pending");
    progress?.step("clusters", "Cluster cells", "pending");
  }
  if (cf0 && (clusteringNow.length || willEmbed)) progress?.step("markers", "Marker genes", "pending");
  // A counts-only file (no obsm/UMAP/PCA) can't be plotted as-is — compute an embedding in-browser so it opens.
  // Gated by cell count: above the limit, in-browser PCA+UMAP would hang the tab — say so plainly.
  let computed: { nHVG: number; pcaDim: number; nClusters: number } | null = null;
  let qcReport: QCReport | null = null;
  if (!hasEmbedding && spec.fields.counts) {
    const cf: any = spec.fields.counts; let [ncells, ngenes] = cf.shape as [number, number];
    if (ncells > EMBED_LIMIT && !force)   // gate on the ORIGINAL count (cheap reject before any work)
      throw Object.assign(new Error(`This file has ${ncells.toLocaleString()} cells and no embedding, so a layout must be computed in the browser. ` +
        `That's tuned for up to ~${EMBED_LIMIT.toLocaleString()} cells — beyond it it may be slow or run the tab out of memory. ` +
        `On a machine with plenty of RAM you can try anyway; otherwise precompute the layout (scanpy sc.pp.pca + sc.tl.umap, or pagoda3) and reopen.`),
        { overridable: true });
    // Basic QC: DROP cells with < 200 detected genes and genes seen in < 3 cells (scanpy tutorial defaults), so the
    // computed layout isn't distorted by empty droplets / debris. Notify how many + why (checklist detail + notes).
    if (progress?.signal?.aborted) throw Object.assign(new Error("Cancelled"), { aborted: true });
    progress?.step("qc", "Quality filter", "active");
    qcReport = applyQCFilter(spec, 200, 3);
    if (qcReport && !qcReport.skipped) [ncells, ngenes] = cf.shape as [number, number];   // matrix shrank → embed on the kept cells/genes
    const qcDetail = qcReport?.skipped
      ? `kept as-is — too few cells pass (${qcReport.keptCells.toLocaleString()} ≥ ${qcReport.minGenes} genes)`
      : qcReport && (qcReport.droppedCells || qcReport.droppedGenes)
        ? `dropped ${qcReport.droppedCells.toLocaleString()} cells, ${qcReport.droppedGenes.toLocaleString()} genes`
        : `all ${ncells.toLocaleString()} cells passed`;
    progress?.step("qc", "Quality filter", "done", qcDetail);
    const { computeEmbedding } = await import("../compute/embed.ts");   // lazy — code-splits umap-js out of the main bundle
    const emb = await computeEmbedding({ data: cf.data, indices: cf.indices, indptr: cf.indptr }, ncells, ngenes, { progress });
    spec.axes.emb_umap = { labels: ["umap1", "umap2"], role: "coordinate" };
    spec.fields.umap = { role: "embedding", span: ["cells", "emb_umap"], encoding: "dense", shape: [ncells, 2], data: emb.umap } as any;
    const clus: string[] = new Array(ncells);
    for (let i = 0; i < ncells; i++) clus[i] = "c" + emb.clusters[i];
    spec.fields.clusters = { role: "label", span: ["cells"], encoding: "utf8", values: clus } as any;
    computed = { nHVG: emb.nHVG, pcaDim: emb.pcaDim, nClusters: emb.nClusters };
  }
  progress?.stage("Building in-memory store…");
  const store = new MemStore();
  await writeStore(store, spec);
  // Precompute the viewer's marker/stats navigators for the clustering grouping(s) so the Markers dot-plot works
  // natively (a dragged file carries no markers_<g>). Best-effort — the file still opens if this fails.
  let markersFor: string[] = [];
  try {
    const labelFields = Object.entries(spec.fields).filter(([, x]) => (x as any).role === "label" && (x as any).encoding === "utf8").map(([k]) => k);
    const clusteringLike = labelFields.filter((n) => /leiden|louvain|cluster|cell.?type|annotation/i.test(n));
    const groupings = clusteringLike.length ? clusteringLike : labelFields.slice(0, 1);
    if (groupings.length && spec.fields.counts && cf0.state !== "scaled") {   // scaled basis (force-opened) → skip: markers/HVG would be degenerate
      if (progress?.signal?.aborted) throw Object.assign(new Error("Cancelled"), { aborted: true });
      progress?.step("markers", "Marker genes", "active");
      const { extendForViewer } = await import("../../../../lstar/js/core/extend.ts");
      await extendForViewer(store as any, { groupings });
      markersFor = groupings;
      progress?.step("markers", "Marker genes", "done", groupings.join(", "));
    }
  } catch (e) { console.warn("[pagoda3] marker precompute skipped:", (e as any)?.message); }
  // provenance note for the load log — what was assumed/computed (vs. read from the file)
  const un = (spec as any).__unnamed || {};
  const nameWarn = un.genes
    ? `⚠ this file has NO gene names (gene labels are just 0,1,2,…) — genes are shown by index. ${un.cells ? "It also has no cell barcodes. " : ""}`
    : un.cells ? `⚠ this file has no cell barcodes (cell labels are 0,1,2,…). ` : "";
  const qcNote = qcReport?.skipped
    ? `QC filter skipped (too few cells clear the ${qcReport.minGenes}-gene threshold — opened unfiltered). `
    : qcReport && (qcReport.droppedCells || qcReport.droppedGenes)
      ? `QC: dropped ${qcReport.droppedCells.toLocaleString()} cells (< ${qcReport.minGenes} genes) + ${qcReport.droppedGenes.toLocaleString()} genes (< ${qcReport.minCells} cells), leaving ${qcReport.keptCells.toLocaleString()} × ${qcReport.keptGenes.toLocaleString()}. `
      : qcReport ? `QC: all cells passed (≥ ${qcReport.minGenes} genes). ` : "";
  (store as any).__notes = nameWarn + (computed
    ? `${qcNote}no embedding in the file → computed a default layout: library-size normalize → log1p → ${computed.nHVG} variable genes → PCA (${computed.pcaDim} PCs) → Louvain (${computed.nClusters} clusters) → UMAP${markersFor.length ? " → 1-vs-rest markers" : ""}. Standard defaults — recompute or adjust anytime.`
    : `read the file's own embedding${markersFor.length ? `; precomputed markers for ${markersFor.join(", ")}` : ""}.`);
  return store;
}
