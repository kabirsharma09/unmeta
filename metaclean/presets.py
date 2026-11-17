"""Built-in and user presets. User presets live in ~/.metaclean/presets.json."""
from __future__ import annotations

import json
import os
from pathlib import Path

SERIALS = ["exif:exif:42033", "exif:exif:42037", "exif:exif:42032", "exif:0:316",
           "xmp:aux:SerialNumber", "xmp:exifEX:BodySerialNumber", "xmp:exifEX:LensSerialNumber",
           "xmp:aux:LensSerialNumber", "exif:exif:42016"]

COPYRIGHT_FIELDS = ["exif:0:315", "exif:0:33432", "xmp:dc:creator", "xmp:dc:rights",
                    "xmp:xmpRights:Marked", "xmp:xmpRights:UsageTerms", "xmp:xmpRights:WebStatement",
                    "iptc:2:80", "iptc:2:116"]

BUILTIN = {
    "full_wipe": {
        "name": "Full wipe",
        "description": "Remove everything, including the colour profile. Orientation is kept so photos don't turn sideways.",
        "options": {"keep_categories": [], "keep_icc": False, "orientation": "keep"},
    },
    "social_share": {
        "name": "Social media share",
        "description": "Remove location, device, personal and AI/provenance data. Keep colour profile and orientation so it looks right.",
        "options": {"keep_categories": ["technical"], "orientation": "keep"},
    },
    "copyright_only": {
        "name": "Keep copyright only",
        "description": "Remove everything except author and copyright notices (plus colour profile).",
        "options": {"keep_categories": ["technical"], "keep_fields": COPYRIGHT_FIELDS, "orientation": "keep"},
    },
    "keep_camera": {
        "name": "Keep camera settings",
        "description": "For photography forums: keep camera, lens and exposure; drop location, serial numbers, personal and AI data.",
        "options": {"keep_categories": ["technical", "device"], "drop_fields": SERIALS, "orientation": "keep"},
    },
    "ai_provenance_only": {
        "name": "Remove AI / provenance only",
        "description": "Strip C2PA, DigitalSourceType, generator prompts and software history; leave everything else.",
        "options": {"keep_categories": ["location", "device", "personal", "technical", "other"],
                    "orientation": "keep"},
    },
    "location_only": {
        "name": "Remove location only",
        "description": "Strip GPS and place names; keep everything else.",
        "options": {"keep_categories": ["device", "personal", "ai", "technical", "other"], "orientation": "keep"},
    },
}


def _path() -> Path:
    return Path(os.environ.get("METACLEAN_HOME", Path.home() / ".metaclean")) / "presets.json"


def load_user() -> dict:
    p = _path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            return {}
    return {}


def all_presets() -> dict:
    out = {k: {**v, "builtin": True} for k, v in BUILTIN.items()}
    for k, v in load_user().items():
        out[k] = {**v, "builtin": False}
    return out


def save_user(key: str, name: str, options: dict, description: str = "") -> dict:
    if key in BUILTIN:
        raise ValueError("Cannot overwrite a built-in preset")
    data = load_user()
    data[key] = {"name": name, "description": description, "options": options}
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2))
    return data[key]


def delete_user(key: str) -> None:
    data = load_user()
    data.pop(key, None)
    _path().write_text(json.dumps(data, indent=2))


def resolve(name_or_key: str) -> dict:
    presets = all_presets()
    if name_or_key in presets:
        return presets[name_or_key]["options"]
    for p in presets.values():
        if p["name"].lower() == name_or_key.lower():
            return p["options"]
    raise KeyError(f"Unknown preset '{name_or_key}'. Available: {', '.join(presets)}")
