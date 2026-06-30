#!/usr/bin/env bash
# Build + deploy the static viewer to the pklab droppoint.
#   served at:  https://pklab.med.harvard.edu/peterk/pagoda3/
#   rsync dest: pklab:public_html/pagoda3/
#
# Notes on this host: it sits behind Imperva Incapsula (a WAF). A real browser passes the JS challenge and HTTP Range
# (206) works — verified — so zarr loads. curl/non-browser clients get a challenge page, so don't test serving with curl.
# There is NO CORS, so the viewer and any data it opens must be SAME-ORIGIN (both on pklab). HTTPS, valid cert, HTTP/2.
#
# Usage:
#   server/deploy.sh            # build + push the app bundle (+ gene-set assets); protects the deployed sample store
#   server/deploy.sh --sample   # also (re)push the bare-URL demo store real.lstar.zarr (~95M)
set -euo pipefail
BASE=/peterk/pagoda3/
DEST=pklab:public_html/pagoda3/
cd "$(dirname "$0")/../web"

echo "building (base=$BASE) …"
npx vite build --base="$BASE"

echo "pushing bundle + gene-set assets (excluding the bulky dev *.lstar.zarr fixtures in public/) …"
# --delete prunes stale hashed assets; --exclude protects the deployed *.lstar.zarr from deletion too.
rsync -az --delete --exclude='*.lstar.zarr' --exclude='*.zip' --exclude='*.h5ad' --exclude='share/' dist/ "$DEST"

if [ "${1:-}" = "--sample" ]; then
  echo "pushing demo store real.lstar.zarr (~95M, no -z; zarr is already compressed) …"
  rsync -a dist/real.lstar.zarr "$DEST"
fi

echo "done → https://pklab.med.harvard.edu/peterk/pagoda3/"
