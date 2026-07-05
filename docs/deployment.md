# Installing & deploying pagoda3

pagoda3 is a viewer for single-cell data that runs **in your web browser**. There is no database and no
analysis server: the app fetches only the parts of a dataset it needs, directly over ordinary web
requests. When you open a file from your own computer, the data never leaves your machine.

This guide covers the ways to run and share it, from "just look at a file" to "host it for a whole lab."
Pick the row that matches what you want to do.

| I want to… | Use | Anything to install? |
|---|---|---|
| Take a quick look at a file | [Open it in a browser](#1-open-a-file-in-your-browser) | No |
| Open a dataset from a Python or R session | [Launch from Python / R](#2-launch-from-python-or-r) | The `pagoda3` package |
| Send a dataset to a colleague | [Share a dataset](#3-share-a-dataset) | The `pagoda3` package (to package it) |
| Host the viewer for others to use | [Self-host the viewer](#4-self-host-the-viewer) | A static web server |
| Turn on the AI copilot | [Enable the assistant](#5-enable-the-ai-assistant-optional) | An Anthropic API key |

A few words used throughout:

- **Store** — a dataset prepared for the viewer (a folder ending in `.lstar.zarr`, or a single `.zip` of
  one). Preparing a store once makes the dataset open instantly; the viewer can also open raw files
  directly and prepare them on the fly.
- **Hosted viewer** — a public copy of the app on the web. You can point it at your own data with a link;
  your data still stays wherever you put it.
- **Same-origin** — the viewer and the data are served from the same web address. Browsers allow this
  freely, so it's the simplest, most reliable setup.

---

## 1. Open a file in your browser

The fastest way to look at a dataset. Open the viewer and **drag a file onto the page**. It reads on your
machine — nothing is uploaded, and no setup is needed.

You can drag in:

- **AnnData** — a `.h5ad` file (read directly in the browser).
- **10x Cell Ranger** output — a `.h5`, or a `matrix.mtx` / `barcodes.tsv` / `features.tsv` triplet
  (single- or multi-sample).
- A prepared **store** — a `.lstar.zarr` folder or a `.lstar.zarr.zip` file.

If the dataset has no embedding or clusters yet, the viewer computes a layout, clusters, and markers in
the browser as it loads — a bare counts matrix is enough.

---

## 2. Launch from Python or R

If your data is already in a Python or R session, hand the object to the launcher. It converts the
object, prepares a store, starts a tiny local server, and opens the viewer at it. Nothing is uploaded.

**Python** — an `AnnData`, an `lstar.Dataset`, or a store path:

```python
import pagoda3
pagoda3.view(adata)                     # convert, prepare, and open the viewer
pagoda3.view("sample.lstar.zarr")       # open an existing store
```

From a terminal:

```bash
pagoda3 view sample.lstar.zarr          # serve and open the viewer
pagoda3 serve sample.lstar.zarr         # serve only, and print the URL (e.g. on a remote machine)
```

**R** — a Seurat or SingleCellExperiment object, or a store path:

```r
library(pagoda3)
view(seurat_obj)                        # convert, prepare, and open the viewer
view("sample.lstar.zarr")               # open an existing store
```

Install the package once (Python: `pip install pagoda3`; R: install the `pagoda3` package). From a source
checkout, install the local packages in `py/` and `r/`. Already using **lstar**? `lstar.view()` /
`lstar::view()` hand straight off to pagoda3.

**On a remote machine (SSH / HPC).** If the session runs on a server, `view()` can't open a browser there.
It detects this, skips the auto-open, and prints the `ssh -L` port-forward to run on your laptop so your
local browser can reach the store on the server.

---

## 3. Share a dataset

Two ways, depending on how the other person will open it.

**Send one file to drag in.** Package the dataset as a single file:

```python
pagoda3.pack(adata, "data.lstar.zarr.zip")
```
```bash
pagoda3 pack sample.lstar.zarr          # -> sample.lstar.zarr.zip
```

The recipient opens the hosted viewer and **drags the `.zip` onto the page**. No install, no server; it
reads in their browser. (A plain `.h5ad` works this way too.)

**Publish a self-contained link.** Write a folder that holds the viewer app *and* the data together:

```python
pagoda3.publish(adata, "./share")
```
```bash
pagoda3 publish sample.lstar.zarr ./share
```

Drop that folder on **any** static web host — a lab web directory, an S3 bucket, GitHub Pages — and share
the link `https://your-host/share/?store=store/`. Because the app and the data sit at the same address
(same-origin), it just works: no install, no server-side compute, no cross-origin setup. The recipient's
browser fetches only the bytes they scroll to.

**Share an exact view.** Open a published link, set up the view you want (this colouring, this comparison,
this layout), and click the **Share** button (🔗). It copies a compact `?view=…` link that reopens that
precise view for anyone.

---

## 4. Self-host the viewer

The viewer is a static single-page app — plain files, no server-side code. To host your own copy:

```bash
cd web
npm install
npm run build            # -> web/dist/  (static files)
```

Copy `web/dist/` to any static web host. Then place your prepared store where the viewer can read it and
open `https://your-host/?store=<store-url>`.

Two things a host must allow for stores to load:

1. **Range requests** — the viewer fetches parts of files, not whole files. Almost every static host
   supports this out of the box.
2. **Same-origin, or CORS** — the simplest setup keeps the store on the **same host** as the viewer (as
   `publish` does). If the store lives on a *different* host, that host must send CORS headers allowing the
   viewer to read it.

`server/deploy.sh` is a worked example that builds the app for a specific web path and copies it to a
static host. `server/staticzarr.mjs` is a small local server for testing a store with range requests and
CORS enabled.

---

## 5. Enable the AI assistant (optional)

**The viewer is fully usable without the assistant** — every colouring, comparison, and layout is
something you can do by hand. The assistant just reaches those controls faster, and can build new panels
on request.

The assistant talks to Anthropic's Claude through a small relay (`server/proxy.mjs`) that keeps your API
key on the server side, never in the browser. To turn it on:

1. Get an [Anthropic API key](https://console.anthropic.com/).
2. Run the relay with the key set:

   ```bash
   ANTHROPIC_API_KEY=sk-ant-... node server/proxy.mjs      # listens on :8786
   ```
3. Make sure the viewer's `/api` requests reach it. In development this is automatic (see
   [below](#6-run-from-source-development)). In a deployment, route the path `/api` on your web host to the
   relay.

Do **not** put the API key in the browser or in the built files — it stays with the relay only.

---

## 6. Run from source (development)

```bash
cd web
npm install
npm run dev              # -> http://localhost:8787
```

`npm run dev` also starts the assistant relay automatically. Set `ANTHROPIC_API_KEY` in your environment
first to have the assistant work locally.

To build the installable Python and R packages (which carry a copy of the viewer so `view()` works with no
web host), run `server/build-bundle.sh`, then build the wheel (`py/`) or R package (`r/`) as usual.

---

## How the pieces fit

- **web/** — the browser viewer (the static app you build and host).
- **py/**, **r/** — the `pagoda3` packages: the `view()` launcher plus store preparation.
- **server/** — helper scripts: `proxy.mjs` (the assistant relay), `deploy.sh` (deploy the app),
  `build-bundle.sh` (bundle the viewer into the packages), `staticzarr.mjs` (a test store server).

pagoda3 builds on **lstar**, which provides the data format and the shared analysis routines. See
[architecture.md](architecture.md) for how the system is put together.
