"""pagoda3 store prep — `write_viewer` precomputes the *global* navigators the viewer opens with.

The viewer@0.1 navigators (cluster stats, 1-vs-rest markers, a whole-dataset `od_score`, the
cell-major counts copy + its cluster-contiguous order) are general-purpose, so the *computation*
lives in **lstar** (`lstar.extend_for_viewer`, on the shared C++/WASM core) and is byte-identical to
what the browser computes live and what the JS/R preps write. pagoda3 keeps only the *policy*: which
annotations to summarize. So `write_viewer` is a thin wrapper that picks the groupings and calls lstar.

Everything *scope-dependent* — selection DE, subset HVG — is left to the viewer's on-the-fly compute,
because a global gene subset is wrong for a local question.
"""
import lstar


def write_viewer(ds, grouping="leiden", counts="counts", engine="auto", also=()):
    """Add the `viewer@0.1` profile (navigator fields) to an lstar dataset; returns ds.

    Thin policy wrapper over :func:`lstar.extend_for_viewer` (the shared recipe): precomputes stats +
    markers for ``[grouping, *also]`` plus the global ``od_score`` and the cell-major counts copy.
    """
    groupings = list(dict.fromkeys([grouping, *also]))
    return lstar.extend_for_viewer(ds, groupings=groupings)
