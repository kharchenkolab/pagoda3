"""pagoda3.publish — package a dataset into a self-contained, shareable static folder (Phase 3b).

    pagoda3.publish(adata, to="./share")     # convert + optimize, then write a drop-anywhere folder
    pagoda3.publish("data.lstar.zarr", to="./share")

The folder is **self-contained**: the viewer bundle + the store, served same-origin. Drop it on ANY
static host (a lab webserver, S3, a departmental share, even open it locally) and anyone — no install —
opens ``<host-url>/?store=store/`` and sees the data. No CORS, no WAF, because the viewer and the data
are one origin.

    <to>/index.html, assets/, genesets/, wasm/   the viewer bundle
    <to>/store/                                   the optimized .lstar.zarr

To share an EXACT view (this colouring / this DE), open the published link, set up the view, and use
the viewer's **Share** button — it appends a compact ``?view=`` deep-link to the published URL.

``bundle=False`` writes only the store (no viewer); host it with byte-range + CORS and point a hosted
viewer at it via ``?store=<url>`` — lighter per dataset, but reintroduces the CORS/host dependency.
Uploading to a remote host (HuggingFace, an rsync droppoint) is a thin layer on top of this folder —
that's the next step; for now ``to`` is a local directory you place wherever you like.
"""
import os
import shutil

from .bundle import bundle_dir
from .launch import DEFAULT_VIEWER, _coerce_store


def _bake_publish_meta(index_html, store_rel):
    """Make a published folder self-describing via <meta> tags the viewer reads:
      • pagoda3:store  — a bare URL self-loads the co-located store (clean `<host>/`, no `?store=` tail)
      • pagoda3:agent  — "off": no proxy here, so skip the /health probe (keeps the shared console clean)."""
    try:
        with open(index_html, encoding="utf-8") as f:
            html = f.read()
        if "pagoda3:store" in html or "</head>" not in html:
            return
        tags = ('<meta name="pagoda3:store" content="%s">\n'
                '  <meta name="pagoda3:agent" content="off">') % store_rel
        html = html.replace("</head>", "  " + tags + "\n</head>", 1)
        with open(index_html, "w", encoding="utf-8") as f:
            f.write(html)
    except OSError:
        pass  # non-fatal: without the tags the folder still works at <host>/?store=store/


def publish(obj, to="./share", prepare=True, bundle=True, viewer=None):
    """Write a shareable folder for ``obj`` (an AnnData / lstar.Dataset / *.lstar.zarr path) at ``to``.

    Returns the output directory. With ``bundle=True`` (default) the folder is self-contained and
    same-origin; with ``bundle=False`` only the store is written.
    """
    store = _coerce_store(obj, prepare)
    out = os.path.abspath(to)
    os.makedirs(out, exist_ok=True)

    dst = os.path.join(out, "store")
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(store, dst)

    if bundle:
        bd = bundle_dir()
        if not bd:
            raise RuntimeError(
                "publish(bundle=True): no viewer bundle found. Build it with server/build-bundle.sh "
                "(or install a packaged release), or use bundle=False to publish the data only.")
        # copy the bundle alongside the store; never drag the demo stores from a dev web/dist
        shutil.copytree(bd, out, dirs_exist_ok=True, ignore=shutil.ignore_patterns("*.lstar.zarr"))
        _bake_publish_meta(os.path.join(out, "index.html"), "store/")   # bare URL self-loads the store; no-agent
        print("pagoda3 published (self-contained) →", out)
        print("  drop this folder on any static host; share the bare URL:  <host-url>/")
        print("  same-origin — no install, no CORS. (open locally: pagoda3 serve %s)" % out)
        return out

    viewer = (viewer or os.environ.get("PAGODA3_VIEWER") or DEFAULT_VIEWER).rstrip("/") + "/"
    print("pagoda3 published (data only) →", dst)
    print("  host it with HTTP byte-range + CORS, then share:  %s?store=<store-url>" % viewer)
    return out
