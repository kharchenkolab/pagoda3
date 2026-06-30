# Standalone static server for L* zarr stores (R) -- Range + CORS, via httpuv staticPaths.
#
# The viewer is a static web app that reads a *.lstar.zarr over HTTP byte-range requests, possibly
# from a different origin (the hosted build). This serves a local store directory with the headers a
# cross-origin read needs, so the hosted viewer can fetch a store on localhost. httpuv's staticPaths
# serve files from a background I/O thread, so the R session stays interactive while the server keeps
# serving (it serves even while R is busy). Twin of pagoda3/serve.py.
#
# NOTE: httpuv staticPaths does not honor `Range` -- it answers 200 with the whole file. The viewer's
# reader handles that (it slices the full body), so reads are correct; over localhost the extra bytes
# cost ~nothing. Only remote serving (R kernel on a cluster, browser via SSH tunnel) loses the
# range-read bandwidth win -- a true-206 handler there is a follow-up (would need a dynamic app).

.pagoda3_cors <- list(
  "Access-Control-Allow-Origin" = "*",
  "Access-Control-Allow-Methods" = "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers" = "Range, Content-Type",
  "Access-Control-Expose-Headers" = "Content-Range, Content-Length, Accept-Ranges, Content-Encoding",
  "Access-Control-Max-Age" = "86400",
  "Timing-Allow-Origin" = "*"
)

# registry so started servers (and their sockets) survive for the life of the session
.pagoda3_servers <- new.env(parent = emptyenv())

.pagoda3_start <- function(static_paths, host, port) {
  if (!requireNamespace("httpuv", quietly = TRUE)) stop("serving needs the 'httpuv' package")
  if (port == 0) port <- httpuv::randomPort(min = 8000, max = 65000, host = host)
  app <- list(staticPaths = static_paths,
              staticPathOptions = httpuv::staticPathOptions(headers = .pagoda3_cors))
  srv <- httpuv::startServer(host = host, port = port, app = app)
  assign(as.character(port), srv, envir = .pagoda3_servers)   # keep alive
  list(server = srv, port = port,
       url = function() sprintf("http://localhost:%d/", port),
       stop = function() { httpuv::stopServer(srv); rm(list = as.character(port), envir = .pagoda3_servers) })
}

#' Serve a directory over HTTP (Range + CORS) on a background thread.
#'
#' @param root directory to serve (a `*.lstar.zarr` store; it becomes the server root).
#' @param host bind host (default `127.0.0.1`).
#' @param port port, or `0` to pick a free one.
#' @return a list with `server`, `port`, and `url()` (the store's base URL).
#' @export
serve_dir <- function(root, host = "127.0.0.1", port = 0) {
  root <- normalizePath(root, mustWork = TRUE)
  .pagoda3_start(list("/" = httpuv::staticPath(root, headers = .pagoda3_cors)), host, port)
}

#' Serve the viewer bundle and a store from one origin (Phase 2 same-origin local mode).
#'
#' Bundle at `/`, store at `/store/` — so the browser opens `<url>?store=/store/` with no CORS and no
#' mixed content. httpuv sets correct content types (incl. JS modules) and serves `index.html` for the
#' root automatically; the viewer routes by `?store=` query, not by path, so no SPA fallback is needed.
#'
#' @param bundle directory with the built viewer (`index.html` + `assets/`).
#' @param store a `*.lstar.zarr` directory.
#' @param host,port bind host / port (`0` = free port).
#' @return a list with `server`, `port`, `url()`, `stop()`.
#' @export
serve_app <- function(bundle, store, host = "127.0.0.1", port = 0) {
  bundle <- normalizePath(bundle, mustWork = TRUE)
  store <- normalizePath(store, mustWork = TRUE)
  .pagoda3_start(list(
    "/store" = httpuv::staticPath(store,  headers = .pagoda3_cors),
    "/"      = httpuv::staticPath(bundle, headers = .pagoda3_cors)
  ), host, port)
}

#' Locate the built viewer bundle: `PAGODA3_BUNDLE`, else the installed `inst/viewer`, else `web/dist`.
#' @return a directory path, or `NA` if none is found.
#' @export
bundle_dir <- function() {
  env <- Sys.getenv("PAGODA3_BUNDLE")
  if (nzchar(env) && file.exists(file.path(env, "index.html"))) return(normalizePath(env))
  vend <- system.file("viewer", package = "pagoda3")
  if (nzchar(vend) && file.exists(file.path(vend, "index.html"))) return(vend)
  for (d in c(file.path(getwd(), "web", "dist"),
              file.path(dirname(getwd()), "web", "dist"))) {
    if (file.exists(file.path(d, "index.html"))) return(normalizePath(d))
  }
  NA_character_
}
