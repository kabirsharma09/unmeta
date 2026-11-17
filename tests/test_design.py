"""Design-system guarantees: WCAG contrast for every text/icon pairing in both themes."""
import json
import re
from pathlib import Path

import pytest

T = json.loads((Path(__file__).parent.parent / "design/tokens.json").read_text())
THEMES = ["light", "dark"]


def color(name, theme):
    v = next(t["value"] for t in T["color"]["tokens"] if t["name"] == name)
    v = v if isinstance(v, str) else v.get(theme, v["light"])
    if v.startswith("#"):
        return tuple(int(v[i:i + 2], 16) for i in (1, 3, 5)) + (1.0,)
    r, g, b, a = (float(x) for x in re.findall(r"[\d.]+", v))
    return (r, g, b, a)


def over(fg, bg):
    a = fg[3]
    return tuple(fg[i] * a + bg[i] * (1 - a) for i in range(3)) + (1.0,)


def tint(c, surface, amount=0.13):
    return tuple(c[i] * amount + surface[i] * (1 - amount) for i in range(3)) + (1.0,)


def lum(c):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])


def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


TEXT = [  # (foreground, background) pairs used for text: 4.5:1
    ("ink", "paper"), ("ink", "paper-2"), ("ink-2", "paper"), ("ink-2", "paper-2"),
    ("on-ink", "ink"), ("on-highlight", "highlight"), ("on-alert", "alert"), ("alert", "paper"), ("film-edge", "film"),
]
NON_TEXT = [  # icons, focus rings, control borders, redaction bars: 3:1
    ("ink-3", "paper"), ("ink-3", "paper-2"), ("rule-strong", "paper"), ("focus", "paper"), ("redact", "paper"), ("pencil", "paper"),
]


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("fg,bg", TEXT)
def test_text_contrast(theme, fg, bg):
    assert ratio(color(fg, theme), color(bg, theme)) >= 4.5, (fg, bg, theme)


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("fg,bg", NON_TEXT)
def test_non_text_contrast(theme, fg, bg):
    assert ratio(color(fg, theme), color(bg, theme)) >= 3.0, (fg, bg, theme)


@pytest.mark.parametrize("theme", THEMES)
def test_text_on_hover_rows(theme):
    ground = over(color("hover", theme), color("paper", theme))
    assert ratio(color("ink-2", theme), ground) >= 4.5
