# For the lstar agent — first-class single-file `.lstar.zarr.zip` (written STORED)

**Ask:** give lstar a way to emit (and read) a store as ONE file — `store.lstar.zarr.zip` — written with
**ZIP_STORED (no deflate)**. Today nothing in lstar reads or writes zip; users hand-roll `zip -r`, which
defaults to DEFLATE — technically valid but the wrong artifact (details below). A first-class STORED-zip
output removes that footgun.

## Why STORED specifically (not a style preference — a correctness requirement)
- Zarr chunks are already codec-compressed (blosc/zstd/gzip), so re-deflating them saves ~nothing and
  only burns CPU.
- More importantly, **only a STORED entry stays byte-range-readable inside the archive.** The whole point
  of a hosted single file is range access. zarrita ships a `ZipFileStore` (`@zarrita/storage`) that we're
  adopting for hosted `?store=….zip` in pagoda3: for a STORED entry it reads the sub-range **directly**
  (`dataOffset + range.offset`, a real HTTP Range into the zip); for a DEFLATED entry it falls back to
  fetching the WHOLE entry + inflating — i.e. a deflated zip silently defeats range access. A local drop
  (fflate, whole-archive-in-memory) hides this, so the bad artifact "looks fine" until it's hosted.

## What would help (scope to what fits lstar's surfaces + parity contract)
1. **Write**: `lstar.write(ds, "x.lstar.zarr.zip")` detects the `.zip` suffix and writes via
   `zarr.ZipStore(path, mode="w", compression=zipfile.ZIP_STORED)` (a few lines in Python). Likewise wire
   `lstar convert … x.lstar.zarr.zip` so the CLI can produce a single file.
2. **Read**: `lstar.read("x.lstar.zarr.zip")` opens the ZipStore, so it round-trips in-library (Python at
   least; the browser reads it via zarrita's ZipFileStore).
3. **Parity** (per docs/parity.md): decide the cross-surface scope. Python + CLI is the high-value core;
   R/C++ read/write of zip are nice-to-have. Whatever you pick, please make it consistent and note the
   scope in `docs/format.md` (the "Packaging → One file (.zip)" note I added there is the interim guidance;
   fold the real support into it).
4. **Guardrail**: if a store is written to `.zip`, force STORED regardless of any compressor= arg (a
   deflated `.lstar.zarr.zip` should be impossible to produce from lstar), and reject/repack a deflated one
   on read with a clear message rather than silently degrading.

## Context / who consumes it
- pagoda3 will use zarrita's `ZipFileStore.fromUrl()` for a remote `.lstar.zarr.zip` (range-preserved,
  STORED) and already reads a dropped local zip. So a STORED zip from lstar → hosted single-file viewer
  stores "for free."
- I added interim user guidance to lstar `docs/format.md` (§ Packaging) and
  `.claude/skills/lstar/reference/recipes.md` ("Package a store as one file") pointing at `zip -0` /
  `ZIP_STORED` — left uncommitted for you to review/land alongside the real support.
