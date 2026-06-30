"""pagoda3 store prep — `write_viewer` precomputes the *global* navigators the viewer opens with.

The viewer@0.1 navigators (cluster stats, 1-vs-rest markers, a whole-dataset `od_score`, the
cell-major counts copy + its cluster-contiguous order) are general-purpose, so the *computation*
lives in **lstar** (`lstar.extend_for_viewer`, on the shared C++/WASM core) and is byte-identical to
what the browser computes live and what the JS/R preps write. pagoda3 keeps only the *policy*: which
annotations to summarize. So `write_viewer` is a thin wrapper that picks the groupings and calls lstar.

Everything *scope-dependent* — selection DE, subset HVG — is left to the viewer's on-the-fly compute,
because a global gene subset is wrong for a local question.
"""


def _looks_like_counts(values):
    """True if a measure's values look like raw counts (non-negative integers)."""
    import numpy as np
    import scipy.sparse as sp
    data = values.data if sp.issparse(values) else np.asarray(values).ravel()
    if data.size == 0:
        return False
    s = data[:10000]
    return bool(np.all(s >= 0) and np.allclose(s, np.round(s)))


def _counts_field(ds):
    """Pick the raw-counts measure to summarize: a field named ``counts``, else a ``state="raw"``
    measure, else one whose values look like integer counts (e.g. an AnnData ``.X`` → ``X``)."""
    if "counts" in ds.fields:
        return "counts"
    measures = [n for n, f in ds.fields.items() if getattr(f, "role", None) == "measure"]
    for n in measures:
        if getattr(ds.field(n), "state", None) == "raw":
            return n
    for n in measures:
        if _looks_like_counts(ds.field(n).values):
            return n
    raise ValueError(
        "write_viewer: no raw counts found — the viewer computes from raw counts. Put them in "
        "adata.layers['counts'] (or adata.X), or pass counts=<field name>.")


def write_viewer(ds, grouping="leiden", counts=None, engine="auto", also=()):
    """Add the `viewer@0.1` profile (navigator fields) to an lstar dataset; returns ds.

    Thin policy wrapper over :func:`lstar.extend_for_viewer` (the shared recipe): picks the raw-counts
    measure and the groupings, then precomputes per-group stats + 1-vs-rest markers plus the global
    ``od_score`` and the cell-major counts copy.

    ``grouping`` is used if present; otherwise (and for ``also`` names that are absent) lstar
    auto-detects the categorical labels. ``counts`` defaults to auto-detection (see :func:`_counts_field`).
    """
    import lstar
    counts = counts or _counts_field(ds)
    groupings = [g for g in dict.fromkeys([grouping, *also]) if g in ds.fields]
    return lstar.extend_for_viewer(ds, groupings=groupings or None, counts=counts)
