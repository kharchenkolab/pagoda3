# pagoda3 store prep (R) — write_viewer precomputes the *global* navigators the viewer opens with.
# The navigator computation is general-purpose, so it lives in lstar (lstar::extend_for_viewer, on the
# shared C++ core) and is byte-identical to the Python/JS preps and the browser's live compute. pagoda3
# keeps only the policy (which annotations to summarize); this is a thin wrapper.

#' Add the `viewer@0.1` profile (navigator fields) to an L* dataset for the pagoda3 viewer.
#'
#' Thin policy wrapper over [lstar::extend_for_viewer()] (the shared recipe): precomputes per-annotation
#' cluster stats + 1-vs-rest marker tables for `c(grouping, also)`, a whole-dataset `od_score`, and a
#' cluster-contiguous cell-major `counts_cellmajor` (+ its `counts_cellmajor_order`). Scope-dependent
#' work (selection DE, subset HVG) is left to the viewer's on-the-fly compute.
#'
#' @param ds an `lstar_dataset` (a counts measure + one or more grouping labels over cells).
#' @param grouping the primary cell label to summarize by (default `"leiden"`).
#' @param counts name of the raw counts measure (default `"counts"`).
#' @param also additional annotation labels to also precompute stats + markers for (e.g. `"cell_type"`).
#' @return `ds` with the viewer profile added (`viewer@0.1` in `ds$profiles`).
#' @export
write_viewer <- function(ds, grouping = "leiden", counts = "counts", also = character(0)) {
  lstar::extend_for_viewer(ds, grouping = grouping, also = also, counts = counts)
}
