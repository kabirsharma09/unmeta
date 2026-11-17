"""Tell IndexNow (Bing, Yandex, Seznam, Naver) about every page in the built site's sitemap.

    .venv/bin/python scripts/indexnow.py build/unmeta https://unmeta.vercel.app

Sends only public page addresses. The key file must already be live at <url>/<key>.txt.
"""
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit

site, base = Path(sys.argv[1]), sys.argv[2].rstrip("/")
key = next(p.stem for p in (Path(__file__).parent.parent / "metaclean/root").glob("*.txt") if len(p.stem) == 32)
ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
urls = [u.text for u in ET.parse(site / "sitemap.xml").getroot().findall("s:url/s:loc", ns)]
body = json.dumps({"host": urlsplit(base).hostname, "key": key, "keyLocation": f"{base}/{key}.txt", "urlList": urls}).encode()
req = urllib.request.Request("https://api.indexnow.org/indexnow", data=body, method="POST",
                             headers={"Content-Type": "application/json; charset=utf-8"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(f"IndexNow: {r.status}, {len(urls)} URLs submitted")
except urllib.error.HTTPError as e:
    print(f"IndexNow: {e.code} {e.read().decode(errors='replace')[:200]}")
