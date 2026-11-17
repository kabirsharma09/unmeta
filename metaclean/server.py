"""UnMeta web app server. It only serves files: photos and videos are read and cleaned inside the visitor's
browser (static/engine.worker.js), never uploaded.

Hosting: set METACLEAN_PUBLIC_URL (or `unmeta serve --public-url`) behind HTTPS, or build a static copy with
`unmeta export` and put it on any static host. The /api/* endpoints exist only for local use and the test suite;
they are switched off whenever a public URL is set.

Hardening:
* answers only requests addressed to localhost (DNS-rebinding guard)
* every state-changing request must carry `X-MetaClean: 1`, which browsers cannot send cross-site
  without a CORS preflight this server never approves; Origin and Sec-Fetch-Site are checked too
* strict Content-Security-Policy, no framing, no referrers, no sniffing
* per-photo and total size limits, idle expiry, and an explicit forget endpoint
* zip entry names are sanitised; errors never leak internals
"""
from __future__ import annotations

import io
import logging
import re
import threading
import time
import uuid
import webbrowser
import zipfile
from collections import OrderedDict
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from flask import Flask, abort, jsonify, redirect, request, send_file
from PIL import Image, ImageOps
from werkzeug.exceptions import HTTPException

from . import presets as PR
from . import reports
from .cleaner import CleanOptions, clean_bytes
from .inspector import inspect_bytes
from . import site as SITE
from .pages import BY_SLUG, UPDATED

STATIC = Path(__file__).parent / "static"
# Files that must sit at the site root, such as search-engine ownership checks (google*.html).
ROOT_FILES = Path(__file__).parent / "root"
MAX_PHOTO_BYTES = 200 * 1024 * 1024        # one photo
MAX_STORE_BYTES = 2 * 1024 * 1024 * 1024   # everything held in memory
MAX_ITEMS = 500
IDLE_SECONDS = 30 * 60                     # forget photos nobody touched for 30 minutes
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}
# Set METACLEAN_PUBLIC_URL (e.g. https://unmeta.example) when UnMeta is hosted publicly. It turns on search
# indexing, canonical URLs, the sitemap and absolute share images. Without it the app tells crawlers to stay away.
import os
PUBLIC_URL = (os.environ.get("UNMETA_PUBLIC_URL") or os.environ.get("METACLEAN_PUBLIC_URL", "")).rstrip("/")

LLMS_TXT = """# UnMeta

> UnMeta is a free website that removes hidden metadata (GPS location, camera and serial numbers, names, dates, AI labels) from photos, videos, audio and documents inside the user's web browser, without uploading the file or changing picture or sound quality.

UnMeta reads the hidden details stored inside photo, video, audio and document files and removes them losslessly. It does all of this in the browser, so files are never uploaded. There is no account, no ads and no daily limit. After the first visit it also works offline.

Key facts: 0 bytes of the user's files are sent anywhere; photos up to 200 MB; videos and recordings up to 4 GB; 30+ formats; picture and sound data stay byte-for-byte identical, and every clean copy is re-read to check nothing private stayed.

**What it finds and removes**

- Where it was taken: GPS coordinates and place names (EXIF GPS, XMP, IPTC)
- What it was taken with: camera and phone make and model, lens, serial numbers, device names
- Who took it and when: author, copyright, owner name, capture dates and time zones, document IDs
- AI labels: C2PA Content Credentials (JUMBF), IPTC Digital Source Type (trainedAlgorithmicMedia, compositeWithTrainedAlgorithmicMedia), XMP CreatorTool and edit history, Stable Diffusion and ComfyUI prompt text in PNG files
- Hidden copies: embedded thumbnails, multi-picture data and motion-photo video

**Videos and audio**

- MP4, MOV, M4V and 3GP videos; M4A voice memos, MP3 and WAV recordings
- Removes Apple and Android location (ISO 6709), make and model, recording dates, names, XMP and C2PA boxes, ID3 tags, RIFF INFO, Broadcast WAV and iXML chunks
- Video frames and audio samples are copied byte for byte; MP4 and MOV files keep their exact size. Files up to 4 GB are read in slices, never loaded whole

**How it cleans**

- JPEG, PNG and WebP are rebuilt block by block; the compressed picture data is copied byte for byte.
- HEIC, HEIF, AVIF, TIFF and RAW are cleaned in place by blanking metadata; picture data is untouched.
- Every cleaned photo is scanned again and its picture data compared with the original.
- Colour profile and rotation are kept by default so photos look the same.

**Limits**

- It cannot remove what is visible in the picture or audible in a recording (faces, signs, reflections, voices).
- It cannot remove invisible pixel watermarks such as Google SynthID.
- Removing an AI label doesn't change how an image was made; many platforms and some laws require disclosure of AI content.

**Formats**

Photos: JPEG, PNG, WebP, HEIC, HEIF, AVIF, TIFF, DNG, CR2, CR3, NEF, ARW, ORF, RW2, RAF. Videos: MP4, MOV, M4V, 3GP. Audio: M4A, MP3, WAV. Documents: PDF, DOCX, XLSX, PPTX (author, company, template path, dates and hidden previews removed; comments and tracked changes shown, never removed).

**Privacy**

UnMeta processes files entirely in the browser (a Web Worker); the server only serves the page, and the page's Content-Security-Policy (connect-src 'none') blocks it from sending data anywhere. A service worker keeps an offline copy of the app's own files only. No accounts, cookies or analytics.
"""
# The page may not send anything anywhere (connect-src 'none'). The service worker gets its own policy: it may fetch
# UnMeta's own files from this origin, so it can keep an offline copy, and nothing else.
PAGE_CSP = ("default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' blob:; media-src blob:; "
            "font-src 'self'; manifest-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
# (CSP3's `webrtc 'block'` is not supported by Chrome and only logs console errors; WebRTC would need attacker script,
#  which script-src 'self' already rules out.)
# The engine worker reads files and posts results back; it needs nothing from the network at all.
WORKER_CSP = "default-src 'none'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'"
SW_CSP = "default-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": ("camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), "
                           "midi=(), display-capture=(), xr-spatial-tracking=(), accelerometer=(), gyroscope=(), magnetometer=(), "
                           "ambient-light-sensor=(), screen-wake-lock=(), idle-detection=(), local-fonts=(), "
                           "publickey-credentials-get=(), otp-credentials=(), attribution-reporting=(), browsing-topics=(), "
                           "join-ad-interest-group=(), run-ad-auction=(), private-state-token-issuance=(), "
                           "private-state-token-redemption=()"),
}
HSTS = "max-age=63072000; includeSubDomains"

ID_RE = re.compile(r"^[0-9a-f]{24}$")
log = logging.getLogger("unmeta")


class Store:
    """In-memory photo store with LRU eviction, a byte budget and idle expiry."""

    def __init__(self):
        self.items: OrderedDict[str, dict] = OrderedDict()
        self.lock = threading.Lock()

    def _bytes(self, it: dict) -> int:
        return len(it["data"]) + (len(it["result"].data) if it.get("result") else 0)

    def _evict(self):
        now = time.monotonic()
        for k in [k for k, v in self.items.items() if now - v["touched"] > IDLE_SECONDS]:
            del self.items[k]
        total = sum(self._bytes(v) for v in self.items.values())
        while self.items and (len(self.items) > MAX_ITEMS or total > MAX_STORE_BYTES):
            _, v = self.items.popitem(last=False)
            total -= self._bytes(v)

    def put(self, item: dict) -> str:
        key = uuid.uuid4().hex[:24]
        item["touched"] = time.monotonic()
        with self.lock:
            self.items[key] = item
            self._evict()
        return key

    def get(self, key: str) -> dict:
        if not ID_RE.match(key or ""):
            abort(404, "This photo is no longer available. Add it again.")
        with self.lock:
            it = self.items.get(key)
            if it is not None:
                it["touched"] = time.monotonic()
                self.items.move_to_end(key)
        if it is None:
            abort(404, "This photo is no longer available. Add it again.")
        return it

    def forget(self, keys) -> int:
        with self.lock:
            return sum(1 for k in keys if isinstance(k, str) and self.items.pop(k, None) is not None)

    def touch_all(self):
        with self.lock:
            self._evict()


def _safe_zip_name(name: str, fallback: str) -> str:
    """Relative path made of plain segments only (no '..', drive letters or absolute paths)."""
    parts = [p for p in PurePosixPath(str(name).replace("\\", "/")).parts if p not in ("", ".", "..", "/")]
    parts = [re.sub(r"[\x00-\x1f:*?\"<>|]", "_", p)[:120] for p in parts][-8:]
    return "/".join(parts) or fallback


def _preview(data: bytes, max_side=520) -> bytes:
    from .cleaner import _decode
    from .containers import detect_format
    fmt = detect_format(data)
    if fmt == "jpeg":
        im = Image.open(io.BytesIO(data))
        im.draft("RGB", (max_side * 2, max_side * 2))  # decode at reduced size: fast and memory-safe
        im.load()
    else:
        im = _decode(data, fmt)
    try:
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass
    im.thumbnail((max_side, max_side))
    if im.mode not in ("RGB", "L"):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        im = im.convert("RGBA")
        bg.paste(im, mask=im.split()[-1])
        im = bg
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=82)
    return buf.getvalue()


def _asset_hash(url_path: str) -> str:
    import hashlib
    p = STATIC / url_path.removeprefix("/static/")
    try:
        return hashlib.sha256(p.read_bytes()).hexdigest()[:10]
    except OSError:
        return "0"


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_PHOTO_BYTES + 1024 * 1024
    store = Store()
    app.store = store  # for tests

    @app.before_request
    def _guard():
        raw = request.host or ""
        host = raw[: raw.find("]") + 1] if raw.startswith("[") else raw.split(":")[0]
        if host not in LOCAL_HOSTS and not (PUBLIC_URL and host == (urlsplit(PUBLIC_URL).hostname or "")):
            abort(403)
        site = request.headers.get("Sec-Fetch-Site")
        page_visit = (request.method == "GET" and request.headers.get("Sec-Fetch-Mode") == "navigate"
                      and not request.path.startswith(("/api/", "/static/")))
        if site and site not in ("same-origin", "none") and not page_visit:
            abort(403)  # another website trying to embed, script or drive UnMeta (following a link to it is fine)
        if PUBLIC_URL and request.path.startswith("/api/"):
            abort(404)  # hosted: the page never uploads, so the server accepts no files at all
        if request.method in ("POST", "PUT", "DELETE", "PATCH"):
            origin = request.headers.get("Origin")
            allowed = {"127.0.0.1", "localhost", "::1"} | ({urlsplit(PUBLIC_URL).hostname} if PUBLIC_URL else set())
            if origin and (urlsplit(origin).hostname or "") not in allowed:
                abort(403)
            if request.headers.get("X-MetaClean") != "1":
                abort(403)

    @app.after_request
    def _headers(resp):
        path = request.path
        resp.headers["Content-Security-Policy"] = (SW_CSP if path == "/sw.js"
                                                   else WORKER_CSP if path == "/static/engine.worker.js" else PAGE_CSP)
        resp.headers.update(SECURITY_HEADERS)
        if PUBLIC_URL.startswith("https://"):
            resp.headers["Strict-Transport-Security"] = HSTS
        if path == "/sw.js":
            resp.headers["Cache-Control"] = "no-cache"
        elif path.startswith("/static/fonts/") or (path.startswith("/static/") and request.args.get("v")):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif path.startswith("/static/") or path in ("/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/.well-known/security.txt", "/manifest.webmanifest", "/favicon.ico"):
            resp.headers["Cache-Control"] = "public, max-age=86400"
        elif path == "/":
            resp.headers["Cache-Control"] = "no-cache"
        else:
            resp.headers["Cache-Control"] = "no-store"  # photos and reports are never cached
            resp.headers["X-Robots-Tag"] = "noindex, nofollow"
        return resp

    def _seo_head() -> str:
        if not PUBLIC_URL:
            return ('<meta name="robots" content="noindex, nofollow">\n'
                    '<meta property="og:image" content="/static/og.png">')
        u = PUBLIC_URL
        return (f'<link rel="canonical" href="{u}/">\n'
                '<meta name="robots" content="index, follow, max-image-preview:large">\n'
                f'<meta property="og:url" content="{u}/">\n'
                f'<meta property="og:image" content="{u}/static/og.png">\n'
                f'<meta name="twitter:image" content="{u}/static/og.png">\n'
                '<link rel="alternate" type="text/markdown" href="/llms.txt" title="UnMeta for AI assistants">')

    def render_index() -> str:
        html = (STATIC / "index.html").read_text(encoding="utf-8").replace("<!--SEO-HEAD-->", _seo_head())
        # cache-busting: stamp each asset with a hash of its contents, so long-lived caching never serves stale files
        html = re.sub(r'(/static/[\w./-]+\.(?:css|js))\?v=\w+', lambda m: f"{m.group(1)}?v={_asset_hash(m.group(1))}", html)
        if PUBLIC_URL:
            html = html.replace('"@id": "#app",', f'"@id": "{PUBLIC_URL}/#app",\n      "url": "{PUBLIC_URL}/",')
        return html

    def finish(html: str, key: str = "") -> str:
        html = html.replace("<!--LANG-SWITCH-->", SITE.lang_switch("en", key), 1)
        return html.replace("<!--PAGE-LINKS-->", SITE.page_links())

    @app.get("/")
    def index():
        return app.response_class(finish(SITE.add_hreflang(SITE.home_extras(render_index(), PUBLIC_URL), "", PUBLIC_URL)),
                                  mimetype="text/html")

    @app.get("/<path:slug>/")
    @app.get("/<path:slug>")
    def landing(slug):
        from . import i18n
        page = BY_SLUG.get(slug.strip("/"))
        translated = i18n.TRANSLATED.get(slug.strip("/"))
        if not page and not translated:
            abort(404)
        if not request.path.endswith("/"):
            return redirect(f"/{(page or translated[1])['slug']}/", code=301)
        if translated:
            html = SITE.render_translated(render_index(), translated[0], translated[1], PUBLIC_URL)
        else:
            html = SITE.add_hreflang(SITE.render(render_index(), page, PUBLIC_URL), page["slug"], PUBLIC_URL)
        return app.response_class(finish(html, page["slug"] if page else ""), mimetype="text/html")

    @app.get("/sw.js")
    def service_worker():
        """The offline copy: every file the page needs, versioned by the content of all of them."""
        import hashlib
        import json as _json
        html = render_index()
        assets = ["/", "/manifest.webmanifest", "/favicon.ico"]
        assets += re.findall(r'"(/static/[\w./-]+\.(?:css|js|svg)(?:\?v=\w+)?)"', html)
        assets += [f"/static/fonts/{p.name}" for p in sorted((STATIC / "fonts").glob("*.woff2"))]
        assets += [f"/static/{n}" for n in ("icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png")]
        assets = list(dict.fromkeys(a for a in assets if a != "/static/og.png"))
        digest = hashlib.sha256(html.encode())
        for a in assets:
            if a.startswith("/static/"):
                p = STATIC / a.split("?")[0].removeprefix("/static/")
                if p.is_file():
                    digest.update(p.read_bytes())
        body = (STATIC / "_sw.js").read_text(encoding="utf-8")
        body = body.replace("__VERSION__", digest.hexdigest()[:12]).replace("__ASSETS__", _json.dumps(assets))
        return app.response_class(body, mimetype="text/javascript")

    @app.get("/robots.txt")
    def robots():
        if not PUBLIC_URL:
            return app.response_class("User-agent: *\nDisallow: /\n", mimetype="text/plain")
        return app.response_class(f"User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: {PUBLIC_URL}/sitemap.xml\n",
                                  mimetype="text/plain")

    @app.get("/sitemap.xml")
    def sitemap():
        """Every page, with lastmod, and its versions in other languages (Google's sitemap hreflang format)."""
        if not PUBLIC_URL:
            abort(404)
        from . import i18n
        u = PUBLIC_URL
        keys = [("", f"{u}/")] + [(p["slug"], f"{u}/{p['slug']}/") for p in BY_SLUG.values()]
        keys += [(p["key"], f"{u}/{slug}/") for slug, (_, p) in i18n.TRANSLATED.items()]
        out = []
        for key, loc in keys:
            alts = i18n.alternates(key)
            links = ""
            if len(alts) > 1:
                links = "".join(f'<xhtml:link rel="alternate" hreflang="{lang}" href="{u}{path}"/>' for lang, path in alts.items())
                links += f'<xhtml:link rel="alternate" hreflang="x-default" href="{u}{alts["en"]}"/>'
            out.append(f"<url><loc>{loc}</loc><lastmod>{UPDATED}</lastmod>{links}</url>")
        xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
               'xmlns:xhtml="http://www.w3.org/1999/xhtml">' + "".join(out) + "</urlset>\n")
        return app.response_class(xml, mimetype="application/xml")

    @app.get("/llms.txt")
    def llms():
        return app.response_class(LLMS_TXT + "\n" + SITE.llms_sections(PUBLIC_URL), mimetype="text/markdown")

    @app.get("/.well-known/security.txt")
    def security_txt():
        """RFC 9116: how to report a security problem. Expires half a year after each build."""
        from datetime import datetime, timedelta, timezone
        expires = (datetime.now(timezone.utc) + timedelta(days=182)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        lines = [f"Contact: {SITE.REPO}/security/advisories/new", f"Expires: {expires}", "Preferred-Languages: en",
                 f"Policy: {SITE.REPO}/security/policy"]
        if PUBLIC_URL:
            lines.append(f"Canonical: {PUBLIC_URL}/.well-known/security.txt")
        return app.response_class("\n".join(lines) + "\n", mimetype="text/plain")

    @app.get("/llms-full.txt")
    def llms_full():
        return app.response_class(LLMS_TXT + "\n" + SITE.llms_full(PUBLIC_URL), mimetype="text/markdown")

    @app.get("/manifest.webmanifest")
    def manifest():
        return send_file(STATIC / "manifest.webmanifest", mimetype="application/manifest+json")

    root_types = {"html": "text/html", "xml": "application/xml", "txt": "text/plain"}

    def root_file(name, ext):
        p = ROOT_FILES / f"{name}.{ext}"
        if not name.replace("-", "").replace("_", "").isalnum() or not p.is_file():
            abort(404)
        return send_file(p, mimetype=root_types[ext])

    for _ext in root_types:  # search-engine ownership files and the IndexNow key
        app.add_url_rule(f"/<name>.{_ext}", f"root_{_ext}", lambda name, _e=_ext: root_file(name, _e))

    @app.get("/favicon.ico")
    def favicon():
        return send_file(STATIC / "icon-192.png", mimetype="image/png")

    @app.get("/static/<path:name>")
    def static_file(name):
        p = (STATIC / name).resolve()
        if STATIC.resolve() not in p.parents or not p.is_file() or p.name.startswith(("_", ".")):
            abort(404)
        return send_file(p)

    @app.post("/api/inspect")
    def api_inspect():
        f = request.files.get("file")
        if not f:
            abort(400, "No photo was sent.")
        data = f.read(MAX_PHOTO_BYTES + 1)
        if len(data) > MAX_PHOTO_BYTES:
            abort(413, "This photo is larger than 200 MB.")
        if not data:
            abort(400, "This photo is empty.")
        name = (request.form.get("path") or f.filename or "photo")[:512]
        inv = inspect_bytes(data, Path(name).name)
        key = store.put({"name": name, "data": data, "inv": inv, "result": None})
        return jsonify({"id": key, "path": name, "report": inv.report()})

    @app.post("/api/clean/<key>")
    def api_clean(key):
        it = store.get(key)
        try:
            opts = CleanOptions.from_dict(request.get_json(silent=True) or {})
        except (TypeError, ValueError):
            abort(400, "Those cleaning options aren't valid.")
        try:
            res = clean_bytes(it["data"], Path(it["name"]).name, opts, inventory=it["inv"])
        except Exception:
            log.exception("clean failed")
            abort(422, "This photo couldn't be cleaned.")
        it["result"] = res
        store.touch_all()
        stem = Path(it["name"]).stem
        same = Path(it["name"]).suffix
        out_name = stem + (same if res.fmt == it["inv"].fmt and same else res.ext)
        return jsonify({"id": key, "out_name": out_name, **res.summary()})

    @app.post("/api/forget")
    def api_forget():
        body = request.get_json(silent=True, force=True) or {}
        ids = body.get("ids") if isinstance(body.get("ids"), list) else []
        return jsonify({"forgotten": store.forget(ids[:MAX_ITEMS])})

    @app.get("/api/download/<key>")
    def api_download(key):
        it = store.get(key)
        res = it["result"] or abort(409, "Clean this photo first.")
        name = _safe_zip_name(Path(it["name"]).name, "photo")
        return send_file(io.BytesIO(res.data), download_name=name, as_attachment=True,
                         mimetype="application/octet-stream")

    @app.post("/api/zip")
    def api_zip():
        body = request.get_json(silent=True) or {}
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
            used = set()
            for entry in (body.get("files") or [])[:MAX_ITEMS]:
                if not isinstance(entry, dict):
                    continue
                it = store.get(str(entry.get("id", "")))
                if not it["result"]:
                    continue
                name = _safe_zip_name(entry.get("name") or Path(it["name"]).name, "photo")
                stem, dot, ext = name.rpartition(".")
                candidate, n = name, 1
                while candidate.lower() in used:
                    candidate = f"{stem}_{n}.{ext}" if dot else f"{name}_{n}"
                    n += 1
                used.add(candidate.lower())
                zi = zipfile.ZipInfo(candidate, date_time=(1980, 1, 1, 0, 0, 0))  # no timestamps leaked
                z.writestr(zi, it["result"].data)
        buf.seek(0)
        return send_file(buf, download_name="clean-photos.zip", as_attachment=True, mimetype="application/zip")

    @app.get("/api/preview/<key>")
    def api_preview(key):
        it = store.get(key)
        which = request.args.get("which", "before")
        data = it["result"].data if which == "after" and it["result"] else it["data"]
        cache = it.setdefault("previews", {})
        if which not in cache:
            try:
                cache[which] = _preview(data)
            except Exception:
                abort(415)
        return send_file(io.BytesIO(cache[which]), mimetype="image/jpeg")

    @app.post("/api/report")
    def api_report():
        body = request.get_json(silent=True) or {}
        fmt = body.get("format", "json")
        if fmt not in ("json", "csv", "pdf"):
            abort(400, "Choose PDF, CSV or JSON.")
        which = body.get("which", "before")
        reps = []
        for key in (body.get("ids") or [])[:MAX_ITEMS]:
            it = store.get(str(key))
            inv = it["result"].after if which == "after" and it["result"] else it["inv"]
            r = inv.report()
            r["filename"] = Path(it["name"]).name + (" (cleaned)" if which == "after" and it["result"] else "")
            reps.append(r)
        data, mime = reports.export(reps, fmt)
        return send_file(io.BytesIO(data), mimetype=mime, as_attachment=True, download_name=f"unmeta-report.{fmt}")

    @app.get("/api/presets")
    def api_presets():
        return jsonify(PR.all_presets())

    @app.errorhandler(HTTPException)
    def _http_err(e):
        msg = e.description if e.code in (400, 404, 409, 413, 415, 422) else {403: "Not allowed."}.get(e.code, "Something went wrong.")
        if e.code == 413:
            msg = "This photo is larger than 200 MB."
        return jsonify({"error": msg}), e.code

    @app.errorhandler(Exception)
    def _err(e):
        log.exception("unhandled error")
        return jsonify({"error": "Something went wrong. Please try again."}), 500

    return app


def export(out_dir, public_url: str = "") -> list[str]:
    """Write a static copy of the site for any static host (Netlify, Cloudflare Pages, GitHub Pages, S3…).

    Every route is rendered exactly as the server would serve it, plus a `_headers` file (Netlify and Cloudflare
    Pages format) that carries the same security headers. The page also carries its policy in a meta tag, so it
    stays locked down even on hosts that ignore `_headers`.
    """
    import json as _json_mod
    import shutil
    global PUBLIC_URL
    out = Path(out_dir)
    old, PUBLIC_URL = PUBLIC_URL, public_url.rstrip("/")
    try:
        c = create_app().test_client()
        host = urlsplit(PUBLIC_URL).hostname if PUBLIC_URL else "localhost"
        if out.exists():
            shutil.rmtree(out)
        (out / "static").mkdir(parents=True)
        written = []
        routes = {"/": "index.html", "/sw.js": "sw.js", "/robots.txt": "robots.txt", "/llms.txt": "llms.txt", "/llms-full.txt": "llms-full.txt", "/.well-known/security.txt": ".well-known/security.txt",
                  "/manifest.webmanifest": "manifest.webmanifest", "/favicon.ico": "favicon.ico"}
        if PUBLIC_URL:
            routes["/sitemap.xml"] = "sitemap.xml"
        from . import i18n
        for slug in [*BY_SLUG, *i18n.TRANSLATED]:
            routes[f"/{slug}/"] = f"{slug}/index.html"
        for p in sorted(f for f in ROOT_FILES.iterdir() if f.suffix in (".html", ".xml", ".txt")):
            routes[f"/{p.name}"] = p.name
        for route, name in routes.items():
            r = c.get(route, headers={"Host": host})
            assert r.status_code == 200, (route, r.status_code)
            (out / name).parent.mkdir(parents=True, exist_ok=True)
            (out / name).write_bytes(r.data)
            written.append(name)
        for p in STATIC.rglob("*"):
            rel = p.relative_to(STATIC)
            if p.is_file() and not any(part.startswith(("_", ".")) for part in rel.parts) and rel.name != "index.html":
                (out / "static" / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, out / "static" / rel)
                written.append(f"static/{rel}")
        common = "\n".join(f"  {k}: {v}" for k, v in SECURITY_HEADERS.items())
        if PUBLIC_URL.startswith("https://"):
            common += f"\n  Strict-Transport-Security: {HSTS}"
        robots = "" if PUBLIC_URL else "\n  X-Robots-Tag: noindex, nofollow"
        (out / "_headers").write_text(
            "# Security headers for Netlify / Cloudflare Pages. Each path gets exactly one Content-Security-Policy:\n"
            "# the page and its worker may connect nowhere; the service worker may fetch this site's own files.\n"
            f"/*\n{common}{robots}\n\n"
            f"/\n  Content-Security-Policy: {PAGE_CSP}\n  Cache-Control: no-cache\n\n"
            f"/index.html\n  Content-Security-Policy: {PAGE_CSP}\n  Cache-Control: no-cache\n\n"
            + "".join(f"/{slug}/*\n  Content-Security-Policy: {PAGE_CSP}\n  Cache-Control: no-cache\n\n" for slug in [*BY_SLUG, *i18n.TRANSLATED]) +
            f"/static/engine.worker.js\n  Content-Security-Policy: {WORKER_CSP}\n\n"
            f"/sw.js\n  Content-Security-Policy: {SW_CSP}\n  Cache-Control: no-cache\n\n"
            "/static/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n")
        written.append("_headers")
        (out / "vercel.json").write_text(_json_mod.dumps(vercel_config(PUBLIC_URL), indent=2) + "\n")
        written.append("vercel.json")
        if os.environ.get("VERCEL"):
            # Built by Vercel from the repository: it reads the root vercel.json, so neither config file needs to be
            # in the site (they hold nothing secret, but there's no reason to serve them).
            for name in ("vercel.json", "_headers"):
                (out / name).unlink()
                written.remove(name)
        return written
    finally:
        PUBLIC_URL = old


# Vercel builds the site from the repository: it installs the package, runs the static export, and serves it
# with these headers. scripts/write_vercel_json.py writes the root vercel.json from this; a test keeps them in sync.
VERCEL_URL = "https://unmeta.vercel.app"


def vercel_config(public_url: str, build: bool = False) -> dict:
    """Vercel's settings. Vercel ignores _headers, and its rules all apply at once, so each Content-Security-Policy
    source matches a disjoint set of paths: one for the worker, one for the service worker, one for everything else."""
    base = [{"key": k, "value": v} for k, v in SECURITY_HEADERS.items()]
    if public_url.startswith("https://"):
        base.append({"key": "Strict-Transport-Security", "value": HSTS})
    if not public_url:
        base.append({"key": "X-Robots-Tag", "value": "noindex, nofollow"})
    cfg = {"$schema": "https://openapi.vercel.sh/vercel.json"}
    if build:
        cfg |= {
            "framework": None,
            "installCommand": "python3 -m venv .venv-build && .venv-build/bin/pip install --quiet .",
            "buildCommand": f".venv-build/bin/python -m metaclean export build/unmeta --public-url {public_url}",
            "outputDirectory": "build/unmeta",
            "git": {"deploymentEnabled": {"private-history": False}},
        }
    cfg |= {
        "trailingSlash": True,
        "headers": [
            {"source": "/(.*)", "headers": base},
            {"source": "/((?!static/engine\\.worker\\.js$|sw\\.js$).*)", "headers": [{"key": "Content-Security-Policy", "value": PAGE_CSP}]},
            {"source": "/((?!static/).*)", "headers": [{"key": "Cache-Control", "value": "no-cache"}]},
            {"source": "/static/engine.worker.js", "headers": [{"key": "Content-Security-Policy", "value": WORKER_CSP}]},
            {"source": "/sw.js", "headers": [{"key": "Content-Security-Policy", "value": SW_CSP}]},
            {"source": "/static/fonts/(.*)", "headers": [{"key": "Cache-Control", "value": "public, max-age=31536000, immutable"}]},
        ],
    }
    return cfg


def run(port=8765, open_browser=True):
    app = create_app()
    url = f"http://127.0.0.1:{port}/"
    print(f"UnMeta running at {url}  (local only, Ctrl+C to quit)")
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
