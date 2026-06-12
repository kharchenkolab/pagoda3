"""Local launcher: turn an object or an L* store into a running viewer in the browser.

    pagoda3.view("sample.lstar.zarr")          # an existing L* store
    pagoda3.view(adata)                          # an AnnData (converted via lstar)
    pagoda3.view(adata, prepare=True)            # also precompute the navigators (faster first open)

For now this drives the repo's Vite dev server (the same one `npm --prefix web run dev` starts):
it places the store under web/public, ensures the dev server + agent proxy are up, and opens the
browser at it. A standalone, bundled launcher (no repo checkout) is future packaging work.
"""
import os
import shutil
import subprocess
import time
import webbrowser
from urllib.request import urlopen

import lstar

# repo root = .../pagoda3 (this file is pagoda3/py/src/pagoda3/launch.py)
_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_WEB = os.path.join(_REPO, "web")
_PUBLIC = os.path.join(_WEB, "public")
_PORT = 8787


def _coerce_store(obj, prepare):
    """Return a path to a *.lstar.zarr for `obj` (a path, an lstar.Dataset, or a convertible
    object), writing under web/public. Anything lstar can read becomes viewable."""
    from .viewer import write_viewer
    if isinstance(obj, str):
        if obj.rstrip("/").endswith(".lstar.zarr"):
            return obj                                   # already an L* store
        raise ValueError("pass a *.lstar.zarr path, or an in-memory object to convert")
    # an lstar.Dataset, or convert a known external object
    ds = obj if isinstance(obj, lstar.Dataset) else _convert(obj)
    if prepare:
        write_viewer(ds)
    name = "view_%d.lstar.zarr" % (abs(hash(id(obj))) % 100000)
    out = os.path.join(_PUBLIC, name)
    if os.path.exists(out):
        shutil.rmtree(out)
    lstar.write(ds, out)
    return out


def _convert(obj):
    cls = type(obj).__name__
    if cls == "AnnData":
        return lstar.read_anndata(obj)
    raise TypeError("don't know how to convert a %s; convert to lstar.Dataset first" % cls)


def _server_up(port=_PORT):
    try:
        urlopen("http://localhost:%d/" % port, timeout=0.5).read(1)
        return True
    except Exception:
        return False


def view(obj, prepare=False, open_browser=True):
    """Open `obj` (an L* store path, an lstar.Dataset, or an AnnData) in the pagoda3 viewer."""
    store = _coerce_store(obj, prepare)
    rel = "/" + os.path.relpath(store, _PUBLIC) if os.path.commonpath([store, _PUBLIC]) == _PUBLIC else store
    if not _server_up():
        subprocess.Popen(["npm", "--prefix", "web", "run", "dev"], cwd=_REPO,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            if _server_up():
                break
            time.sleep(0.5)
    url = "http://localhost:%d/?store=%s" % (_PORT, rel)
    if open_browser:
        webbrowser.open(url)
    print("pagoda3 viewer:", url)
    return url
