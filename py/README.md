# pagoda3 (python)

Launcher + browsable-store prep for the [pagoda3](../README.md) single-cell viewer.

```python
import pagoda3
pagoda3.view(adata)                    # convert via lstar -> precompute navigators -> open the viewer
pagoda3.view("sample.lstar.zarr")      # serve an existing L* store and open the viewer at it
pagoda3.write_viewer(ds)               # just precompute the navigators on an lstar.Dataset
```

`view()` is **standalone** — no repo checkout, no build step — and serves over a tiny byte-range + CORS
HTTP server (`pagoda3.serve`); nothing is uploaded. Two modes:

- **local** (default when a viewer bundle ships with the package): the viewer app *and* the store are
  served from one local origin (`/` and `/store/`) → no CORS, no `https→http` mixed content, works
  offline. Robust everywhere, including Safari.
- **hosted** (`local=False`, or when no bundle is present): the store is served locally and opened in
  the hosted viewer build via `?store=` (a cross-origin read).

Other options:
- `pagoda3.view(adata)` accepts an AnnData, an `lstar.Dataset`, or any object lstar can read. Raw
  counts are auto-detected (`adata.layers['counts']`, else `adata.X` when it holds integer counts).
- `local=True`/`False` forces the mode; `viewer=` / `$PAGODA3_VIEWER` points at a different hosted
  build; `prepare=False` skips the navigator precompute (the viewer then computes them live).

From the shell:

```bash
pagoda3 view sample.lstar.zarr           # serve + open the viewer
pagoda3 serve sample.lstar.zarr          # serve only (Range + CORS); print the store URL
pagoda3 publish sample.lstar.zarr ./share  # package a self-contained shareable folder
```

**Share a result as a link.** `pagoda3.publish(adata, "./share")` writes a **self-contained** folder
(the viewer bundle + the store, same-origin) you can drop on *any* static host — a lab webserver, S3,
a departmental share. Anyone opens `<host-url>/?store=store/` and sees the data — **no install**, no
CORS, no firewall games. To share an *exact view* (this colouring, this DE), open the published link,
set up the view, and click the viewer's **Share** button (🔗) — it copies a compact `?view=` deep-link
that reopens that precise view. (`bundle=False` writes only the store, to pair with a hosted viewer.)

**Remote / HPC.** If the kernel runs over SSH (a JupyterHub/OOD node), there is no local browser and
`localhost` on the node isn't your laptop. `view()` detects this, skips the auto-open, and prints the
`ssh -L` port-forward to run on your machine so the viewer there can reach the node's store server.

lstar is the substrate (format conversion + compute kernels); pagoda3 owns the viewer policy.
