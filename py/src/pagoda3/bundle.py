"""Locate the built viewer bundle for same-origin local serving (Phase 2).

The bundle is the viewer SPA built with base ``/`` (``index.html`` + ``assets/`` + ``genesets/`` +
``wasm/``) — *without* the demo ``*.lstar.zarr`` stores. A published wheel vendors it at
``pagoda3/_viewer/``; in a source checkout it's the repo's ``web/dist`` (built on demand).
"""
import os
import subprocess
from shutil import which

# vendored inside the installed package (created by scripts/build-bundle.sh at package time)
_VENDORED = os.path.join(os.path.dirname(__file__), "_viewer")
# dev fallback: this file is .../lstar-viewer/py/src/pagoda3/bundle.py -> repo web/
_REPO_WEB = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "web"))
_REPO_DIST = os.path.join(_REPO_WEB, "dist")


def _ok(d):
    return bool(d) and os.path.isfile(os.path.join(d, "index.html"))


def bundle_dir(build=True):
    """Return a directory with the built viewer (``index.html`` + ``assets/``), or ``None``.

    Priority: the vendored ``_viewer/`` shipped in the package; else the repo's ``web/dist`` — built
    on demand with ``npm run build`` if absent and ``npm`` is available.
    """
    if _ok(_VENDORED):
        return _VENDORED
    if _ok(_REPO_DIST):
        return _REPO_DIST
    if build and os.path.isdir(_REPO_WEB) and which("npm"):
        try:
            subprocess.run([which("npm"), "run", "build"], cwd=_REPO_WEB, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            return None
        if _ok(_REPO_DIST):
            return _REPO_DIST
    return None
