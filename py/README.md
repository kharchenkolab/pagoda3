# pagoda3 (python)

Launcher + browsable-store prep for the [pagoda3](../README.md) single-cell viewer.

```python
import pagoda3
pagoda3.view(adata, prepare=True)      # convert via lstar -> prepare -> open the browser viewer
pagoda3.write_viewer(ds)                # precompute the navigators on an lstar.Dataset
```

lstar is the substrate (format conversion + compute kernels); pagoda3 owns the viewer policy.
