"""Standalone static server for the L* viewer — Range + CORS, stdlib only.

Two ways the viewer reaches its data, both served here:

* **cross-origin** (Phase 1): the viewer is loaded from a *different* origin (the hosted build) and
  reads a store on ``localhost``. That needs the CORS bits a cross-origin RANGE read uses (the
  ``OPTIONS`` preflight + the exposed ``Content-Range``). (``http://localhost`` is a "potentially
  trustworthy" origin, so an ``https`` page may fetch it without tripping mixed-content blocking.)
* **same-origin** (Phase 2): the viewer *bundle* and the store are served from this one server under
  different path prefixes (``/`` and ``/store/``) — no CORS, no mixed content, works offline. This is
  what :func:`serve_app` sets up.

Python twin of ``server/staticzarr.mjs``. Runs on a daemon thread so the caller (a notebook kernel)
stays interactive while the server keeps serving. Multiple mounts with longest-prefix match: the
bundle mount falls back to ``index.html`` (SPA), the store mount stays strict so the reader sees a
real 404 for an absent chunk.
"""
import mimetypes
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

_RANGE = re.compile(r"bytes=(\d+)-(\d*)")
_META = re.compile(r"(zarr\.json|\.zarray|\.zgroup|\.zattrs|\.zmetadata)$")
# JS modules must be served with a JavaScript MIME type or the browser refuses to execute them.
_MIME_FIX = {".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
             ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css"}


def _content_type(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in _MIME_FIX:
        return _MIME_FIX[ext]
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


class _Handler(BaseHTTPRequestHandler):
    mounts = ()  # tuple of (prefix, root_dir, spa_fallback); set per-server by a subclass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers",
                         "Content-Range, Content-Length, Accept-Ranges, Content-Encoding")
        self.send_header("Access-Control-Max-Age", "86400")
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
        """Map the request path to a file via the longest matching mount; honor SPA fallback."""
        path = unquote(self.path.split("?")[0])
        for prefix, root, spa in self.mounts:                     # mounts are longest-prefix first
            if path == prefix.rstrip("/") or path.startswith(prefix):
                rel = path[len(prefix):].lstrip("/") if path.startswith(prefix) else ""
                p = os.path.normpath(os.path.join(root, rel))
                if p != root and not p.startswith(root + os.sep):
                    return "forbidden"                            # path traversal
                if os.path.isdir(p):
                    p = os.path.join(p, "index.html")
                if os.path.isfile(p):
                    return p
                if spa:                                           # SPA: unknown route -> index.html
                    idx = os.path.join(root, "index.html")
                    return idx if os.path.isfile(idx) else None
                return None
        return None

    def _fail(self, code):
        # CORS even on errors, so a cross-origin viewer can read the status (404/416 etc.)
        self.send_response(code)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _serve(self, head):
        p = self._resolve()
        if p == "forbidden":
            return self._fail(403)
        if not p:
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
        self.send_header("Content-Type", _content_type(p))
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(length))
        # zarr chunks/assets are immutable per version; metadata + index.html revalidate
        revalidate = _META.search(p) or p.endswith("index.html")
        self.send_header("Cache-Control",
                         "no-cache" if revalidate else "public, max-age=31536000, immutable")
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
    """A running server. ``url(path)`` builds an absolute URL into it; ``stop()`` shuts it down."""

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


def serve_mounts(mounts, host="127.0.0.1", port=0):
    """Serve several directories under path prefixes (Range + CORS) on a daemon thread.

    ``mounts``: list of ``(prefix, dir)`` or ``(prefix, dir, spa_fallback)``. Longest prefix wins;
    ``spa_fallback`` serves ``index.html`` for unknown routes under that mount. ``port=0`` → free port.
    """
    norm = []
    for m in mounts:
        prefix, root = m[0], os.path.abspath(m[1])
        spa = m[2] if len(m) > 2 else False
        if not prefix.startswith("/"):
            prefix = "/" + prefix
        norm.append((prefix, root, spa))
    norm.sort(key=lambda m: len(m[0]), reverse=True)              # longest-prefix first
    handler = type("_BoundHandler", (_Handler,), {"mounts": tuple(norm)})
    srv = _Server((host, port), handler)
    bound_port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True, name="pagoda3-serve").start()
    return ServeHandle(srv, host, bound_port)


def serve_dir(root, host="127.0.0.1", port=0):
    """Serve ``root`` at the server root (Range + CORS). Returns a :class:`ServeHandle`."""
    return serve_mounts([("/", root, False)], host=host, port=port)
