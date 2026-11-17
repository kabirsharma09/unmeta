"""Renders the landing pages and guides (metaclean/pages.py) from the home page template.

The home page (static/index.html) is the template: every page keeps the working tool at the top and the app screens,
and swaps in its own title, description, headline, body, FAQ, breadcrumbs and structured data.
"""
from __future__ import annotations

import html as _html
import json
import re

from .pages import BY_SLUG, PAGES, UPDATED

SITE_NAME = "UnMeta"
REPO = "https://github.com/kabirsharma09/unmeta"


def page_path(slug: str) -> str:
    return f"/{slug}/"


def page_links_translated(mod) -> str:
    """Footer for a translated page: that language's pages, then UnMeta's own pages, in its words."""
    t = lambda en: _html.escape(mod.UI.get(en) or en)
    own = "".join(f'<li><a href="/{p["slug"]}/">{_html.escape(p["nav"])}</a></li>' for p in mod.PAGES)
    info = [p for p in PAGES if p.get("kind") == "info"]
    about = "".join(f'<li><a href="{page_path(p["slug"])}" lang="en">{t(p["nav"])}</a></li>' for p in info)
    about += (f'<li><a href="{REPO}" rel="noopener noreferrer" lang="en">' + t("Source code") + '</a></li>'
              '<li><a href="/llms.txt" lang="en">' + t("For AI assistants") + '</a></li>'
              f'<li><button class="text-btn" type="button" data-open-about>{t("What UnMeta can and can\'t do")}</button></li>')
    return (f'<div class="foot-col"><p class="label">{t("Remove")}</p><ul>{own}</ul></div>'
            f'<div class="foot-col"><p class="label">UnMeta</p><ul>{about}</ul></div>')


def page_links() -> str:
    """Footer: every page, grouped, so each one is linked from everywhere (crawlers follow these)."""
    groups = [("Remove", [p for p in PAGES if p.get("kind", "tool") == "tool"]),
              ("Guides", [p for p in PAGES if p.get("kind") == "guide"]),
              ("UnMeta", [p for p in PAGES if p.get("kind") == "info"])]
    out = []
    for title, items in groups:
        links = "".join(f'<li><a href="{page_path(p["slug"])}">{_html.escape(p["nav"])}</a></li>' for p in items)
        if title == "UnMeta":
            links += (f'<li><a href="{REPO}" rel="noopener noreferrer">Source code</a></li>'
                      '<li><a href="/llms.txt">For AI assistants</a></li>'
                      '<li><button class="text-btn" type="button" data-open-about>What UnMeta can and can\'t do</button></li>')
        out.append(f'<div class="foot-col"><p class="label">{title}</p><ul>{links}</ul></div>')
    return "".join(out)


def _faq_html(faq) -> str:
    if not faq:
        return ""
    items = "".join(
        f'<details class="qa"><summary><h3 class="qa-q">{_html.escape(q)}<span class="pm" aria-hidden="true"></span></h3></summary>'
        f'<div class="qa-a"><p>{_html.escape(a)}</p></div></details>' for q, a in faq)
    return ('<section class="sec faq" id="faq" aria-labelledby="faqTitle"><div class="sec-body">'
            '<h2 id="faqTitle" class="headline reveal">Questions people ask</h2>'
            f'<div class="faq-list reveal">{items}</div></div></section>')


def _steps_html(steps) -> str:
    if not steps:
        return ""
    lis = "".join(f"<li><h3>{_html.escape(t)}</h3><p>{_html.escape(d)}</p></li>" for t, d in steps)
    return ('<section class="sec" id="how" aria-labelledby="howTitle"><div class="sec-body">'
            '<h2 id="howTitle" class="headline reveal">How to do it</h2>'
            f'<ol class="stepcards reveal">{lis}</ol></div></section>')


def _related_html(page) -> str:
    rel = page.get("related_pages") or [BY_SLUG[s] for s in page.get("related", []) if s in BY_SLUG]
    if not rel:
        return ""
    lis = "".join(f'<li><a href="{page_path(p["slug"])}"><span>{_html.escape(p["nav"])}</span>'
                  f'<span class="muted">{_html.escape(p["description"])}</span></a></li>' for p in rel)
    return ('<section class="sec" aria-labelledby="relTitle"><div class="sec-body">'
            '<h2 id="relTitle" class="headline reveal">Related</h2>'
            f'<ul class="related reveal">{lis}</ul></div></section>')


STATS = [("0 bytes", "of your files sent anywhere. The page is blocked from uploading."),
         ("4 GB", "videos and recordings, with no daily limit and no sign-up."),
         ("30+", "formats: photos, RAW, video, audio, PDF and Office."),
         ("1:1", "picture and sound, byte for byte. Checked on every copy.")]

VS = [("Where your file goes", "Stays in your browser", "Uploaded to their server"),
      ("Picture and sound", "Untouched, checked byte for byte", "Often re-saved or re-compressed"),
      ("Limits", "None per day. Videos up to 4 GB", "A few files a day, or a size cap"),
      ("Account and ads", "No account, no ads, no tracking", "Sign-up for more, ads on the page"),
      ("AI labels (C2PA, IPTC)", "Found and removed", "Often missed"),
      ("Proof", "Works with Wi-Fi off; every copy re-checked", "Trust their privacy policy")]


def shared_html() -> str:
    """Blocks every tool page and guide carries: the numbers, and how UnMeta differs from upload-based removers."""
    stats = "".join(f"<li><b>{_html.escape(n)}</b><span>{_html.escape(t)}</span></li>" for n, t in STATS)
    rows = "".join(f'<tr><th scope="row">{_html.escape(a)}</th><td class="us" data-h="UnMeta">{_html.escape(b)}</td>'
                   f'<td data-h="Most online removers">{_html.escape(c)}</td></tr>' for a, b, c in VS)
    return (f'<section class="stats reveal" aria-label="UnMeta in numbers"><ul>{stats}</ul></section>'
            '<section class="sec" id="versus" aria-labelledby="vsTitle"><div class="sec-body">'
            '<h2 id="vsTitle" class="headline reveal">Why not any online metadata remover?</h2>'
            '<p class="lead reveal">Most of them upload your file to clean it. UnMeta does the same job without the file ever leaving your device.</p>'
            '<div class="vs-wrap reveal" role="region" aria-label="UnMeta compared with upload-based removers" tabindex="0">'
            '<table class="vs"><thead><tr><th scope="col"><span class="vh">Question</span></th><th scope="col" class="us">UnMeta</th>'
            f'<th scope="col">Most online removers</th></tr></thead><tbody>{rows}</tbody></table></div>'
            '<p class="vs-note reveal">See the <a href="/compare/">side-by-side with named tools</a>.</p></div></section>')


def body_html(page) -> str:
    shared = shared_html() if page.get("kind", "tool") in ("tool", "guide") else ""
    return "".join(page["body"]) + _steps_html(page.get("steps")) + shared + _faq_html(page.get("faq")) + _related_html(page)


def crumbs_html(page) -> str:
    trail = ['<a href="/">UnMeta</a>']
    if page.get("kind") == "guide":
        trail.append("<span>Guides</span>")
    trail.append(f'<span aria-current="page">{_html.escape(page["nav"])}</span>')
    sep = ' <span aria-hidden="true">/</span> '
    return f'<nav class="crumbs label" aria-label="Breadcrumb">{sep.join(trail)}</nav>'


def jsonld(page, base: str, app_node: dict) -> dict:
    url = f"{base}{page_path(page['slug'])}"
    graph = [
        {"@type": "WebPage", "@id": f"{url}#page", "url": url, "name": re.sub(r"\s*\|\s*UnMeta$", "", page["title"]),
         "description": page["description"], "inLanguage": "en-GB", "dateModified": UPDATED,
         "isPartOf": {"@id": f"{base}/#site"}, "breadcrumb": {"@id": f"{url}#crumbs"},
         "about": {"@id": app_node.get("@id", "#app")}, "publisher": {"@id": f"{base}/#org"}},
        {"@type": "BreadcrumbList", "@id": f"{url}#crumbs", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "UnMeta", "item": f"{base}/"},
            {"@type": "ListItem", "position": 2, "name": page["nav"], "item": url}]},
        {"@type": "WebSite", "@id": f"{base}/#site", "url": f"{base}/", "name": SITE_NAME, "publisher": {"@id": f"{base}/#org"}},
        {"@type": "Organization", "@id": f"{base}/#org", "name": SITE_NAME, "url": f"{base}/",
         "logo": f"{base}/static/icon-512.png"},
        app_node,
    ]
    if page.get("kind") == "guide":
        graph.append({"@type": "Article", "@id": f"{url}#article", "headline": re.sub("<[^>]+>", "", page["h1"]),
                      "description": page["description"], "dateModified": UPDATED, "inLanguage": "en-GB",
                      "author": {"@id": f"{base}/#org"}, "publisher": {"@id": f"{base}/#org"}, "mainEntityOfPage": {"@id": f"{url}#page"},
                      "image": f"{base}/static/og.png"})
    if page.get("faq"):
        graph.append({"@type": "FAQPage", "@id": f"{url}#faq", "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in page["faq"]]})
    if page.get("steps"):
        graph.append({"@type": "HowTo", "name": re.sub("<[^>]+>", "", page["h1"]), "tool": {"@type": "HowToTool", "name": SITE_NAME},
                      "step": [{"@type": "HowToStep", "position": i + 1, "name": t, "text": d} for i, (t, d) in enumerate(page["steps"])]})
    return {"@context": "https://schema.org", "@graph": graph}


def render(index_html: str, page, base: str) -> str:
    """Turn the home page into one landing page."""
    h = index_html
    esc = _html.escape
    h = re.sub(r"<title>.*?</title>", f"<title>{esc(page['title'])}</title>", h, count=1, flags=re.S)
    for attr, val in (('name="description"', page["description"]), ('property="og:description"', page["description"]),
                      ('property="og:title"', page["title"])):
        h = re.sub(rf'<meta {attr} content="[^"]*">', f'<meta {attr} content="{esc(val)}">', h, count=1)
    path = page_path(page["slug"])
    # this page's own share card (Hindi pages reuse their English one)
    from pathlib import Path as _P
    og_dir = _P(__file__).parent / "static" / "og"
    chosen = ""
    for slug in (page["slug"], page.get("key") or ""):
        card = slug.replace("/", "--") + ".png"
        if slug and (og_dir / card).is_file():
            chosen = f"/static/og/{card}"
            h = h.replace("/static/og.png", chosen)
            alt = _html.unescape(re.sub("<[^>]+>", "", page["h1"]).replace("&nbsp;", " ")).rstrip(".")
            alt += "" if alt.endswith(("?", "!")) else "."
            h = re.sub(r'<meta property="og:image:alt" content="[^"]*">',
                       f'<meta property="og:image:alt" content="{esc(alt)} UnMeta.">', h, count=1)
            break
    h = h.replace(f'<link rel="canonical" href="{base}/">', f'<link rel="canonical" href="{base}{path}">')
    h = h.replace(f'<meta property="og:url" content="{base}/">', f'<meta property="og:url" content="{base}{path}">')
    # the software node from the home page's structured data, reused so every page describes the same app
    m = re.search(r'(<script type="application/ld\+json">)(.*?)(</script>)', h, re.S)
    home = json.loads(m.group(2))
    app_node = next(n for n in home["@graph"] if n.get("@type") == "SoftwareApplication")
    ld = json.dumps(jsonld(page, base, app_node), indent=2, ensure_ascii=False)
    h = h[:m.start(2)] + "\n" + ld + "\n" + h[m.end(2):]
    if chosen:
        h = h.replace("/static/og.png", chosen)
    h = re.sub(r'<h1 id="homeTitle" class="display">.*?</h1>',
               f'<h1 id="homeTitle" class="display display-sm">{page["h1"]}</h1>', h, count=1, flags=re.S)
    h = re.sub(r'<p id="heroLead" class="lead">.*?</p>', f'<p id="heroLead" class="lead">{esc(page["lead"])}</p>', h, count=1, flags=re.S)
    h = h.replace("<!--CRUMBS-->", crumbs_html(page), 1)
    h = re.sub(r'\s*<p class="eyebrow">.*?</p>', "", h, count=1)  # the breadcrumb says where you are
    a, z = h.index("<!--PAGE-BODY-->"), h.index("<!--/PAGE-BODY-->")
    h = h[:a] + body_html(page) + h[z + len("<!--/PAGE-BODY-->"):]
    return h


def home_extras(index_html: str, base: str) -> str:
    """Home page: add the site and organisation to its structured data, and drop the template markers."""
    m = re.search(r'(<script type="application/ld\+json">)(.*?)(</script>)', index_html, re.S)
    data = json.loads(m.group(2))
    ids = {n.get("@id") for n in data["@graph"]}
    if f"{base}/#site" not in ids:
        data["@graph"] += [{"@type": "WebSite", "@id": f"{base}/#site", "url": f"{base}/", "name": SITE_NAME,
                            "publisher": {"@id": f"{base}/#org"}},
                           {"@type": "Organization", "@id": f"{base}/#org", "name": SITE_NAME, "url": f"{base}/",
                            "logo": f"{base}/static/icon-512.png"}]
    h = index_html[:m.start(2)] + "\n" + json.dumps(data, indent=2, ensure_ascii=False) + "\n" + index_html[m.end(2):]
    h = h.replace("<!--SHARED-->", shared_html(), 1)
    return h.replace("<!--CRUMBS-->", "").replace("<!--PAGE-BODY-->\n", "").replace("<!--/PAGE-BODY-->\n", "")


def sitemap_urls(base: str) -> list[str]:
    from . import i18n
    return ([f"{base}/"] + [f"{base}{page_path(p['slug'])}" for p in PAGES]
            + [f"{base}/{slug}/" for slug in i18n.TRANSLATED])


def llms_pages(base: str) -> str:
    return "\n".join(f"- [{p['nav']}]({base}{page_path(p['slug'])}): {p['description']}" for p in PAGES)


def _text(h: str) -> str:
    """HTML from pages.py as plain Markdown-ish text: tables become rows, lists become bullets."""
    h = re.sub(r"</t[hd]>\s*<t[hd][^>]*>", " | ", h)
    h = re.sub(r"<tr>", "\n| ", h)
    h = re.sub(r"<li>", "\n- ", h)
    h = re.sub(r"</p>|</ul>|</table>|</div>", "\n", h)
    h = re.sub(r"<[^>]+>", "", h)
    h = _html.unescape(h)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(line.rstrip() for line in h.splitlines())).strip()


def llms_full(base: str) -> str:
    """Every page's full text in one file, for AI assistants that read /llms-full.txt."""
    out = []
    for p in PAGES:
        sections = []
        for block in p["body"]:
            m = re.search(r'<h2[^>]*>(.*?)</h2>', block, re.S)
            title = _html.unescape(re.sub("<[^>]+>", "", m.group(1))) if m else ""
            sections.append(f"### {title}\n\n{_text(block[m.end():] if m else block)}")
        steps = "".join(f"\n{i + 1}. {t}: {d}" for i, (t, d) in enumerate(p.get("steps") or []))
        faq = "".join(f"\n\n**{q}**\n{a}" for q, a in p.get("faq") or [])
        out.append(f"## {_html.unescape(re.sub('<[^>]+>', '', p['h1']))}\n\nURL: {base}{page_path(p['slug'])}\n\n{p['lead']}\n\n"
                   + "\n\n".join(sections)
                   + (f"\n\n### How to do it{steps}" if steps else "")
                   + (f"\n\n### Questions{faq}" if faq else ""))
    return "\n\n---\n\n".join(out) + "\n"


# ---------------------------------------------------------------- translated pages
from . import i18n as _i18n  # noqa: E402


def hreflang_links(key: str, base: str) -> str:
    alts = _i18n.alternates(key)
    if len(alts) < 2:
        return ""
    links = "".join(f'<link rel="alternate" hreflang="{lang}" href="{base}{path}">\n' for lang, path in alts.items())
    return links + f'<link rel="alternate" hreflang="x-default" href="{base}{alts["en"]}">\n'


def add_hreflang(h: str, key: str, base: str) -> str:
    """English pages that have translations: alternates in the head, language links in the footer."""
    h = h.replace("</head>", hreflang_links(key, base) + "</head>", 1)
    return h.replace('<nav class="foot-nav"', lang_links(key) + '\n    <nav class="foot-nav"', 1)


def _swap_text(h: str, en: str, tr: str) -> str:
    e = re.escape(_html.escape(en, quote=False))
    h = re.sub(rf">(\s*){e}(\s*)<", lambda m: f">{m.group(1)}{_html.escape(tr, quote=False)}{m.group(2)}<", h)
    a = _html.escape(en, quote=True)
    for attr in ("aria-label", "data-h"):
        h = h.replace(f'{attr}="{a}"', f'{attr}="{_html.escape(tr, quote=True)}"')
    return h


def render_translated(index_html: str, mod, page, base: str) -> str:
    """A translated page: the English template with its own words, then the shared text swapped for the language's."""
    by_key = {p["key"]: p for p in mod.PAGES}
    page = {**page, "related_pages": [by_key[k] for k in page.get("related", []) if k in by_key]}
    head, body = render(index_html, page, base).split("</head>", 1)
    lang, prefix = mod.LANG, mod.LANG.lower()
    head = head.replace('<html lang="en-GB"', f'<html lang="{lang}"').replace('"inLanguage": "en-GB"', f'"inLanguage": "{lang}"')
    head = re.sub(r'<meta property="og:locale" content="[^"]*">', f'<meta property="og:locale" content="{mod.LOCALE}">', head)
    head += hreflang_links(page["key"], base)
    for en, tr in sorted(mod.UI.items(), key=lambda kv: -len(kv[0])):
        if tr and tr != en:
            body = _swap_text(body, en, tr)
    # links to pages that exist in this language go to that language
    for p in mod.PAGES:
        body = body.replace(f'href="{_i18n.english_path(p["key"])}"', f'href="/{p["slug"]}/"')
    body = body.replace('<a href="/">UnMeta</a>', f'<a href="/{prefix}/">UnMeta</a>')
    body = body.replace("<!--PAGE-LINKS-->", page_links_translated(mod), 1)
    body = body.replace('<nav class="foot-nav"', lang_links(page["key"]) + '\n    <nav class="foot-nav"', 1)
    return head + "</head>" + body


def _lang_name(code: str) -> str:
    return "English" if code == "en" else _i18n.LANGS[code].NAME


def lang_links(key: str) -> str:
    """The same page in other languages, for the footer."""
    alts = _i18n.alternates(key)
    if len(alts) < 2:
        return ""
    return '<p class="foot-langs">' + " · ".join(
        f'<a href="{path}" hreflang="{code}" lang="{code}">{_html.escape(_lang_name(code))}</a>' for code, path in alts.items()) + "</p>"
