"""Local launcher: turn an object or an L* store into a running viewer in the browser — standalone.

    pagoda3.view("sample.lstar.zarr")     # serve an existing L* store, open the viewer at it
    pagoda3.view(adata)                     # convert (via lstar) + precompute navigators, then serve
    pagoda3.view(adata, prepare=False)      # skip the navigator precompute (the viewer computes live)

No repo checkout and no build step. Two modes:

* **local** (default when a viewer bundle is available, see :mod:`pagoda3.bundle`): the viewer SPA *and*
  the store are served from one local server (:func:`pagoda3.serve.serve_mounts`) under different paths
  (``/`` and ``/store/``) — **same origin**, so no CORS, no ``https→http`` mixed content, and it works
  offline. This is the robust path.
* **hosted** (``local=False``, or when no bundle is present): the store is served locally and opened in
  the hosted viewer build at ``PAGODA3_VIEWER`` (default ``pklab``) via ``?store=`` (a cross-origin read).

Either way nothing is uploaded — the data is served from this machine.

Remote / HPC: if the call runs over SSH (a JupyterHub/OOD kernel on a cluster node), there is no local
browser and ``localhost`` on the node is not your laptop. The launcher detects this, skips the
auto-open, and prints the ``ssh -L`` port-forward to run on your laptop. In **local** mode that single
forwarded port carries both the viewer and the data.
"""
import os
import shutil
import tempfile
import time
import webbrowser
from urllib.parse import quote

from .serve import serve_dir, serve_mounts

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


def view(obj, prepare=True, local=None, viewer=None, host="127.0.0.1", port=0,
         open_browser=True, block=False):
    """Open ``obj`` (an L* store path, an ``lstar.Dataset``, or an AnnData) in the pagoda3 viewer.

    ``local``: serve the viewer bundle + the store from one origin (no CORS / mixed-content; works
    offline). ``None`` (default) uses local when a bundle is available, else the hosted viewer;
    ``True`` forces it (and warns + falls back to hosted if no bundle is found); ``False`` forces the
    hosted viewer.

    Returns the viewer URL. The local server runs on a daemon thread and stays up for the life of the
    process (so a notebook kernel keeps it alive). Pass ``block=True`` to keep a plain script running.
    """
    store = _coerce_store(obj, prepare)

    from .bundle import bundle_dir
    bundle = None if local is False else bundle_dir()
    use_local = bool(bundle) and local is not False
    if local is True and not bundle:
        print("pagoda3: no local viewer bundle found — using the hosted viewer instead.\n"
              "         (build it with `npm run build` in web/, or install a packaged release.)")

    if use_local:
        # one origin: viewer bundle at /, store at /store/ -> relative same-origin ?store=
        handle = serve_mounts([("/store/", store, False), ("/", bundle, True)], host=host, port=port)
        url = handle.url() + "?store=/store/"
    else:
        viewer = (viewer or os.environ.get("PAGODA3_VIEWER") or DEFAULT_VIEWER).rstrip("/") + "/"
        handle = serve_dir(store, host=host, port=port)
        url = "%s?store=%s" % (viewer, quote(handle.url(browser_host="localhost"), safe=""))
    _ALIVE.append(handle)

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
