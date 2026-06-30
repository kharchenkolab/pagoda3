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

#' Serve a directory over HTTP (Range + CORS) on a background thread.
#'
#' @param root directory to serve (a `*.lstar.zarr` store; it becomes the server root).
#' @param host bind host (default `127.0.0.1`).
#' @param port port, or `0` to pick a free one.
#' @return a list with `server`, `port`, and `url()` (the store's base URL).
#' @export
serve_dir <- function(root, host = "127.0.0.1", port = 0) {
  root <- normalizePath(root, mustWork = TRUE)
  if (!requireNamespace("httpuv", quietly = TRUE)) stop("serve_dir needs the 'httpuv' package")
  if (port == 0) port <- httpuv::randomPort(min = 8000, max = 65000, host = host)
  sp <- httpuv::staticPath(root, headers = .pagoda3_cors)
  app <- list(staticPaths = list("/" = sp),
              staticPathOptions = httpuv::staticPathOptions(headers = .pagoda3_cors))
  srv <- httpuv::startServer(host = host, port = port, app = app)
  assign(as.character(port), srv, envir = .pagoda3_servers)   # keep alive
  list(server = srv, port = port,
       url = function() sprintf("http://localhost:%d/", port),
       stop = function() { httpuv::stopServer(srv); rm(list = as.character(port), envir = .pagoda3_servers) })
}
