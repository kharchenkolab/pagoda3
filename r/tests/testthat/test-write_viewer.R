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
                    "od_score", "cell_order", "counts_cellmajor") %in% names(ds$fields)))
  expect_true("groups_cell_type" %in% names(ds$axes))
  expect_false("od_genes" %in% names(ds$axes))

  Xl <- cnt; Xl@x <- log1p(Xl@x); groups <- sort(unique(lab))
  ref <- t(sapply(groups, function(g) Matrix::colSums(Xl[lab == g, , drop = FALSE])))
  expect_lt(max(abs(ds$fields$stats_leiden_sum$values - ref)), 1e-6)

  expect_equal(ds$fields$counts_cellmajor$encoding, "csr")
  expect_equal(max(abs(as.matrix(ds$fields$counts_cellmajor$values) - as.matrix(cnt))), 0)

  p <- file.path(tempdir(), "p3.lstar.zarr"); if (dir.exists(p)) unlink(p, recursive = TRUE)
  lstar::lstar_write(ds, p); ds2 <- lstar::lstar_read(p)
  expect_true(all(c("counts_cellmajor", "stats_leiden_sum") %in% names(ds2$fields)))
})
