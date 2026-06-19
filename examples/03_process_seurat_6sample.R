#!/usr/bin/env Rscript
# 6-sample RPCA integration (GSE192391 PBMC, Seurat v5) -> L* viewer store.
# Robust to field-name variation (UMAP / clusters / sample): detect, adapt to the canonical schema,
# print what was found, and only run the expensive write_viewer once umap+leiden are confirmed present.
suppressMessages({ library(Seurat); library(SeuratObject); library(lstar); library(pagoda3) })

SRC <- "/Users/peter.kharchenko/.aba/runtime/projects/prj_8143327c/work/ana_e92634df/seurat_integrated.rds"
OUT <- "/Users/peter.kharchenko/pagoda/lstar-viewer/web/public/pbmc6.lstar.zarr"

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

# Real GSE192391 design (severe COVID-19 PBMC): 3 patients x 2 timepoints, from the GEO sample
# characteristics. condition = TIMEPOINT (day0 vs day7) — a paired contrast across 3 donors (n=3 per
# condition), the meaningful experimental variable; patient = the donor/replicate; outcome = clinical
# status (alive/deceased). Keyed by the GSM sample id. Earlier this duplicated `sample` (meaningless).
.gsm_meta <- list(
  GSM5746259 = c(patient = "145", condition = "day0", outcome = "alive"),
  GSM5746260 = c(patient = "145", condition = "day7", outcome = "alive"),
  GSM5746261 = c(patient = "154", condition = "day0", outcome = "alive"),
  GSM5746262 = c(patient = "154", condition = "day7", outcome = "alive"),
  GSM5746263 = c(patient = "163", condition = "day0", outcome = "deceased"),
  GSM5746264 = c(patient = "163", condition = "day7", outcome = "deceased")
)
if (!is.null(ds$fields[["sample"]])) {
  sv <- as.character(ds$fields[["sample"]]$values)
  pick <- function(key) {
    out <- vapply(sv, function(s) { m <- .gsm_meta[[s]]; if (is.null(m)) NA_character_ else unname(m[[key]]) }, character(1), USE.NAMES = FALSE)
    out[is.na(out)] <- sv[is.na(out)]   # fall back to the sample id for any sample not in the table
    out
  }
  ds$fields[["patient"]]   <- list(role = "label", span = "cells", values = pick("patient"))
  ds$fields[["condition"]] <- list(role = "label", span = "cells", values = pick("condition"))
  ds$fields[["outcome"]]   <- list(role = "label", span = "cells", values = pick("outcome"))
  message("condition <- timepoint (", paste(sort(unique(pick("condition"))), collapse = "/"),
          "); patient (", length(unique(pick("patient"))), " donors); outcome (",
          paste(sort(unique(pick("outcome"))), collapse = "/"), ")")
}

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
