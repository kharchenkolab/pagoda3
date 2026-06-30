"""Local launcher: turn an object or an L* store into a running viewer in the browser — standalone.

    pagoda3.view("sample.lstar.zarr")     # serve an existing L* store, open the viewer at it
    pagoda3.view(adata)                     # convert (via lstar) + precompute navigators, then serve
    pagoda3.view(adata, prepare=False)      # skip the navigator precompute (the viewer computes live)

No repo checkout and no build step: the store is served locally with a tiny stdlib HTTP server
(byte-range + CORS, see :mod:`pagoda3.serve`) and opened in the **hosted** viewer build — a static
SPA at ``PAGODA3_VIEWER`` (default ``pklab``) — pointed at the local store via ``?store=``. The viewer
reads the store cross-origin over range requests; nothing is uploaded.

Remote / HPC: if the call runs over SSH (e.g. a JupyterHub/OOD kernel on a cluster node), there is no
local browser and ``localhost`` on the node is not your laptop. The launcher detects this, skips the
auto-open, and prints the ``ssh -L`` port-forward to run on your laptop so the viewer there can reach
the node's store server.
"""
import os
import shutil
import tempfile
import time
import webbrowser
from urllib.parse import quote

from .serve import serve_dir

DEFAULT_VIEWER = "https://pklab.med.harvard.edu/peterk/pagoda3/"

# keep started servers (and their sockets) alive for the life of the process / kernel
_ALIVE = []


def _coerce_store(obj, prepare):
    """Return an absolute path to a ``*.lstar.zarr`` for ``obj``.

    A path to an existing store is served *in place* (untouched). An ``lstar.Dataset`` or a
    convertible object (AnnData, …) is converted, optionally extended with the viewer navigators,
    and written to a fresh temp store.
    """
    if isinstance(obj, str):
        if obj.rstrip("/").endswith(".lstar.zarr"):
            return os.path.abspath(obj.rstrip("/"))
        raise ValueError("pass a *.lstar.zarr path, or an in-memory object to convert")
    import lstar
    from .viewer import write_viewer
    ds = obj if isinstance(obj, lstar.Dataset) else _convert(obj)
    if prepare:
        write_viewer(ds)
    out = os.path.join(tempfile.mkdtemp(prefix="pagoda3-"), "view.lstar.zarr")
    lstar.write(ds, out)
    return out


def _convert(obj):
    import lstar
    cls = type(obj).__name__
    if cls in ("AnnData", "Raw"):
        return lstar.read_anndata(obj)
    raise TypeError("don't know how to convert a %s; convert to lstar.Dataset first" % cls)


def _is_remote():
    """True when this kernel is on a remote host reached over SSH — no usable local browser."""
    return bool(os.environ.get("SSH_CONNECTION") or os.environ.get("SSH_CLIENT"))


def view(obj, prepare=True, viewer=None, host="127.0.0.1", port=0, open_browser=True, block=False):
    """Open ``obj`` (an L* store path, an ``lstar.Dataset``, or an AnnData) in the pagoda3 viewer.

    Returns the viewer URL. The local store server runs on a daemon thread and stays up for the life
    of the process (so a notebook kernel keeps it alive). Pass ``block=True`` to keep a plain script
    running.
    """
    viewer = (viewer or os.environ.get("PAGODA3_VIEWER") or DEFAULT_VIEWER).rstrip("/") + "/"
    store = _coerce_store(obj, prepare)

    handle = serve_dir(store, host=host, port=port)
    _ALIVE.append(handle)
    store_url = handle.url(browser_host="localhost")              # the store is the server root
    url = "%s?store=%s" % (viewer, quote(store_url, safe=""))

    print("pagoda3 viewer:", url)
    if _is_remote():
        print("  remote session — on YOUR machine run:")
        print("    ssh -N -L %d:localhost:%d <this-host>" % (handle.port, handle.port))
        print("  then open the URL above in your browser.")
    elif open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    if block:
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            handle.stop()
    return url
