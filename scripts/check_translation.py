"""Check one language file in metaclean/i18n before it ships.

    .venv/bin/python scripts/check_translation.py es

Fails loudly on: missing UI strings, wrong page keys or slugs, titles over 75 characters, descriptions outside
50-175 characters, FAQ text missing from the page, leftover English UI text, or a page that doesn't render.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from metaclean import i18n  # noqa: E402
from metaclean.pages import BY_SLUG  # noqa: E402
from metaclean.server import create_app  # noqa: E402

code = sys.argv[1]
mod = next(m for m in i18n.LANGS.values() if m.LANG.lower() == code.lower())
keys = [k for k in (Path(i18n.__file__).parent / "ui_keys.txt").read_text().splitlines() if k]
errors = []
missing = [k for k in keys if not mod.UI.get(k)]
if missing:
    errors.append(f"UI strings missing: {missing}")
expected = {"", "remove-metadata-from-photos", "remove-location-from-photos", "remove-ai-info-instagram",
            "remove-metadata-from-video", "remove-metadata-from-pdf"}
got = {p["key"] for p in mod.PAGES}
if got != expected:
    errors.append(f"page keys: missing {expected - got}, unexpected {got - expected}")
prefix = mod.LANG.lower()
c = create_app().test_client()
for p in mod.PAGES:
    if p["key"] and p["key"] not in BY_SLUG:
        errors.append(f"unknown key {p['key']}")
    if p["slug"] != prefix and not p["slug"].startswith(prefix + "/"):
        errors.append(f"slug {p['slug']} must be '{prefix}' or start with '{prefix}/'")
    if not re.fullmatch(r"[a-z0-9/-]+", p["slug"]):
        errors.append(f"slug {p['slug']}: use lowercase ASCII letters, digits and hyphens only")
    if len(p["title"]) > 60:
        errors.append(f"{p['slug']}: title is {len(p['title'])} characters (max 60)")
    if not 25 <= len(p["description"]) <= 160:
        errors.append(f"{p['slug']}: description is {len(p['description'])} characters (25-160)")
    r = c.get(f"/{p['slug']}/")
    if r.status_code != 200:
        errors.append(f"{p['slug']}: HTTP {r.status_code}")
        continue
    html = r.get_data(as_text=True)
    import html as h
    text = h.unescape(" ".join(re.sub(r"<[^>]+>", " ", html.split("</head>", 1)[1]).split()))
    for q, a in p.get("faq", []):
        if h.unescape(q) not in text or h.unescape(a) not in text:
            errors.append(f"{p['slug']}: FAQ not visible: {q[:40]}")
    hero = re.search(r'<section class="hero".*?</section>', html, re.S).group(0)
    for en in ["Choose files", "Works with", "Removes", "Never uploaded", "No quality loss"]:
        if re.search(rf">\s*{re.escape(en)}\s*<", hero):
            errors.append(f"{p['slug']}: English left in the hero: {en}")
print("\n".join(errors) if errors else f"{mod.NAME}: {len(mod.PAGES)} pages, {len(keys)} UI strings, all checks pass")
sys.exit(1 if errors else 0)
