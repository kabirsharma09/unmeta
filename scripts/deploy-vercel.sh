#!/usr/bin/env bash
# Build the static site and deploy it to Vercel.
#   scripts/deploy-vercel.sh https://your.domain          # production
#   scripts/deploy-vercel.sh https://your.domain preview  # a preview deployment
# Note: Vercel makes the very first deployment of a new project a production one, even without --prod.
# The public URL sets canonical links, the sitemap and HSTS. The export carries vercel.json with the security headers.
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${1:?usage: scripts/deploy-vercel.sh https://your.domain [preview]}"
OUT=build/unmeta
.venv/bin/unmeta export "$OUT" --public-url "$URL"
cd "$OUT"
vercel link --yes --project unmeta >/dev/null
if [ "${2:-}" = "preview" ]; then vercel deploy --yes; exit; fi
vercel deploy --prod --yes
cd ../..
.venv/bin/python scripts/indexnow.py "$OUT" "$URL"   # tell Bing and other IndexNow engines what changed
