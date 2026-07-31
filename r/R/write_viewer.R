# pagoda3 store prep (R) — write_viewer precomputes the *global* navigators the viewer opens with.
# The navigator computation is general-purpose, so it lives in lstar (lstar::extend_for_viewer, on the
# shared C++ core) and is byte-identical to the Python/JS preps and the browser's live compute. pagoda3
# keeps only the policy (which annotations to summarize); this is a thin wrapper.

# Policy constants, mirrored in Python (py/src/pagoda3/viewer.py) and the browser (web/src/anno/roles.ts).
# Keep the three in step: a store prepped by one surface must summarize the same groupings as one
# prepped by another.
.PARTITION_MAX_CARD <- 200
.CLUSTER_NAME_RE <- paste0("(^|[._ -])(clusters?|clustering|leiden|louvain|snn_res|res|kmeans|",
                           "phenograph|metacell|sctype)([._ -]|[0-9]|$)")

# TRUE for a field name that reads like a clustering (`leiden`, `seurat_clusters`, `snn_res.0.8`).
.looks_like_cluster_field <- function(name) grepl(.CLUSTER_NAME_RE, name, ignore.case = TRUE)

# Number of distinct levels if `values` is an integer-coded partition over cells, else NULL.
#
# Integral and low-cardinality is necessary but NOT sufficient: a small-count QC measure (nCount_RNA on
# a shallow library) is also integral with few levels, and summarizing it costs a full stats+markers
# pass for a grouping nothing will use. So require the levels to look like CODES — contiguous and 0- or
# 1-based, which is what every clustering writes — or a name that reads like a clustering, which
# rescues a clustering with an empty level.
.partition_levels <- function(values, name = NULL, max_card = .PARTITION_MAX_CARD) {
  if (!is.numeric(values) || !is.null(dim(values)) || !length(values)) return(NULL)
  if (!all(is.finite(values))) return(NULL)
  if (any(values != round(values))) return(NULL)
  uniq <- sort(unique(as.numeric(values)))
  n <- length(uniq)
  if (n < 2L || n > max_card) return(NULL)
  contiguous <- uniq[1] %in% c(0, 1) && (uniq[n] - uniq[1] + 1) == n
  if (contiguous || (!is.null(name) && .looks_like_cluster_field(name))) n else NULL
}

# Integer-coded numeric cell columns that are really partitions, best candidate first.
#
# A clustering that arrives as NUMBERS — Seurat's `integrated_clusters`, an int64 obs column via
# AnnData — is written by L* as role="measure"/dense, so lstar's label-role grouping detection cannot
# see it. The result is that the one grouping a viewer store fails to summarize is the actual
# clustering, and every cluster-derived category (scType output, a hand-merged annotation) then has no
# summarized base to be derived from. Naming them is pagoda3's policy call, not lstar's recipe.
# Ordered clustering-named first, then by descending level count.
.numeric_partitions <- function(ds, cell_axis = "cells") {
  nm <- character(0); ln <- numeric(0)
  for (name in names(ds$fields)) {
    f <- ds$fields[[name]]
    if (!identical(f$role, "measure")) next
    if (!identical(as.character(f$span), cell_axis)) next
    if (!is.null(f$provenance$cache)) next          # a viewer navigator (od_score, *_order), not data
    n <- .partition_levels(f$values, name)
    if (!is.null(n)) { nm <- c(nm, name); ln <- c(ln, n) }
  }
  if (!length(nm)) return(character(0))
  nm[order(!.looks_like_cluster_field(nm), -ln, nm)]
}

#' Add the `viewer@0.1` profile (navigator fields) to an L* dataset for the pagoda3 viewer.
#'
#' Thin policy wrapper over [lstar::extend_for_viewer()] (the shared recipe): precomputes per-annotation
#' cluster stats + 1-vs-rest marker tables for `c(grouping, also)`, a whole-dataset `od_score`, and a
#' cluster-contiguous cell-major `counts_cellmajor` (+ its `counts_cellmajor_order`). Scope-dependent
#' work (selection DE, subset HVG) is left to the viewer's on-the-fly compute.
#'
#' Numeric partitions are summarized too. A clustering stored as integers is a `measure` to L*, so
#' lstar's label-role detection skips it (correctly — it cannot know a numeric column is a partition);
#' `.numeric_partitions` finds them and they are named explicitly. The best one also becomes lstar's
#' `primary` — the grouping the viewer opens on and the key `counts_cellmajor` is reordered by.
#' `primary` COMPOSES with auto-detection (lstar hoists it to the front of the detected list), so
#' naming a clustering never costs the categorical annotations their stats.
#'
#' @param ds an `lstar_dataset` (a counts measure + one or more grouping labels over cells).
#' @param grouping the primary cell label to summarize by (default `"leiden"`); ignored when absent,
#'   in which case lstar auto-detects the categorical labels.
#' @param counts name of the raw counts measure (default `"counts"`).
#' @param also additional annotation labels to also precompute stats + markers for (e.g. `"cell_type"`).
#' @return `ds` with the viewer profile added (`viewer@0.1` in `ds$profiles`).
#' @export
write_viewer <- function(ds, grouping = "leiden", counts = "counts", also = character(0)) {
  named <- unique(c(grouping, also))
  named <- named[vapply(named, function(g) !is.null(ds$fields[[g]]), logical(1))]
  parts <- .numeric_partitions(ds)
  primary <- if (length(named)) named[1] else if (length(parts)) parts[1] else NULL
  # Name groupings explicitly ONLY when the caller named something: lstar auto-detects the categorical
  # labels when `grouping` is NULL, and handing it a name would silence that — on a store whose
  # clustering is numeric and whose annotations are categorical, naming just the clustering would drop
  # every annotation's stats. `primary` adds the clustering without that cost.
  if (length(named)) {
    lstar::extend_for_viewer(ds, grouping = named[1], also = unique(c(named[-1], setdiff(parts, named))),
                             counts = counts, primary = primary)
  } else {
    lstar::extend_for_viewer(ds, grouping = NULL, counts = counts, primary = primary)
  }
}
