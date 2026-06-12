# Local launcher (R): turn an object or an L* store into a running viewer in the browser.
# Drives the repo's Vite dev server (the same one `npm --prefix web run dev` starts): writes the
# store under web/public, ensures the dev server is up, opens the browser. Standalone packaging
# (no repo checkout) is future work.

.pagoda3_repo <- function() {
  # this file is r/R/view.R; the repo root is two levels up from R/
  normalizePath(file.path(dirname(dirname(getwd())), ""), mustWork = FALSE)
}

#' Open an object or an L* store in the pagoda3 viewer.
#'
#' @param obj a `*.lstar.zarr` path, an `lstar_dataset`, or a Seurat/SCE object (converted via lstar).
#' @param repo path to the pagoda3 repo checkout (defaults to the `PAGODA3_REPO` env var).
#' @param prepare also precompute the navigators with [write_viewer()] (faster first open).
#' @param open whether to open the browser (default `TRUE`).
#' @return the viewer URL, invisibly.
#' @export
view <- function(obj, repo = Sys.getenv("PAGODA3_REPO"), prepare = FALSE, open = TRUE) {
  if (!nzchar(repo)) stop("set repo= or the PAGODA3_REPO env var to the pagoda3 checkout")
  public <- file.path(repo, "web", "public")
  if (is.character(obj) && grepl("\\.lstar\\.zarr/?$", obj)) {
    store <- obj
  } else {
    ds <- if (methods::is(obj, "lstar_dataset")) obj
          else if (methods::is(obj, "Seurat")) lstar::read_seurat(obj)
          else if (methods::is(obj, "SingleCellExperiment")) lstar::read_sce(obj)
          else stop("don't know how to view a ", class(obj)[1])
    if (prepare) ds <- write_viewer(ds)
    store <- file.path(public, "view.lstar.zarr")
    if (dir.exists(store)) unlink(store, recursive = TRUE)
    lstar::lstar_write(ds, store)
  }
  rel <- if (startsWith(normalizePath(store), normalizePath(public)))
    paste0("/", basename(store)) else store
  up <- tryCatch(suppressWarnings(length(readLines(url("http://localhost:8787/"), n = 1)) >= 0),
                 error = function(e) FALSE)
  if (!up) system2("npm", c("--prefix", file.path(repo, "web"), "run", "dev"), wait = FALSE,
                   stdout = FALSE, stderr = FALSE)
  u <- sprintf("http://localhost:8787/?store=%s", rel)
  if (open) utils::browseURL(u)
  message("pagoda3 viewer: ", u)
  invisible(u)
}
