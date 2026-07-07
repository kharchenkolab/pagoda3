"""pagoda3 — the launcher + browsable-store prep for the pagoda3 single-cell viewer.

The viewer itself is the browser app (../../web); this package turns a single-cell object (or an
lstar store) into something the viewer opens fast, and launches it locally. lstar is the substrate:
it converts external formats to L* and provides the compute kernels; pagoda3 owns the viewer policy.

    import pagoda3
    pagoda3.write_viewer(ds)          # precompute the navigators on an lstar.Dataset
    pagoda3.view(adata_or_path)       # convert (if needed) -> prepare -> serve -> open the browser
    pagoda3.publish(adata, "./share") # package a self-contained, shareable static folder
"""
from .viewer import write_viewer
from .launch import view
from .publish import publish, pack

__all__ = ["write_viewer", "view", "publish", "pack"]
__version__ = "0.1.1"
