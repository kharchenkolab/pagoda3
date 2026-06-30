"""Standalone static server for L* zarr stores — Range + CORS, stdlib only.

The viewer is a static SPA that reads a ``*.lstar.zarr`` over HTTP byte-range requests; it may be
loaded from a *different* origin (the hosted build at pklab) than the store it reads. This serves a
local store directory with exactly the headers a cross-origin RANGE read needs — the preflight
(``OPTIONS``) and the exposed ``Content-Range`` — so the hosted viewer can fetch a store sitting on
``localhost``. (``http://localhost`` is a "potentially trustworthy" origin, so an ``https`` page may
fetch it without tripping mixed-content blocking.) Python twin of ``server/staticzarr.mjs``.

Runs in a daemon thread so :func:`serve_dir` returns immediately and the caller (a notebook kernel)
stays interactive while the server keeps serving.
"""
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

_RANGE = re.compile(r"bytes=(\d+)-(\d*)")
_META = re.compile(r"(zarr\.json|\.zarray|\.zgroup|\.zattrs|\.zmetadata)$")


class _Handler(BaseHTTPRequestHandler):
    root = "."  # overridden per-server by a subclass

    def _cors(self):
        # allow any origin + the bits a cross-origin RANGE read needs (preflight + exposed range headers)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers",
                         "Content-Range, Content-Length, Accept-Ranges, Content-Encoding")
        self.send_header("Access-Control-Max-Age", "86400")  # cache the preflight a day
        self.send_header("Timing-Allow-Origin", "*")
        self.send_header("Accept-Ranges", "bytes")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_HEAD(self):
        self._serve(head=True)

    def do_GET(self):
        self._serve(head=False)

    def _resolve(self):
        rel = unquote(self.path.split("?")[0]).lstrip("/")
        p = os.path.normpath(os.path.join(self.root, rel))
        if p != self.root and not p.startswith(self.root + os.sep):
            return None  # path traversal
        return p

    def _fail(self, code):
        # CORS even on errors, so a cross-origin viewer can read the status (404/416 etc.)
        self.send_response(code)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _serve(self, head):
        p = self._resolve()
        if p is None:
            return self._fail(403)
        if not os.path.isfile(p):
            return self._fail(404)
        size = os.path.getsize(p)
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            m = _RANGE.match(rng)
            if m:
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
                if start >= size or end >= size or start > end:
                    self.send_response(416)
                    self._cors()
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.end_headers()
                    return
                status = 206
        length = end - start + 1
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/octet-stream")
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(length))
        # chunk files are immutable per dataset version; metadata revalidates
        self.send_header("Cache-Control",
                         "no-cache" if _META.search(p) else "public, max-age=31536000, immutable")
        self.end_headers()
        if head:
            return
        with open(p, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)

    def log_message(self, *args):
        pass  # quiet — the notebook is the console


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class ServeHandle:
    """A running store server. ``url(name)`` builds the store URL; ``stop()`` shuts it down."""

    def __init__(self, server, host, port):
        self.server = server
        self.host = host
        self.port = port

    def url(self, name="", browser_host="localhost"):
        # the browser reaches the server as `browser_host` (localhost locally, or the tunnel endpoint
        # remotely) — NOT necessarily the bind host
        base = "http://%s:%d/" % (browser_host, self.port)
        return base + (name.rstrip("/") + "/" if name else "")

    def stop(self):
        self.server.shutdown()


def serve_dir(root, host="127.0.0.1", port=0):
    """Serve ``root`` over HTTP (Range + CORS) on a daemon thread. ``port=0`` picks a free port.
    Returns a :class:`ServeHandle`."""
    root = os.path.abspath(root)
    handler = type("_BoundHandler", (_Handler,), {"root": root})
    srv = _Server((host, port), handler)
    bound_port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True, name="pagoda3-serve").start()
    return ServeHandle(srv, host, bound_port)
