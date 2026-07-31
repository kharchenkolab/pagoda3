# pagoda3::write_viewer builds the navigator fields via lstar's shared kernel; mirrors the Python
# test so the two runtimes stay in lockstep.
test_that("write_viewer adds navigators; stats kernel-exact; panel = counts re-oriented", {
  skip_if_not_installed("Matrix")
  skip_if_not_installed("lstar")
  set.seed(7); nc <- 140L; ng <- 22L
  cnt <- as(Matrix::Matrix(rpois(nc * ng, 0.7), nc, ng, sparse = TRUE), "CsparseMatrix")
  rownames(cnt) <- paste0("cell", 1:nc); colnames(cnt) <- paste0("g", 1:ng)
  lab <- paste0("k", (0:(nc - 1)) %% 5); ct <- paste0("t", (0:(nc - 1)) %% 3)
  ds <- structure(list(kind = "sample", spec_version = "0.1", profiles = character(0), dropped = character(0),
    axes = list(cells = list(labels = rownames(cnt), origin = "observed", role = "observation"),
                genes = list(labels = colnames(cnt), origin = "observed", role = "feature")),
    fields = list(counts = list(role = "measure", span = c("cells", "genes"), state = "raw", values = cnt),
                  leiden = list(role = "label", span = "cells", values = lab),
                  cell_type = list(role = "label", span = "cells", values = ct))),
    class = "lstar_dataset")

  ds <- pagoda3::write_viewer(ds, grouping = "leiden", also = "cell_type")
  expect_true("viewer@0.1" %in% ds$profiles)
  expect_true(all(c("stats_leiden_sum", "markers_leiden_lfc", "markers_cell_type_lfc",
                    "od_score", "counts_cellmajor_order", "counts_cellmajor") %in% names(ds$fields)))
  expect_true("groups_cell_type" %in% names(ds$axes))
  expect_false("od_genes" %in% names(ds$axes))

  Xl <- cnt; Xl@x <- log1p(Xl@x); groups <- sort(unique(lab))
  ref <- t(sapply(groups, function(g) Matrix::colSums(Xl[lab == g, , drop = FALSE])))
  expect_lt(max(abs(ds$fields$stats_leiden_sum$values - ref)), 1e-6)

  # counts_cellmajor is cell-major CSR, PHYSICALLY reordered cluster-contiguous; reading physical row
  # counts_cellmajor_order[cell] recovers that cell's counts (the locality-reorder convention).
  expect_equal(ds$fields$counts_cellmajor$encoding, "csr")
  pos <- as.integer(ds$fields$counts_cellmajor_order$values) + 1L     # cell -> physical row (1-based)
  expect_setequal(pos, seq_len(nc))                                   # a valid permutation
  cm <- as.matrix(ds$fields$counts_cellmajor$values)
  expect_equal(max(abs(cm[pos, , drop = FALSE] - as.matrix(cnt))), 0)

  p <- file.path(tempdir(), "p3.lstar.zarr"); if (dir.exists(p)) unlink(p, recursive = TRUE)
  lstar::lstar_write(ds, p); ds2 <- lstar::lstar_read(p)
  expect_true(all(c("counts_cellmajor", "stats_leiden_sum") %in% names(ds2$fields)))
})

# --- numeric partitions (parity with py/src/pagoda3/viewer.py) --------------------------------------
# A clustering that arrives as INTEGERS is a `measure` to L*, so lstar's label-role detection skips it.
# On a real Seurat-derived store that meant the one grouping never summarized was the actual clustering.

.numeric_cluster_ds <- function(nc = 120L, ng = 20L, nclust = 5L) {
  set.seed(3)
  cnt <- as(Matrix::Matrix(rpois(nc * ng, 0.7), nc, ng, sparse = TRUE), "CsparseMatrix")
  rownames(cnt) <- paste0("cell", 1:nc); colnames(cnt) <- paste0("g", 1:ng)
  structure(list(kind = "sample", spec_version = "0.1", profiles = character(0), dropped = character(0),
    axes = list(cells = list(labels = rownames(cnt), origin = "observed", role = "observation"),
                genes = list(labels = colnames(cnt), origin = "observed", role = "feature")),
    fields = list(
      counts = list(role = "measure", span = c("cells", "genes"), state = "raw", values = cnt),
      # the clustering, as NUMBERS: role=measure, so lstar's label-role detection cannot see it
      integrated_clusters = list(role = "measure", span = "cells", values = (0:(nc - 1)) %% nclust),
      celltypist = list(role = "label", span = "cells", values = paste0("t", (0:(nc - 1)) %% 3)),
      # a real measure that is integral with few levels — must NOT be claimed as a grouping
      nCount_RNA = list(role = "measure", span = "cells", values = as.numeric(Matrix::rowSums(cnt))))),
    class = "lstar_dataset")
}

test_that("a numeric clustering is detected and does not cost the annotations their stats", {
  ds <- .numeric_cluster_ds()
  expect_equal(pagoda3:::.numeric_partitions(ds), "integrated_clusters")
  ds <- write_viewer(ds)
  expect_true("stats_integrated_clusters_sum" %in% names(ds$fields))
  expect_true("stats_celltypist_sum" %in% names(ds$fields))       # auto-detection survives primary=
  expect_equal(ds$fields[["counts_cellmajor_order"]]$provenance$group, "integrated_clusters")
})

test_that("an explicitly named grouping wins and the clustering rides along", {
  ds <- write_viewer(.numeric_cluster_ds(), "celltypist")
  expect_true("stats_celltypist_sum" %in% names(ds$fields))
  expect_true("stats_integrated_clusters_sum" %in% names(ds$fields))
  expect_equal(ds$fields[["counts_cellmajor_order"]]$provenance$group, "celltypist")
})

test_that(".partition_levels matches the Python policy", {
  f <- pagoda3:::.partition_levels
  expect_equal(f(seq_len(50) %% 7), 7)                       # 0..6 contiguous codes
  expect_equal(f(seq_len(50) %% 7 + 1), 7)                   # 1-based codes (R factors)
  expect_null(f(seq(0, 1, length.out = 50)))                 # fractional -> a score
  expect_null(f(rep(0, 50)))                                 # constant
  expect_null(f(seq_len(500)))                               # per-cell unique -> an id
  expect_null(f(c(1, NA, 2)))                                # non-finite
  expect_null(f(seq_len(50) %% 7, max_card = 3))             # over the cardinality bound
  expect_null(f(c(310, 415, 415, 902, 902, 310)))            # integral but not codes
  expect_equal(f(c(310, 415, 415, 902, 902, 310), "seurat_clusters"), 3)   # ...unless named like one
  expect_null(f(c(0, 1, 3, 3, 0)))                           # gap, unnamed
  expect_equal(f(c(0, 1, 3, 3, 0), "leiden"), 3)             # empty level, rescued by name
})
