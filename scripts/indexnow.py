"""Tell IndexNow (Bing, Yandex, Seznam, Naver) about every page in the site's sitemap.

    .venv/bin/python scripts/indexnow.py build/unmeta https://unmeta.vercel.app   # sitemap from a built folder
    python3 scripts/indexnow.py https://unmeta.vercel.app                          # sitemap from the live site

Sends only public page addresses. The key file must already be live at <url>/<key>.txt.
"""
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit

if len(sys.argv) == 2:  # live site
    base = sys.argv[1].rstrip("/")
    with urllib.request.urlopen(f"{base}/sitemap.xml", timeout=30) as r:
        sitemap = ET.fromstring(r.read())
else:
    base = sys.argv[2].rstrip("/")
    sitemap = ET.parse(Path(sys.argv[1]) / "sitemap.xml").getroot()
key = next(p.stem for p in (Path(__file__).parent.parent / "metaclean/root").glob("*.txt") if len(p.stem) == 32)
ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
urls = [u.text for u in sitemap.findall("s:url/s:loc", ns)]
body = json.dumps({"host": urlsplit(base).hostname, "key": key, "keyLocation": f"{base}/{key}.txt", "urlList": urls}).encode()
req = urllib.request.Request("https://api.indexnow.org/indexnow", data=body, method="POST",
                             headers={"Content-Type": "application/json; charset=utf-8"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(f"IndexNow: {r.status}, {len(urls)} URLs submitted")
except urllib.error.HTTPError as e:
    print(f"IndexNow: {e.code} {e.read().decode(errors='replace')[:200]}")
