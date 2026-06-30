# pagoda3 (python)

Launcher + browsable-store prep for the [pagoda3](../README.md) single-cell viewer.

```python
import pagoda3
pagoda3.view(adata)                    # convert via lstar -> precompute navigators -> open the viewer
pagoda3.view("sample.lstar.zarr")      # serve an existing L* store and open the viewer at it
pagoda3.write_viewer(ds)               # just precompute the navigators on an lstar.Dataset
```

`view()` is **standalone** — no repo checkout, no build step. It serves the store locally with a tiny
byte-range + CORS HTTP server (`pagoda3.serve`) and opens the **hosted** viewer (a static web app)
pointed at it via `?store=`. The viewer reads the store over range requests; nothing is uploaded.

- `pagoda3.view(adata)` accepts an AnnData, an `lstar.Dataset`, or any object lstar can read. Raw
  counts are auto-detected (`adata.layers['counts']`, else `adata.X` when it holds integer counts).
- `viewer=` / `$PAGODA3_VIEWER` points at a different viewer build; `prepare=False` skips the
  navigator precompute (the viewer then computes them live).

From the shell:

```bash
pagoda3 view sample.lstar.zarr           # serve + open the viewer
pagoda3 serve sample.lstar.zarr          # serve only (Range + CORS); print the store URL
```

**Remote / HPC.** If the kernel runs over SSH (a JupyterHub/OOD node), there is no local browser and
`localhost` on the node isn't your laptop. `view()` detects this, skips the auto-open, and prints the
`ssh -L` port-forward to run on your machine so the viewer there can reach the node's store server.

lstar is the substrate (format conversion + compute kernels); pagoda3 owns the viewer policy.
