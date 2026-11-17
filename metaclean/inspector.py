"""Turn an image file into an inventory of every metadata field it carries."""
from __future__ import annotations

import io
import re
from dataclasses import asdict, dataclass, field

from PIL import ExifTags, Image

from . import containers as C
from . import metadata as M
from .taxonomy import (AI_PNG_KEYS, AI_SOURCE_TYPES, CATEGORIES, EXIF_NAMES, FRIENDLY, GPS_NAMES,
                       IPTC_NAMES, RISK_ORDER, classify_exif, classify_iptc, classify_xmp, is_ai_text)

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    HEIF_OK = True
except Exception:  # pragma: no cover
    HEIF_OK = False

Image.MAX_IMAGE_PIXELS = 400_000_000

IFD_EXIF, IFD_GPS, IFD_INTEROP = 0x8769, 0x8825, 0xA005
POINTER_TAGS = {IFD_EXIF, IFD_GPS, IFD_INTEROP, 0x014A, 0x0201, 0x0202, 700, 33723, 34377, 34675}
# TIFF structural tags describe the pixel layout of *this* file; never copied to another container
STRUCTURAL_TAGS = {254, 255, 256, 257, 258, 259, 262, 263, 266, 273, 277, 278, 279, 280, 281, 284, 317,
                   320, 322, 323, 324, 325, 338, 339, 340, 341, 530, 531, 532, 50706, 50707}
TIFF_META_TAGS = {700: "XMP", 33723: "IPTC", 34377: "Photoshop", 34675: "ICC", 0x8769: "ExifIFD",
                  0x8825: "GPSIFD", 0x927C: "MakerNote", 50341: "PrintIM", 0xC4A5: "PrintIM"}


@dataclass
class Field:
    id: str
    category: str
    source: str
    name: str
    label: str
    value: str
    risk: str = "low"
    keepable: bool = True
    note: str = ""


@dataclass
class Inventory:
    filename: str
    fmt: str
    size_bytes: int
    width: int = 0
    height: int = 0
    mode: str = ""
    orientation: int = 1
    fields: list[Field] = field(default_factory=list)
    ai_signals: list[dict] = field(default_factory=list)
    gps: tuple[float, float] | None = None
    errors: list[str] = field(default_factory=list)
    # raw handles used by the cleaner
    exif: Image.Exif | None = None
    xmp: list[M.XmpProp] = field(default_factory=list)
    iptc: list[tuple[int, int, bytes]] = field(default_factory=list)
    icc: bytes | None = None
    c2pa: list[bytes] = field(default_factory=list)
    raw: dict = field(default_factory=dict)

    def add(self, f: Field):
        self.fields.append(f)

    def by_id(self) -> dict[str, Field]:
        return {f.id: f for f in self.fields}

    # ----- report ------------------------------------------------------------
    def report(self) -> dict:
        groups = {}
        for key, title in CATEGORIES.items():
            fs = [f for f in self.fields if f.category == key]
            risk = max((f.risk for f in fs), key=lambda r: RISK_ORDER[r], default="none")
            groups[key] = {"title": title, "risk": risk, "count": len(fs),
                           "fields": [asdict(f) for f in fs]}
        overall = max((g["risk"] for g in groups.values() if g["count"]),
                      key=lambda r: RISK_ORDER[r], default="none")
        return {
            "filename": self.filename, "format": self.fmt, "size_bytes": self.size_bytes,
            "width": self.width, "height": self.height, "mode": self.mode,
            "orientation": self.orientation, "gps": self.gps, "overall_risk": overall,
            "field_count": len(self.fields), "groups": groups, "ai_signals": self.ai_signals,
            "errors": self.errors,
            "notes": ["Metadata cleaning does not remove invisible pixel watermarks (e.g. Google SynthID); "
                      "those are part of the image itself."],
        }


def _trim(s: str, n: int = 400) -> str:
    s = s.replace("\x00", "")
    return s if len(s) <= n else s[:n] + f"… (+{len(s) - n} chars)"


# ---------------------------------------------------------------------------
# Generic block readers
# ---------------------------------------------------------------------------

RAW_REQUIRED = {271, 272, 50708}  # RAW developers need these to decode colours; never blanked in RAW files


def _blank(v) -> bool:
    """A value that carries no information (e.g. blanked in place by the cleaner)."""
    if isinstance(v, (bytes, bytearray)):
        return not any(v)
    if isinstance(v, str):
        return not v.strip("\x00 ")
    if isinstance(v, tuple):
        return all(_blank(x) for x in v)
    try:
        f = float(v)
        return f == 0 or f != f
    except (TypeError, ValueError, ZeroDivisionError):
        return False


def _read_exif(inv: Inventory, exif: Image.Exif, source="EXIF"):
    inv.exif = exif
    for tag, val in list(exif.items()):
        if tag in POINTER_TAGS or _blank(val):
            continue
        name = EXIF_NAMES.get(tag, f"Tag0x{tag:04X}")
        text = M.exif_text(name, val)
        cat, risk = classify_exif(name, text)
        if tag == 274:
            inv.orientation = int(val) if isinstance(val, int) else 1
        structural = tag in STRUCTURAL_TAGS or tag >= 50700 or (inv.fmt == "raw" and tag in RAW_REQUIRED)
        inv.add(Field(f"exif:0:{tag}", "technical" if structural else cat, source, name,
                      FRIENDLY.get(name, name), _trim(text), "none" if structural else risk,
                      keepable=not structural))
    sub = exif.get_ifd(IFD_EXIF)
    for tag, val in sub.items():
        if tag == IFD_INTEROP or _blank(val):
            continue
        name = EXIF_NAMES.get(tag, f"Tag0x{tag:04X}")
        text = M.exif_text(name, val)
        cat, risk = classify_exif(name, text)
        keep = tag != 0x927C
        note = "Vendor-private block; may hide serial numbers or location. Always removed." if not keep else ""
        inv.add(Field(f"exif:exif:{tag}", cat, source, name, FRIENDLY.get(name, name), _trim(text), risk,
                      keepable=keep, note=note))
    gps = {k: v for k, v in exif.get_ifd(IFD_GPS).items() if not _blank(v)}
    if gps:
        inv.gps = M.gps_to_decimal(gps)
        for tag, val in gps.items():
            name = GPS_NAMES.get(tag, f"GPS0x{tag:04X}")
            risk = "low" if name == "GPSVersionID" else "high"
            inv.add(Field(f"exif:gps:{tag}", "location", source, name, FRIENDLY.get(name, name),
                          _trim(M.exif_text(name, val)), risk))
    interop = exif.get_ifd(IFD_INTEROP)
    for tag, val in interop.items():
        if _blank(val):
            continue
        name = {1: "InteroperabilityIndex", 2: "InteroperabilityVersion"}.get(tag, f"Interop0x{tag:04X}")
        inv.add(Field(f"exif:interop:{tag}", "technical", source, name, name,
                      _trim(M.exif_text(name, val)), "none"))
    try:
        ifd1 = exif.get_ifd(ExifTags.IFD.IFD1)
    except Exception:
        ifd1 = {}
    if ifd1:
        inv.add(Field("exif:thumbnail", "personal", source, "ThumbnailImage", "Embedded thumbnail",
                      f"IFD1 preview image ({len(ifd1)} tags)", "medium", keepable=False,
                      note="A thumbnail can show the original, un-cropped or un-edited picture."))


def _read_xmp(inv: Inventory, packet: bytes, source="XMP"):
    props = M.parse_xmp(packet)
    inv.xmp = props
    for p in props:
        cat, risk = classify_xmp(p.qname, p.value)
        label = p.qname.split(":", 1)[1]
        note = ""
        if p.qname == "Iptc4xmpExt:DigitalSourceType":
            key = p.value.rstrip("/").rsplit("/", 1)[-1]
            label = "Digital source type (IPTC)"
            note = AI_SOURCE_TYPES.get(key, ("Unknown source type", ""))[0]
        inv.add(Field(f"xmp:{p.qname}", cat, source, p.qname, label, _trim(p.value), risk,
                      keepable=p.kind != "struct", note=note))


def _read_iptc(inv: Inventory, iim: bytes, source="IPTC"):
    ds = M.parse_iim(iim)
    inv.iptc = ds
    for rec, d, val in ds:
        name = IPTC_NAMES.get((rec, d), f"IIM {rec}:{d}")
        text = M.iim_text(val)
        cat, risk = classify_iptc(rec, d, text)
        inv.add(Field(f"iptc:{rec}:{d}", cat, source, name, name, _trim(text), risk,
                      keepable=rec == 2 and d != 0))


def _read_c2pa(inv: Inventory, blob: bytes, source="C2PA"):
    inv.c2pa.append(blob)
    s = C.summarize_c2pa(blob)
    parts = []
    if "claim_generator" in s:
        parts.append(f"generator: {s['claim_generator']}")
    if s.get("generator_info"):
        parts.append("tools: " + ", ".join(s["generator_info"]))
    if s.get("digital_source_type"):
        parts.append("source: " + ", ".join(s["digital_source_type"]))
    if s.get("actions"):
        parts.append("actions: " + ", ".join(s["actions"]))
    parts.append(f"{s['bytes']:,} bytes, signed manifest")
    if not any(f.id == "c2pa:manifest" for f in inv.fields):
        inv.add(Field("c2pa:manifest", "ai", source, "C2PA manifest", "Content Credentials (C2PA)",
                      "; ".join(parts), "high",
                      note="Signed provenance record read by LinkedIn, TikTok, Google and Adobe. "
                           "Any edit to the file invalidates its signature."))
    inv.raw.setdefault("c2pa_summary", []).append(s)


def _read_icc(inv: Inventory, icc: bytes, source="ICC"):
    inv.icc = icc
    desc = ""
    try:
        from PIL import ImageCms
        prof = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        desc = ImageCms.getProfileDescription(prof).strip()
    except Exception:
        pass
    inv.add(Field("icc:profile", "technical", source, "ICCProfile", "Colour profile",
                  f"{desc or 'embedded profile'} ({len(icc):,} bytes)", "low",
                  note="Keeps colours accurate (e.g. Display P3). Removing it can shift colours."))


# ---------------------------------------------------------------------------
# Per-format readers
# ---------------------------------------------------------------------------

def _inspect_jpeg(inv: Inventory, data: bytes):
    jf = C.parse_jpeg(data)
    inv.raw["jpeg"] = jf
    seen_ext_xmp = False
    jumbf = b""
    for seg in jf.header:
        k = seg.kind
        if k == "exif":
            ex = Image.Exif()
            try:
                ex.load(seg.payload)
                _read_exif(inv, ex)
            except Exception as e:
                inv.errors.append(f"EXIF parse error: {e}")
                inv.add(Field("jpeg:exif_raw", "other", "EXIF", "EXIF", "Unreadable EXIF block",
                              f"{len(seg.payload):,} bytes", "medium", keepable=False))
        elif k == "xmp":
            _read_xmp(inv, seg.payload[29:])
        elif k == "xmp_ext" and not seen_ext_xmp:
            seen_ext_xmp = True
            inv.add(Field("jpeg:xmp_extended", "other", "XMP", "ExtendedXMP", "Extended XMP",
                          "Large XMP overflow (often depth maps, edit history or gain maps)", "medium",
                          keepable=False))
        elif k == "photoshop":
            blocks = M.parse_irb(seg.payload[14:])
            others = []
            for rid, _name, bdata in blocks:
                if rid == 0x0404:
                    _read_iptc(inv, bdata)
                elif rid not in (0x0425,):
                    others.append(M.IRB_NAMES.get(rid, f"0x{rid:04X}"))
            if others:
                thumb = any("Thumbnail" in o for o in others)
                inv.add(Field("jpeg:photoshop_irb", "other", "Photoshop", "PhotoshopIRB",
                              "Photoshop resources", ", ".join(others), "medium" if thumb else "low",
                              keepable=False))
        elif k == "jumbf":
            jumbf += seg.payload[8:]
        elif k == "comment":
            text = seg.payload.decode("utf-8", "replace")
            ai = is_ai_text(text)
            inv.add(Field("jpeg:comment", "ai" if ai else "other", "JPEG", "Comment", "JPEG comment",
                          _trim(text), "high" if ai else "low"))
        elif k == "mpf":
            inv.add(Field("jpeg:mpf", "other", "JPEG", "MPF", "Multi-picture data",
                          "Secondary images (depth map, HDR gain map or preview)", "medium", keepable=False))
        elif k == "jfxx":
            inv.add(Field("jpeg:jfxx", "personal", "JPEG", "JFXX", "JFIF thumbnail",
                          "Embedded thumbnail", "medium", keepable=False))
        elif k.startswith("app") and k not in ("app0",):
            ident = seg.payload[:24].split(b"\0")[0].decode("latin-1", "replace")
            inv.add(Field(f"jpeg:{k}:{ident}", "other", "JPEG", k.upper(), f"{k.upper()} segment",
                          f"{ident or 'unnamed'} ({len(seg.payload):,} bytes)", "low", keepable=False))
    icc = C.jpeg_icc_from_segments(jf.header)
    if icc:
        _read_icc(inv, icc)
    if jumbf:
        _read_c2pa(inv, jumbf)
    if jf.trailer.strip(b"\0"):
        t = jf.trailer
        what = "motion-photo video" if b"ftyp" in t[:64] or b"MotionPhoto" in data[:65536] else "extra data"
        inv.add(Field("jpeg:trailer", "other", "JPEG", "Trailer", "Data after end of image",
                      f"{len(t):,} bytes of {what}", "medium", keepable=False,
                      note="Appended images or video (e.g. phone motion photos) can leak an un-edited version."))


def _inspect_png(inv: Inventory, data: bytes):
    chunks = C.parse_png(data)
    inv.raw["png"] = chunks
    for c in chunks:
        t = c.type
        if t in C.PNG_RENDER_CHUNKS:
            continue
        if t == b"eXIf":
            ex = Image.Exif()
            try:
                ex.load(c.data)
                _read_exif(inv, ex)
            except Exception as e:
                inv.errors.append(f"EXIF parse error: {e}")
        elif t == b"iCCP":
            try:
                _read_icc(inv, C.png_icc_from_chunk(c))
            except Exception as e:
                inv.errors.append(f"ICC error: {e}")
        elif t in (b"tEXt", b"zTXt", b"iTXt"):
            key, text = C.decode_png_text(c)
            if key == "XML:com.adobe.xmp":
                _read_xmp(inv, text.encode("utf-8"))
                continue
            if key.lower() in ("raw profile type exif", "raw profile type app1"):
                inv.add(Field(f"png:text:{key}", "other", "PNG", key, "Legacy EXIF text block",
                              f"{len(text):,} chars", "medium"))
                continue
            k = key.lower()
            ai = k in AI_PNG_KEYS and (k != "comment" or is_ai_text(text)) or is_ai_text(text) \
                or (k == "software" and is_ai_text(text))
            if ai:
                cat, risk = "ai", "high"
            elif k in ("author", "copyright", "description", "title", "creation time", "comment",
                       "disclaimer", "source"):
                cat, risk = "personal", "medium"
            elif k == "software":
                cat, risk = "ai", "medium"
            else:
                cat, risk = "other", "low"
            label = {"parameters": "Generation parameters (Stable Diffusion)",
                     "prompt": "ComfyUI prompt graph", "workflow": "ComfyUI workflow"}.get(k, key)
            inv.add(Field(f"png:text:{key}", cat, "PNG", key, label, _trim(text), risk))
        elif t == b"tIME":
            y, mo, d, h, mi, s = (int.from_bytes(c.data[0:2], "big"), *c.data[2:7])
            inv.add(Field("png:tIME", "personal", "PNG", "tIME", "Last modified",
                          f"{y:04d}-{mo:02d}-{d:02d} {h:02d}:{mi:02d}:{s:02d}", "low"))
        elif t == b"caBX":
            _read_c2pa(inv, c.data)
        elif t[0:1].islower():  # ancillary, unknown
            inv.add(Field(f"png:chunk:{t.decode('latin-1')}", "other", "PNG", t.decode("latin-1"),
                          f"Private chunk {t.decode('latin-1')}", f"{len(c.data):,} bytes", "low",
                          keepable=False))


def _inspect_webp(inv: Inventory, data: bytes):
    chunks = C.parse_webp(data)
    inv.raw["webp"] = chunks
    for c in chunks:
        if c.fourcc in C.WEBP_IMAGE_CHUNKS:
            continue
        if c.fourcc == b"EXIF":
            ex = Image.Exif()
            try:
                ex.load(c.data)
                _read_exif(inv, ex)
            except Exception as e:
                inv.errors.append(f"EXIF parse error: {e}")
        elif c.fourcc == b"XMP ":
            _read_xmp(inv, c.data)
        elif c.fourcc == b"ICCP":
            _read_icc(inv, c.data)
        elif c.fourcc == b"C2PA":
            _read_c2pa(inv, c.data)
        else:
            name = c.fourcc.decode("latin-1").strip()
            inv.add(Field(f"webp:chunk:{name}", "other", "WebP", name, f"Chunk {name}",
                          f"{len(c.data):,} bytes", "low", keepable=False))


def _inspect_via_pillow(inv: Inventory, im: Image.Image, data: bytes):
    info = im.info
    exif_bytes = info.get("exif")
    if exif_bytes:
        ex = Image.Exif()
        try:
            ex.load(exif_bytes)
            _read_exif(inv, ex)
        except Exception as e:
            inv.errors.append(f"EXIF parse error: {e}")
    elif inv.fmt == "tiff":
        ex = im.getexif()
        _read_exif(inv, ex, "TIFF")
        tags = getattr(im, "tag_v2", {})
        for tag in tags:
            if tag in (700, 33723, 34377, 34675):
                continue
            if tag not in ex and tag not in POINTER_TAGS and tag >= 32768 and tag not in (33432, 34665, 34853):
                inv.add(Field(f"tiff:tag:{tag}", "other", "TIFF", f"Tag{tag}", f"Private tag {tag}",
                              _trim(str(tags[tag])[:120]), "low", keepable=False))
    xmp = info.get("xmp") or info.get("XML:com.adobe.xmp")
    if inv.fmt == "tiff":
        xmp = xmp or getattr(im, "tag_v2", {}).get(700)
    if xmp and (xmp if isinstance(xmp, bytes) else str(xmp).encode()).strip(b"\x00 "):
        _read_xmp(inv, xmp if isinstance(xmp, bytes) else str(xmp).encode())
    icc = info.get("icc_profile")
    if icc:
        _read_icc(inv, icc)
    if inv.fmt == "tiff":
        tags = getattr(im, "tag_v2", {})
        iptc = tags.get(33723)
        if iptc and not _blank(iptc if isinstance(iptc, bytes) else bytes(iptc) if isinstance(iptc, (tuple, list)) else b""):
            raw = iptc if isinstance(iptc, bytes) else bytes(iptc) if isinstance(iptc, (tuple, list)) else b""
            if raw:
                _read_iptc(inv, raw)
        if tags.get(34377):
            inv.add(Field("tiff:photoshop", "other", "TIFF", "Photoshop", "Photoshop resources",
                          "present", "low", keepable=False))
    if inv.fmt in ("heif", "avif"):
        if info.get("thumbnails"):
            inv.add(Field("heif:thumbnail", "personal", "HEIF", "Thumbnail", "Embedded thumbnail",
                          f"{len(info['thumbnails'])} thumbnail(s)", "medium", keepable=False))
        if info.get("depth_images"):
            inv.add(Field("heif:depth", "other", "HEIF", "DepthMap", "Depth map",
                          f"{len(info['depth_images'])} depth image(s) (portrait-mode data)", "medium",
                          keepable=False))
        if info.get("aux"):
            inv.add(Field("heif:aux", "other", "HEIF", "Auxiliary", "Auxiliary images",
                          "HDR gain map / segmentation mattes", "low", keepable=False))
        if info.get("original_orientation") and info["original_orientation"] != 1:
            inv.orientation = info["original_orientation"]
        blob = C.find_bmff_c2pa(data)
        if blob:
            _read_c2pa(inv, blob)


def _inspect_raw(inv: Inventory, data: bytes):
    """RAW files: read the TIFF-style EXIF directly from the container."""
    tiff = data
    if data[:4] in (b"IIRO", b"IIRS", b"IIU\x00"):
        tiff = b"II*\x00" + data[4:]
    ex = Image.Exif()
    try:
        if tiff[:4] in (b"II*\x00", b"MM\x00*"):
            ex.load(tiff)
        else:
            i = data.find(b"Exif\x00\x00")
            if i < 0:
                raise ValueError("no EXIF found")
            ex.load(data[i:])
        _read_exif(inv, ex, "RAW/EXIF")
    except Exception as e:
        inv.errors.append(f"RAW EXIF: {e}")
    m = re.search(rb"<x:xmpmeta.*?</x:xmpmeta>", data, re.S)
    if m:
        _read_xmp(inv, m.group(0))
    blob = C.find_bmff_c2pa(data)
    if blob:
        _read_c2pa(inv, blob)


# ---------------------------------------------------------------------------

def _ai_signals(inv: Inventory) -> list[dict]:
    sig = []
    for s in inv.raw.get("c2pa_summary", []):
        detail = s.get("claim_generator") or ", ".join(s.get("generator_info", [])) or "signed manifest"
        verdict = "Content Credentials present"
        for d in s.get("digital_source_type", []):
            if d in AI_SOURCE_TYPES:
                verdict = AI_SOURCE_TYPES[d][0]
        sig.append({"signal": "C2PA / Content Credentials", "verdict": verdict, "detail": detail,
                    "risk": "high", "read_by": "LinkedIn, TikTok, Google, Adobe, Meta"})
    for f in inv.fields:
        if f.id == "xmp:Iptc4xmpExt:DigitalSourceType":
            key = f.value.rstrip("/").rsplit("/", 1)[-1]
            v, r = AI_SOURCE_TYPES.get(key, ("Unknown source type", "medium"))
            sig.append({"signal": "IPTC DigitalSourceType", "verdict": v, "detail": key, "risk": r,
                        "read_by": "Meta (Facebook/Instagram/Threads), Google"})
        elif f.category == "ai" and f.risk == "high" and f.id != "c2pa:manifest":
            sig.append({"signal": f"{f.source} {f.name}", "verdict": "Mentions an AI tool or generation settings",
                        "detail": f.value[:120], "risk": "high", "read_by": "Platform heuristics, people"})
    return sig


def inspect_bytes(data: bytes, filename: str = "image") -> Inventory:
    fmt = C.detect_format(data, filename)
    inv = Inventory(filename=filename, fmt=fmt, size_bytes=len(data))
    im = None
    try:
        im = Image.open(io.BytesIO(data))
        inv.width, inv.height, inv.mode = im.width, im.height, im.mode
    except Exception as e:
        if fmt not in ("raw",):
            inv.errors.append(f"Could not decode image: {e}")
    try:
        if fmt == "jpeg":
            _inspect_jpeg(inv, data)
        elif fmt == "png":
            _inspect_png(inv, data)
        elif fmt == "webp":
            _inspect_webp(inv, data)
        elif fmt in ("heif", "avif", "tiff") and im is not None:
            _inspect_via_pillow(inv, im, data)
        elif fmt == "raw":
            _inspect_raw(inv, data)
        elif fmt == "unknown":
            inv.errors.append("Unsupported or unrecognised file type")
    except Exception as e:  # never crash the report
        inv.errors.append(f"Parse error: {type(e).__name__}: {e}")
    # catch-all: C2PA anywhere we did not structurally find it
    if not inv.c2pa and (b"c2pa" in data[:4_000_000] and b"jumb" in data[:4_000_000]):
        i = data.find(b"jumb")
        _read_c2pa(inv, data[max(0, i - 8): i + 200_000])
    inv.ai_signals = _ai_signals(inv)
    return inv
