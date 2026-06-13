#!/usr/bin/env Rscript
# 6-sample RPCA integration (GSE192391 PBMC, Seurat v5) -> L* viewer store.
# Robust to field-name variation (UMAP / clusters / sample): detect, adapt to the canonical schema,
# print what was found, and only run the expensive write_viewer once umap+leiden are confirmed present.
suppressMessages({ library(Seurat); library(SeuratObject); library(lstar); library(pagoda3) })

SRC <- "/Users/peter.kharchenko/.aba/runtime/projects/prj_8143327c/work/ana_e92634df/seurat_integrated.rds"
OUT <- "/Users/peter.kharchenko/pagoda/pagoda3/web/public/pbmc6.lstar.zarr"

o <- readRDS(SRC)
try(suppressWarnings({
  if ("scale.data" %in% SeuratObject::Layers(o[["RNA"]])) o[["RNA"]]$scale.data <- NULL
}), silent = TRUE)

ds <- read_seurat(o)
message("read_seurat: ", length(ds$axes), " axes, ", length(ds$fields), " fields")
message("FIELDS: ", paste(names(ds$fields), collapse = ", "))

mv <- function(from, to) if (!is.null(ds$fields[[from]]) && from != to) {
  ds$fields[[to]] <<- ds$fields[[from]]; ds$fields[[from]] <<- NULL
}

# UMAP: rename a umap-like embedding field to "umap"
if (is.null(ds$fields[["umap"]])) {
  cand <- grep("umap", names(ds$fields), ignore.case = TRUE, value = TRUE)
  pref <- cand[grepl("integrat", cand, ignore.case = TRUE) & !grepl("unintegrat", cand, ignore.case = TRUE)]   # integrated, NOT unintegrated
  nm <- if (length(pref)) pref[[1]] else if (length(cand)) cand[[1]] else NULL
  if (!is.null(nm)) {
    f <- ds$fields[[nm]]; f$span <- c("cells", "umap")
    ds$fields[["umap"]] <- f; ds$fields[[nm]] <- NULL
    if (!is.null(ds$axes[[nm]])) { ds$axes[["umap"]] <- ds$axes[[nm]]; ds$axes[[nm]] <- NULL }
    message("umap <- ", nm)
  }
}

# clusters -> leiden (categorical)
if (is.null(ds$fields[["leiden"]])) {
  cl <- NULL
  for (nm in c("integrated_clusters", "seurat_clusters")) if (!is.null(ds$fields[[nm]])) { cl <- nm; break }
  if (is.null(cl)) { snn <- grep("snn_res", names(ds$fields), value = TRUE); if (length(snn)) cl <- snn[[1]] }
  if (!is.null(cl)) {
    ds$fields[["leiden"]] <- list(role = "label", span = "cells", values = as.character(ds$fields[[cl]]$values))
    message("leiden <- ", cl)
  }
}

# cell-type annotation -> cell_type (Seurat objects name it variously; here it's cluster_label)
if (is.null(ds$fields[["cell_type"]])) {
  for (nm in c("cluster_label", "celltype", "cell.type", "CellType", "annotation", "predicted.id")) if (!is.null(ds$fields[[nm]])) {
    ds$fields[["cell_type"]] <- list(role = "label", span = "cells", values = as.character(ds$fields[[nm]]$values))
    message("cell_type <- ", nm); break
  }
}

# sample: prefer an existing "sample", else orig.ident
if (is.null(ds$fields[["sample"]]) && !is.null(ds$fields[["orig.ident"]]))
  ds$fields[["sample"]] <- list(role = "label", span = "cells", values = as.character(ds$fields[["orig.ident"]]$values))

mv("percent.mt", "mito"); mv("nCount_RNA", "n_umi"); mv("nFeature_RNA", "n_gene")

# condition := sample if absent (6 donors, n=1 per "condition" -> the cacoa caveat, on real data)
if (!is.null(ds$fields[["sample"]]) && is.null(ds$fields[["condition"]]))
  ds$fields[["condition"]] <- list(role = "label", span = "cells", values = as.character(ds$fields[["sample"]]$values))

# prune what the viewer doesn't use
for (nm in c("X", "scale.data", "orig.ident", "pca", "integrated.cca", "integrated.rpca", "rpca")) ds$fields[[nm]] <- NULL
for (nm in names(ds$fields)) if (grepl("_loadings$", nm)) ds$fields[[nm]] <- NULL
for (ax in c("pca", "integrated.cca", "integrated.rpca", "rpca")) ds$axes[[ax]] <- NULL

if (is.null(ds$fields[["umap"]]) || is.null(ds$fields[["leiden"]])) {
  message("ABORT: missing umap or leiden after adaptation. fields: ", paste(names(ds$fields), collapse = ", "))
  quit(status = 2)
}
has_ct <- !is.null(ds$fields[["cell_type"]])
message("cell_type present: ", has_ct, " | sample levels: ",
        if (!is.null(ds$fields[["sample"]])) length(unique(ds$fields[["sample"]]$values)) else 0)

ds <- if (has_ct) {
  pagoda3::write_viewer(ds, grouping = "leiden", also = "cell_type")
} else {
  pagoda3::write_viewer(ds, grouping = "leiden")
}
message("final fields: ", paste(names(ds$fields), collapse = ", "))
message("cells x genes: ", length(ds$axes$cells$labels), " x ", length(ds$axes$genes$labels),
        " | clusters: ", length(ds$axes$groups_leiden$labels))

lstar_write(ds, OUT)
message("wrote ", OUT)
