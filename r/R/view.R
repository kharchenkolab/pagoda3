# Local launcher (R): turn an object or an L* store into a running viewer in the browser -- standalone.
#
# No repo checkout and no build step: the store is served locally with a tiny byte-range + CORS HTTP
# server (see serve.R) and opened in the *hosted* viewer build (a static web app at PAGODA3_VIEWER,
# default pklab) pointed at the local store via ?store=. The viewer reads the store cross-origin over
# range requests; nothing is uploaded. Twin of pagoda3/launch.py.

PAGODA3_DEFAULT_VIEWER <- "https://pklab.med.harvard.edu/peterk/pagoda3/"

.pagoda3_coerce_store <- function(obj, prepare) {
  # a path to an existing store is served in place; an object is converted (+ optionally extended).
  if (is.character(obj) && grepl("\\.lstar\\.zarr/?$", obj)) {
    return(normalizePath(sub("/$", "", obj), mustWork = TRUE))
  }
  ds <- if (methods::is(obj, "lstar_dataset")) obj
        else if (methods::is(obj, "Seurat")) lstar::read_seurat(obj)
        else if (methods::is(obj, "SingleCellExperiment")) lstar::read_sce(obj)
        else stop("don't know how to view a ", class(obj)[1], "; convert to lstar_dataset first")
  if (prepare) ds <- write_viewer(ds)
  out <- file.path(tempfile("pagoda3-"), "view.lstar.zarr")
  dir.create(dirname(out), recursive = TRUE, showWarnings = FALSE)
  lstar::lstar_write(ds, out)
  out
}

#' Open an object or an L* store in the pagoda3 viewer (standalone).
#'
#' @param obj a `*.lstar.zarr` path, an `lstar_dataset`, or a Seurat/SCE object (converted via lstar).
#' @param prepare also precompute the navigators with [write_viewer()] (default `TRUE`; faster first open).
#' @param local serve the viewer bundle + store from one origin (no CORS/mixed-content; works offline).
#'   `NA` (default) uses local when a bundle is available (see [bundle_dir()]), else the hosted viewer;
#'   `TRUE` forces it (falls back to hosted with a message if no bundle); `FALSE` forces hosted.
#' @param viewer viewer base URL for hosted mode (default `PAGODA3_VIEWER` env var or the hosted build).
#' @param host store-server bind host (default `127.0.0.1`).
#' @param port store-server port, or `0` for a free port.
#' @param open whether to open the browser (default `TRUE`).
#' @return the viewer URL, invisibly. The server stays up for the life of the R session.
#' @export
view <- function(obj, prepare = TRUE, local = NA, viewer = NULL, host = "127.0.0.1", port = 0, open = TRUE) {
  store <- .pagoda3_coerce_store(obj, prepare)
  bundle <- if (isFALSE(local)) NA_character_ else bundle_dir()
  use_local <- !is.na(bundle) && !isFALSE(local)
  if (isTRUE(local) && is.na(bundle))
    message("pagoda3: no local viewer bundle found - using the hosted viewer instead.")

  if (use_local) {
    h <- serve_app(bundle, store, host = host, port = port)
    u <- paste0(h$url(), "?store=/store/")
  } else {
    if (is.null(viewer)) viewer <- Sys.getenv("PAGODA3_VIEWER", PAGODA3_DEFAULT_VIEWER)
    viewer <- paste0(sub("/$", "", viewer), "/")
    h <- serve_dir(store, host = host, port = port)
    u <- sprintf("%s?store=%s", viewer, utils::URLencode(h$url(), reserved = TRUE))
  }

  message("pagoda3 viewer: ", u)
  remote <- nzchar(Sys.getenv("SSH_CONNECTION")) || nzchar(Sys.getenv("SSH_CLIENT"))
  if (remote) {
    message("  remote session -- on YOUR machine run:")
    message(sprintf("    ssh -N -L %d:localhost:%d <this-host>", h$port, h$port))
    message("  then open the URL above in your browser.")
  } else if (open) {
    utils::browseURL(u)
  }
  invisible(u)
}
