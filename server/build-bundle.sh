#!/usr/bin/env bash
# Vendor the built viewer into the pagoda3 packages for same-origin serving (Phase 2/3).
# Builds the SPA with a RELATIVE base (`npm run build` = `vite build --base=./`) so the bundle works
# at ANY path — a host root (local mode) or a subpath (a published folder at https://host/share/) —
# then copies it into py/src/pagoda3/_viewer (and r/inst/viewer), MINUS the demo *.lstar.zarr stores.
# Run before building a wheel / R package. The _viewer dirs are gitignored (regenerated here), so a
# source checkout falls back to web/dist via pagoda3.bundle.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"     # lstar-viewer/
WEB="$HERE/web"
PY_DEST="$HERE/py/src/pagoda3/_viewer"
R_DEST="$HERE/r/inst/viewer"

echo "[build-bundle] building viewer (base=/) ..."
( cd "$WEB" && npm run build >/dev/null )

for DEST in "$PY_DEST" "$R_DEST"; do
  echo "[build-bundle] vendoring -> ${DEST#$HERE/}"
  rm -rf "$DEST"
  mkdir -p "$DEST"
  # everything except data (the user brings their own): the demo stores + any packed zips
  rsync -a --exclude='*.lstar.zarr' --exclude='*.zip' "$WEB/dist/" "$DEST/"
done

echo "[build-bundle] done. bundle size: $(du -sh "$PY_DEST" | cut -f1)"
