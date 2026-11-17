"""Translated pages. Each module here (es.py, de.py, …) holds one language:

    LANG    BCP 47 code used for <html lang> and hreflang ("es", "pt-BR", …); its URL prefix is LANG.lower()
    LOCALE  Open Graph locale ("es_ES")
    NAME    the language's own name ("Español")
    UI      {English text in the shared page template: translation}
    PAGES   page dicts shaped like metaclean.pages.PAGES, plus "key": the English page they translate
            ("" for the home page). Their slug starts with the URL prefix: "es" for the home page, "es/…" for others.

The working tool is the same on every page; only the words around it change.
"""
from __future__ import annotations

import importlib
import pkgutil

LANGS: dict = {}
for _m in pkgutil.iter_modules(__path__):
    _mod = importlib.import_module(f"{__name__}.{_m.name}")
    LANGS[_mod.LANG] = _mod

# slug -> (module, page)
TRANSLATED = {p["slug"]: (mod, p) for mod in LANGS.values() for p in mod.PAGES}


def english_path(key: str) -> str:
    return "/" if not key else f"/{key}/"


def alternates(key: str) -> dict[str, str]:
    """Every language's path for one page, English included."""
    out = {"en": english_path(key)}
    for lang, mod in LANGS.items():
        for p in mod.PAGES:
            if p["key"] == key:
                out[lang] = f"/{p['slug']}/"
    return out
