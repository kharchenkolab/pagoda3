# pagoda3 store prep — write_viewer precomputes the *global* navigators the viewer opens with, on
# top of an lstar dataset. Viewer *policy* (which summaries to precompute) lives in pagoda3, not in
# lstar; the heavy reduction runs on lstar's shared kernel (lstar::col_sum_by_group). Mirrors the
# Python pagoda3.write_viewer field-for-field.

.viewer_markers <- function(cnt, grand, lab, nc, ng) {
  groups <- sort(unique(lab)); K <- length(groups)
  code <- as.integer(factor(lab, levels = groups)) - 1L
  gs <- lstar::col_sum_by_group(cnt, code, K, TRUE)             # shared libstar kernel
  S  <- matrix(gs$sum,    nrow = K, byrow = TRUE)
  SS <- matrix(gs$sumsq,  nrow = K, byrow = TRUE)
  NE <- matrix(gs$n_expr, nrow = K, byrow = TRUE)
  nper <- as.integer(table(factor(lab, levels = groups)))
  lfc <- vapply(seq_len(K), function(g) S[g, ] / max(nper[g], 1) -
                  (grand - S[g, ]) / max(nc - nper[g], 1), numeric(ng))           # genes x groups
  padj <- pmin(pmax(exp(-abs(lfc * sqrt(t(NE) + 1))), 1e-12), 1)
  list(groups = groups, S = S, SS = SS, NE = NE, lfc = lfc, padj = padj)
}

#' Add the `viewer@0.1` profile (navigator fields) to an L* dataset for the pagoda3 viewer.
#'
#' Precomputes per-annotation cluster stats + ranked marker tables (one set for each label in
#' `c(grouping, also)`), a whole-dataset `od_score` (overdispersion vs the smoothed mean-variance
#' trend), a cluster-coherent `cell_order`, and `counts_cellmajor` (counts in cell-major / CSR
#' orientation). Scope-dependent work (selection DE, subset HVG) is left to the viewer's on-the-fly
#' compute. Recomputes & overwrites same-named fields, so the profile can't go stale.
#'
#' @param ds an `lstar_dataset` (a counts measure + one or more grouping labels over cells).
#' @param grouping the primary cell label to summarize by (default `"leiden"`).
#' @param counts name of the raw counts measure (default `"counts"`).
#' @param also additional annotation labels to also precompute stats + markers for (e.g. `"cell_type"`).
#' @return `ds` with the viewer profile added (`viewer@0.1` in `ds$profiles`).
#' @export
write_viewer <- function(ds, grouping = "leiden", counts = "counts", also = character(0)) {
  if (is.null(ds$fields[[counts]])) stop("write_viewer: no counts measure '", counts, "'")
  if (is.null(ds$fields[[grouping]])) stop("write_viewer: no grouping field '", grouping, "'")
  cnt <- methods::as(ds$fields[[counts]]$values, "CsparseMatrix")
  nc <- nrow(cnt); ng <- ncol(cnt)
  Xl <- cnt; Xl@x <- log1p(Xl@x)
  grand <- Matrix::colSums(Xl)

  ds$fields[["counts_cellmajor"]] <- list(role = "measure", span = c("cells", "genes"),
                                           state = "raw", encoding = "csr", values = methods::as(cnt, "RsparseMatrix"))
  plab <- as.character(ds$fields[[grouping]]$values)
  ds$fields[["cell_order"]] <- list(role = "measure", span = "cells", state = "permutation",
                                     values = order(as.integer(factor(plab, levels = sort(unique(plab)))),
                                                    method = "radix") - 1L)

  gm <- grand / nc
  Xl2 <- Xl; Xl2@x <- Xl@x^2
  gv <- pmax(Matrix::colSums(Xl2) / nc - gm^2, 0)
  ok <- gm > 0 & gv > 0 & is.finite(gm) & is.finite(gv)
  od <- rep(0, ng)
  if (sum(ok) > 10) {
    fit <- stats::loess(y ~ x, data = data.frame(x = log(gm[ok]), y = log(gv[ok])), span = 0.3, degree = 2)
    od[ok] <- log(gv[ok]) - as.numeric(stats::predict(fit))
  }
  od[!is.finite(od)] <- 0
  ds$fields[["od_score"]] <- list(role = "measure", span = "genes", values = od)

  for (gp in unique(c(grouping, also))) {
    if (is.null(ds$fields[[gp]])) next
    mk <- .viewer_markers(cnt, grand, as.character(ds$fields[[gp]]$values), nc, ng)
    gax <- paste0("groups_", gp); sg <- c(gax, "genes")
    ds$axes[[gax]] <- list(labels = mk$groups, origin = "derived", role = "feature")
    ds$fields[[paste0("stats_", gp, "_sum")]]   <- list(role = "measure", span = sg, values = mk$S)
    ds$fields[[paste0("stats_", gp, "_sumsq")]] <- list(role = "measure", span = sg, values = mk$SS)
    ds$fields[[paste0("stats_", gp, "_nexpr")]] <- list(role = "measure", span = sg, values = mk$NE)
    ds$fields[[paste0("markers_", gp, "_lfc")]]  <- list(role = "measure", span = c("genes", gax), values = mk$lfc)
    ds$fields[[paste0("markers_", gp, "_padj")]] <- list(role = "measure", span = c("genes", gax), values = mk$padj)
  }

  if (!("viewer@0.1" %in% ds$profiles)) ds$profiles <- c(ds$profiles, "viewer@0.1")
  if (!methods::is(ds, "lstar_dataset")) class(ds) <- "lstar_dataset"
  ds
}
