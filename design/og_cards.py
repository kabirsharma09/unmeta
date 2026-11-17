"""Draw a share card (1200x630) for every page: its own headline, the highlighter on its key word, and the readout.

    .venv/bin/python design/og_cards.py

Writes metaclean/static/og/<slug>.png (slashes become "--"). Hindi pages reuse their English card, because Pillow
here can't shape Devanagari without libraqm.
"""
import html
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from metaclean.pages import PAGES  # noqa: E402
from metaclean import i18n  # noqa: E402

FONTS = ROOT / "metaclean/static/fonts"
OUT = ROOT / "metaclean/static/og"
T = json.loads((ROOT / "design/tokens.json").read_text())
C = {t["name"]: (t["value"] if isinstance(t["value"], str) else t["value"]["light"]) for t in T["color"]["tokens"]}
W, H = 1200, 630
TAGLINE = {"en": "Free. In your browser. Nothing uploaded.", "es": "Gratis. En tu navegador. Sin subir nada.",
           "pt-BR": "Grátis. No seu navegador. Nada é enviado.", "de": "Kostenlos. Im Browser. Kein Upload.",
           "fr": "Gratuit. Dans votre navigateur. Rien n’est envoyé."}


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def card_name(slug: str) -> str:
    return slug.replace("/", "--") + ".png"


def mark_img(size):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = size / 32
    R = lambda x0, y0, x1, y1: [x0 * u, y0 * u, x1 * u - 1, y1 * u - 1]
    d.rectangle(R(0, 0, 32, 32), fill=C["ink"]); d.rectangle(R(3, 3, 29, 29), fill=C["paper"])
    d.rectangle(R(7, 9, 25, 13), fill=C["highlight"]); d.rectangle(R(7, 17, 25, 23), fill=C["ink"])
    return im


def draw(h1_html: str, tagline: str, out: Path):
    card = Image.new("RGB", (W, H), C["paper"])
    d = ImageDraw.Draw(card)
    m = mark_img(44); card.paste(m.convert("RGB"), (80, 64), m)
    d.text((138, 68), "unmeta", font=font("IBMPlexSans_600SemiBold.ttf", 32), fill=C["ink"])
    text = html.unescape(re.sub(r"<[^>]+>", "", h1_html)).replace("\u00a0", " ")
    words, maxw = text.split(), 600
    hot = set()  # indices of the words under the highlighter
    if "<mark" in h1_html:
        before = html.unescape(re.sub(r"<[^>]+>", "", h1_html.split("<mark", 1)[0])).replace("\u00a0", " ")
        inner = html.unescape(re.sub(r".*<mark[^>]*>(.*?)</mark>.*", r"\1", h1_html, flags=re.S)).split()
        start = len(before.split()) if before.strip() else 0
        hot = set(range(start, start + len(inner)))
        tail = inner[-1] if inner else ""
    for size in (78, 70, 62, 56, 50, 44):  # largest size that fits in four lines
        f = font("IBMPlexSansCondensed_700Bold.ttf", size)
        lines, cur = [], []
        for i, w in enumerate(words):
            if cur and d.textlength(" ".join(words[j] for j in cur + [i]), font=f) > maxw:
                lines.append(cur); cur = []
            cur.append(i)
        lines.append(cur)
        if len(lines) <= 4: break
    lh = int(size * 1.0)
    y = 150 + (4 - len(lines)) * lh // 3
    space = d.textlength(" ", font=f)
    for ln in lines:
        x = 80
        for k, i in enumerate(ln):
            w = words[i]
            if i in hot:
                hw = d.textlength(w if i != max(hot) else re.sub(r"[?.!,:;]+$", "", w), font=f)
                pad_r = space if (i + 1 in hot and k + 1 < len(ln)) else 4
                d.rectangle([x - 4, y + int(size * .38), x + hw + pad_r, y + int(size * 1.02)], fill=C["highlight"])
            x += d.textlength(w, font=f) + space
        d.text((80, y), " ".join(words[i] for i in ln), font=f, fill=C["ink"])
        y += lh
    d.text((80, 520), tagline, font=font("IBMPlexSans_400Regular.ttf", 28), fill=C["ink-2"])
    # the readout: what a photo gives away, then the redaction bar
    x0, y0, lab, val = 760, 150, font("IBMPlexMono_500Medium.ttf", 17), font("IBMPlexMono_400Regular.ttf", 22)
    d.rectangle([x0, y0, 1120, 470], outline=C["rule"], width=2)
    rows = [("FILE", "IMG_2041.HEIC", None), ("GPS", "51.5072, -0.1275", "hl"), ("DEVICE", "iPhone 15 Pro", "hl"),
            ("OWNER", "Jane Doe", "hl"), ("AI", "Made with AI", "redact")]
    for i, (k, v, mode) in enumerate(rows):
        yy = y0 + 28 + i * 58
        if i: d.line([x0 + 2, yy - 15, 1118, yy - 15], fill=C["rule"], width=1)
        d.text((x0 + 24, yy + 4), k, font=lab, fill=C["ink-2"])
        tw = d.textlength(v, font=val)
        if mode: d.rectangle([x0 + 128, yy - 3, x0 + 136 + tw, yy + 29], fill=C["highlight"] if mode == "hl" else C["ink"])
        if mode != "redact": d.text((x0 + 132, yy), v, font=val, fill=C["ink"])
    card.quantize(colors=64, method=Image.Quantize.MEDIANCUT).save(out, optimize=True)


def main():
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.png"): old.unlink()
    n = 0
    for p in PAGES:
        draw(p["h1"], TAGLINE["en"], OUT / card_name(p["slug"])); n += 1
    for lang, mod in i18n.LANGS.items():
        if lang not in TAGLINE: continue
        for p in mod.PAGES:
            draw(p["h1"], TAGLINE[lang], OUT / card_name(p["slug"])); n += 1
    print(f"{n} cards in {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
