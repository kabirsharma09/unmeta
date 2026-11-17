#!/usr/bin/env bash
# Every automated check, in one place. Run before committing:  scripts/verify.sh
# Exit code is non-zero if anything fails. The end-to-end browser run is described in .claude/skills/verify/SKILL.md.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin/python
step() { printf '\n== %s\n' "$1"; }

step "Python: engine, server, pages, security headers"
$PY -m pytest -q

step "TypeScript engine: photos, video, audio, documents, previews, properties, fuzzing"
( cd engine && npm test --silent 2>&1 | grep -E "^ℹ (tests|pass|fail)" )
( cd engine && npm test --silent >/dev/null 2>&1 ) || { echo "engine tests failed"; exit 1; }

step "Typecheck: engine has no type errors"
if ( cd engine && npx tsc --noEmit -p . 2>&1 | grep "src/" ); then echo "engine type errors"; exit 1; fi
echo "ok"

step "Browser bundle matches the engine source"
( cd engine && npm run build:web --silent >/dev/null )
git diff --quiet -- metaclean/static/engine.worker.js || { echo "engine.worker.js was stale: rebuilt it, commit the change"; exit 1; }
echo "ok"

step "Translations: every language passes its checks"
for l in $($PY -c "from metaclean.i18n import LANGS; print(' '.join(m.LANG.lower() for m in LANGS.values()))"); do
  $PY scripts/check_translation.py "$l" | tail -1
done

step "Static export builds, with a policy for every page"
OUT="$(mktemp -d)/site"
$PY -c "
from metaclean.server import export
from metaclean.pages import PAGES
files = export('$OUT', 'https://unmeta.example')
h = open('$OUT/_headers').read()
assert all(f'/{p[\"slug\"]}/*' in h for p in PAGES), 'page without a policy'
assert \"connect-src 'none'\" in open('$OUT/index.html').read()
print(len(files), 'files ok')
"
rm -rf "$(dirname "$OUT")"

step "Served pages carry the security headers"
$PY - <<'PY'
from metaclean.server import create_app
from metaclean.pages import PAGES
from metaclean.i18n import TRANSLATED
c = create_app().test_client()
paths = ["/"] + [f"/{p['slug']}/" for p in PAGES] + [f"/{s}/" for s in TRANSLATED]
for path in paths:
    r = c.get(path)
    csp = r.headers["Content-Security-Policy"]
    assert r.status_code == 200 and "connect-src 'none'" in csp and "frame-ancestors 'none'" in csp, path
    for h in ["X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy", "Cross-Origin-Opener-Policy"]:
        assert h in r.headers, (path, h)
print(f"{len(paths)} pages ok")
PY

printf '\nAll automated checks passed. Now run the end-to-end check (see .claude/skills/verify/SKILL.md).\n'
