#!/usr/bin/env Rscript
# Real data, pure R: a Seurat v5 integration of two GSE192391 PBMC samples (GSM5746259 +
# GSM5746260) -> an L* viewer store. read_seurat() extracts; write_viewer() (kernel-backed)
# builds the profile; lstar_write() serializes. No Python in the loop.
#
#   Seurat object -> read_seurat -> adapt to the app's canonical names -> write_viewer -> .lstar.zarr
suppressMessages({ library(Seurat); library(SeuratObject); library(lstar) })

SRC <- "/Users/peter.kharchenko/.aba/runtime/projects/prj_ab1b55fe/work/ana_237baddd/seurat_integrated.rds"
OUT <- "/Users/peter.kharchenko/pagoda/pagoda3/web/public/pbmc_integrated.lstar.zarr"

o <- readRDS(SRC)
# drop the dense scale.data layer (not needed by the viewer; avoids a multi-GB dense read)
try(suppressWarnings({
  if ("scale.data" %in% SeuratObject::Layers(o[["RNA"]])) o[["RNA"]]$scale.data <- NULL
}), silent = TRUE)

ds <- read_seurat(o)
message("read_seurat: ", length(ds$axes), " axes, ", length(ds$fields), " fields")

# --- adapt Seurat conventions -> the app's canonical schema ---
mv <- function(from, to) if (!is.null(ds$fields[[from]]) && from != to) {
  ds$fields[[to]] <<- ds$fields[[from]]; ds$fields[[from]] <<- NULL
}
# integrated UMAP -> "umap" (rename field + axis + span)
if (!is.null(ds$fields[["umap.integrated"]])) {
  f <- ds$fields[["umap.integrated"]]; f$span <- c("cells", "umap")
  ds$fields[["umap"]] <- f; ds$fields[["umap.integrated"]] <- NULL
  ds$axes[["umap"]] <- ds$axes[["umap.integrated"]]; ds$axes[["umap.integrated"]] <- NULL
}
# clustering -> leiden (a categorical label)
if (!is.null(ds$fields[["integrated_clusters"]])) {
  ds$fields[["leiden"]] <- list(role = "label", span = "cells",
                                values = as.character(ds$fields[["integrated_clusters"]]$values))
  ds$fields[["integrated_clusters"]] <- NULL
}
# QC renames
mv("percent.mt", "mito"); mv("nCount_RNA", "n_umi"); mv("nFeature_RNA", "n_gene")
# two donors, no disease/control contrast: condition := sample. n=1 per "condition" is exactly the
# cacoa caveat the agent should raise (donor is the replicate), now on real data.
if (!is.null(ds$fields[["sample"]]) && is.null(ds$fields[["condition"]]))
  ds$fields[["condition"]] <- list(role = "label", span = "cells",
                                   values = as.character(ds$fields[["sample"]]$values))

# prune what the viewer doesn't use (keep the store lean)
for (nm in c("X", "scale.data", "orig.ident", "pca", "integrated.cca")) ds$fields[[nm]] <- NULL
for (nm in names(ds$fields)) if (grepl("_loadings$", nm)) ds$fields[[nm]] <- NULL
for (ax in c("pca", "integrated.cca")) ds$axes[[ax]] <- NULL

# --- viewer profile (R, kernel-backed): per-annotation stats+markers (leiden AND cell_type),
#     whole-dataset od_score navigator, cell_order, counts_cellmajor ---
ds <- write_viewer(ds, grouping = "leiden", also = "cell_type")
message("fields: ", paste(names(ds$fields), collapse = ", "))
message("cells x genes: ", length(ds$axes$cells$labels), " x ", length(ds$axes$genes$labels),
        " | clusters: ", length(ds$axes$groups_leiden$labels))

lstar_write(ds, OUT)
message("wrote ", OUT)
