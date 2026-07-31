"""pagoda3 store prep — `write_viewer` precomputes the *global* navigators the viewer opens with.

The viewer@0.1 navigators (cluster stats, 1-vs-rest markers, a whole-dataset `od_score`, the
cell-major counts copy + its cluster-contiguous order) are general-purpose, so the *computation*
lives in **lstar** (`lstar.extend_for_viewer`, on the shared C++/WASM core) and is byte-identical to
what the browser computes live and what the JS/R preps write. pagoda3 keeps only the *policy*: which
annotations to summarize. So `write_viewer` is a thin wrapper that picks the groupings and calls lstar.

Everything *scope-dependent* — selection DE, subset HVG — is left to the viewer's on-the-fly compute,
because a global gene subset is wrong for a local question.
"""
import re

# Policy constants, mirrored in the browser (web/src/anno/roles.ts) and in the R wrapper. Keep the three
# in step: a store prepped by one surface must summarize the same groupings as one prepped by another.
_PARTITION_MAX_CARD = 200
_CLUSTER_NAME_RE = re.compile(
    r"(^|[._\- ])(clusters?|clustering|leiden|louvain|snn_res|res|kmeans|phenograph|metacell|sctype)([._\- ]|\d|$)",
    re.I)


def _looks_like_cluster_field(name):
    """True for a field name that reads like a clustering (`leiden`, `seurat_clusters`, `snn_res.0.8`)."""
    return bool(_CLUSTER_NAME_RE.search(str(name)))


def _partition_levels(values, name=None, max_card=_PARTITION_MAX_CARD):
    """Number of distinct levels if `values` is an integer-coded partition over cells, else ``None``.

    Integral and low-cardinality is necessary but NOT sufficient: a small-count QC measure (nCount_RNA
    on a shallow library, a doublet score bucketed to integers) is also integral with few levels, and
    summarizing it costs a full stats+markers pass and writes a grouping nothing will ever use. So
    require the levels to look like CODES — contiguous and 0- or 1-based, which is what every clustering
    writes (Seurat `seurat_clusters`, scanpy `leiden`, a factor's integer codes) — or, failing that, a
    name that reads like a clustering, which rescues a clustering with an empty level.

    The browser's ``partitionFromNumeric`` is deliberately laxer: promoting a column for DISPLAY is
    reversible and costs one pass over a vector, whereas promoting it here costs a genome-wide pass and
    is baked into the store.
    """
    import numpy as np
    import scipy.sparse as sp
    if sp.issparse(values):
        return None
    v = np.asarray(values)
    if v.ndim != 1 or v.size == 0 or v.dtype.kind not in "iuf":
        return None
    if v.dtype.kind == "f":
        if not np.all(np.isfinite(v)) or not np.all(v == np.round(v)):
            return None
    uniq = np.unique(v)
    n = len(uniq)
    if not (2 <= n <= max_card):
        return None
    contiguous = uniq[0] in (0, 1) and (uniq[-1] - uniq[0] + 1) == n
    return n if (contiguous or (name is not None and _looks_like_cluster_field(name))) else None


def _numeric_partitions(ds, cell_axis="cells"):
    """Integer-coded numeric cell columns that are really partitions, best candidate first.

    A clustering that arrives as NUMBERS — Seurat's ``integrated_clusters``, an int64 ``obs`` column via
    AnnData — is written by L* as ``role="measure"``/dense, so lstar's label-role grouping detection
    cannot see it. The result is that the one grouping a viewer store fails to summarize is the actual
    clustering, and every cluster-derived category (scType output, a hand-merged annotation) then has no
    summarized base to be derived from. Naming them here is pagoda3's policy call, not lstar's recipe.

    Ordered clustering-named first, then by descending level count — the finest clustering is the most
    useful reorder key and the most useful base for deriving coarser groupings.
    """
    out = []
    for name in ds.fields:
        f = ds.field(name)
        if getattr(f, "role", None) != "measure" or list(getattr(f, "span", None) or []) != [cell_axis]:
            continue
        if (getattr(f, "provenance", None) or {}).get("cache"):
            continue                                   # a viewer navigator (od_score, *_order), not data
        levels = _partition_levels(f.values, name)
        if levels is not None:
            out.append((name, levels))
    out.sort(key=lambda t: (not _looks_like_cluster_field(t[0]), -t[1], t[0]))
    return out


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

    Numeric partitions are summarized too. A clustering stored as integers is a ``measure`` to L*, so
    lstar's label-role detection skips it (correctly — it cannot know a numeric column is a partition);
    :func:`_numeric_partitions` finds them and they are named explicitly. The best one also becomes
    lstar's ``primary=`` — the grouping the viewer opens on and the key `counts_cellmajor` is reordered
    by. ``primary`` COMPOSES with auto-detection (lstar hoists it to the front of the detected list), so
    naming a clustering never costs the categorical annotations their stats.
    """
    import lstar
    counts = counts or _counts_field(ds)
    named = [g for g in dict.fromkeys([grouping, *also]) if g in ds.fields]
    parts = [n for n, _ in _numeric_partitions(ds)]
    primary = named[0] if named else (parts[0] if parts else None)
    # Pass an explicit list ONLY when the caller named something: lstar auto-detects the categorical
    # labels when `groupings is None`, and handing it a list would silence that — on a store whose
    # clustering is numeric and whose annotations are categorical, naming just the clustering would
    # drop every annotation's stats. `primary` adds the clustering without that cost.
    groupings = (named + [n for n in parts if n not in named]) if named else None
    return lstar.extend_for_viewer(ds, groupings=groupings, counts=counts, primary=primary)
