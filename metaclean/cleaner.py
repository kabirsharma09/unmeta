"""Remove metadata, optionally keeping or re-writing selected fields."""
from __future__ import annotations

import io
from dataclasses import dataclass, field

from PIL import Image, JpegImagePlugin

from . import containers as C
from . import inplace
from . import metadata as M
from .inspector import IFD_EXIF, IFD_GPS, IFD_INTEROP, Field, Inventory, inspect_bytes

LOSSLESS_FORMATS = {"jpeg", "png", "webp"}
IN_PLACE_FORMATS = {"heif", "avif", "tiff", "raw"}
EXT = {"jpeg": ".jpg", "png": ".png", "webp": ".webp", "heif": ".heic", "avif": ".avif", "tiff": ".tif"}

# Edits: friendly key -> (exif target, xmp target, iptc target)
EDIT_MAP = {
    "artist": (("0", 315), ("dc:creator", M.DC, "seq"), (2, 80)),
    "copyright": (("0", 33432), ("dc:rights", M.DC, "alt"), (2, 116)),
    "description": (("0", 270), ("dc:description", M.DC, "alt"), (2, 120)),
    "title": (None, ("dc:title", M.DC, "alt"), (2, 5)),
    "keywords": (None, ("dc:subject", M.DC, "bag"), (2, 25)),
    "datetime_original": (("exif", 36867), ("xmp:CreateDate", M.XMP_NS, "simple"), None),
    "software": (("0", 305), ("xmp:CreatorTool", M.XMP_NS, "simple"), None),
}

TRANSPOSE = {2: [Image.Transpose.FLIP_LEFT_RIGHT], 3: [Image.Transpose.ROTATE_180],
             4: [Image.Transpose.FLIP_TOP_BOTTOM], 5: [Image.Transpose.TRANSPOSE],
             6: [Image.Transpose.ROTATE_270], 7: [Image.Transpose.TRANSVERSE],
             8: [Image.Transpose.ROTATE_90]}


@dataclass
class CleanOptions:
    keep_categories: set[str] = field(default_factory=set)
    keep_fields: set[str] = field(default_factory=set)
    drop_fields: set[str] = field(default_factory=set)
    orientation: str = "keep"          # keep (tag only, lossless) | bake (rotate pixels) | drop
    keep_icc: bool | None = None       # None = follow the "technical" category
    quality: int | None = None         # None = keep JPEG tables / sensible defaults
    edits: dict[str, str] = field(default_factory=dict)
    output_format: str = "same"        # same | jpeg | png | webp

    @classmethod
    def from_dict(cls, d: dict | None) -> "CleanOptions":
        d = d or {}
        return cls(keep_categories=set(d.get("keep_categories") or []),
                   keep_fields=set(d.get("keep_fields") or []),
                   drop_fields=set(d.get("drop_fields") or []),
                   orientation=d.get("orientation") or "keep",
                   keep_icc=d.get("keep_icc"),
                   quality=int(d["quality"]) if d.get("quality") not in (None, "") else None,
                   edits={k: str(v) for k, v in (d.get("edits") or {}).items() if str(v).strip()},
                   output_format=d.get("output_format") or "same")

    def wants(self, f: Field) -> bool:
        if not f.keepable or f.id in self.drop_fields:
            return False
        if f.id == "exif:0:274":
            return False  # orientation handled separately
        if f.id == "icc:profile" and self.keep_icc is not None:
            return self.keep_icc
        return f.id in self.keep_fields or f.category in self.keep_categories


@dataclass
class Payloads:
    exif: Image.Exif | None = None
    xmp: bytes | None = None
    iim: bytes | None = None
    icc: bytes | None = None
    native: dict = field(default_factory=dict)   # format-specific raw passthrough
    intended: set[str] = field(default_factory=set)


@dataclass
class CleanResult:
    data: bytes
    ext: str
    fmt: str
    lossless: bool
    before: Inventory
    after: Inventory
    diff: list[dict]
    verified: bool
    residual: list[dict]
    warnings: list[str]

    def summary(self) -> dict:
        return {"format": self.fmt, "ext": self.ext, "lossless": self.lossless,
                "size_before": self.before.size_bytes, "size_after": len(self.data),
                "removed": sum(1 for d in self.diff if d["status"] == "removed"),
                "kept": sum(1 for d in self.diff if d["status"] == "kept"),
                "changed": sum(1 for d in self.diff if d["status"] in ("changed", "added")),
                "verified": self.verified, "residual": self.residual, "warnings": self.warnings,
                "before": self.before.report(), "after": self.after.report(), "diff": self.diff}


# ---------------------------------------------------------------------------
# Building payloads
# ---------------------------------------------------------------------------

def _build_payloads(inv: Inventory, opts: CleanOptions, write_orientation: int | None) -> Payloads:
    P = Payloads()
    kept = [f for f in inv.fields if opts.wants(f)]
    P.intended = {f.id for f in kept}

    # --- EXIF ---
    new = Image.Exif()
    used = False
    src = inv.exif
    for f in kept:
        if not f.id.startswith("exif:") or src is None:
            continue
        _, ifd, tag = f.id.split(":")
        tag = int(tag)
        try:
            if ifd == "0":
                new[tag] = src[tag]
            elif ifd == "exif":
                new.get_ifd(IFD_EXIF)[tag] = src.get_ifd(IFD_EXIF)[tag]
            elif ifd == "gps":
                new.get_ifd(IFD_GPS)[tag] = src.get_ifd(IFD_GPS)[tag]
            elif ifd == "interop":
                continue  # meaningless without the camera's EXIF IFD context
            used = True
        except KeyError:
            pass
    if write_orientation and write_orientation != 1:
        new[274] = write_orientation
        P.intended.add("exif:0:274")
        used = True
    for key, value in opts.edits.items():
        target = EDIT_MAP.get(key, (None,))[0]
        if key.startswith("exif:"):
            from PIL import ExifTags
            rev = {v: k for k, v in ExifTags.TAGS.items()}
            tag = rev.get(key[5:])
            if tag is None:
                continue
            target = ("0", tag) if tag < 0x8000 or tag in (33432,) else ("exif", tag)
        if not target:
            continue
        ifd, tag = target
        # EXIF "ASCII" fields: Pillow would replace non-ASCII with '?'. Store UTF-8 bytes instead,
        # which ExifTool, macOS, Windows and Android all read correctly.
        stored = value if value.isascii() else value.encode("utf-8")
        if ifd == "0":
            new[tag] = stored
        else:
            new.get_ifd(IFD_EXIF)[tag] = stored
        if key == "datetime_original":
            new[306] = value
            P.intended.add("exif:0:306")
        P.intended.add(f"exif:{ifd}:{tag}")
        used = True
    P.exif = new if used else None

    # --- XMP ---
    props = {p.qname: p for p in inv.xmp if f"xmp:{p.qname}" in P.intended}
    for key, value in opts.edits.items():
        if key not in EDIT_MAP or not EDIT_MAP[key][1]:
            continue
        qname, ns, kind = EDIT_MAP[key][1]
        items = [v.strip() for v in value.split(",")] if kind == "bag" else [value]
        if key == "datetime_original":
            value = value.replace(":", "-", 2).replace(" ", "T")
            items = [value]
        props[qname] = M.XmpProp(qname, ns, value, kind, items)
        P.intended.add(f"xmp:{qname}")
    if props:
        P.xmp = M.build_xmp(list(props.values()))

    # --- IPTC ---
    ds = [(r, d, v) for r, d, v in inv.iptc if f"iptc:{r}:{d}" in P.intended]
    for key, value in opts.edits.items():
        tgt = EDIT_MAP.get(key, (None, None, None))[2]
        if not tgt:
            continue
        ds = [x for x in ds if (x[0], x[1]) != tgt]
        vals = [v.strip() for v in value.split(",")] if key == "keywords" else [value]
        ds += [(tgt[0], tgt[1], v.encode("utf-8")) for v in vals]
        P.intended.add(f"iptc:{tgt[0]}:{tgt[1]}")
    if ds:
        P.iim = M.build_iim(ds)
        P.intended.add("iptc:1:90")

    # --- ICC ---
    if inv.icc and any(f.id == "icc:profile" for f in kept):
        P.icc = inv.icc

    # --- format-native passthroughs (C2PA, PNG text) ---
    if "c2pa:manifest" in P.intended:
        P.native["c2pa"] = True
    P.native["png_text"] = {f.id for f in kept if f.id.startswith("png:")}
    return P


# ---------------------------------------------------------------------------
# Container writers
# ---------------------------------------------------------------------------

def _exif_payload(ex: Image.Exif) -> bytes:
    b = ex.tobytes()
    return b if b.startswith(b"Exif\x00\x00") else b"Exif\x00\x00" + b


def _write_jpeg(data: bytes, P: Payloads, src: Inventory, warnings: list[str]) -> bytes:
    jf = C.parse_jpeg(data)
    jfif = [s for s in jf.header if s.kind == "jfif"]
    adobe = [s for s in jf.header if s.kind == "adobe"]
    structural = [s for s in jf.header if s.kind == "structural"]
    head: list[C.JpegSegment] = list(jfif[:1])
    if P.exif is not None:
        payload = _exif_payload(P.exif)
        if len(payload) < 65530:
            head.append(C.JpegSegment(0xE1, payload))
        else:
            warnings.append("Kept EXIF too large for one JPEG segment; dropped.")
    if P.xmp:
        if len(P.xmp) < 65000:
            head.append(C.JpegSegment(0xE1, b"http://ns.adobe.com/xap/1.0/\0" + P.xmp))
        else:
            warnings.append("Kept XMP too large; dropped.")
    if P.icc:
        head += C.jpeg_icc_segments(P.icc)
    if P.native.get("c2pa") and src.fmt == "jpeg":
        head += [s for s in src.raw["jpeg"].header if s.kind == "jumbf"]
        warnings.append("C2PA manifest kept, but its signature will no longer validate.")
    if P.iim:
        head.append(C.JpegSegment(0xED, b"Photoshop 3.0\0" + M.build_irb([(0x0404, b"", P.iim)])))
    head += adobe + structural
    return C.write_jpeg(head, jf.scan)


def _write_png(data: bytes, P: Payloads, src: Inventory, warnings: list[str]) -> bytes:
    chunks = C.parse_png(data)
    ihdr = chunks[0]
    render = [c for c in chunks[1:] if c.type in C.PNG_RENDER_CHUNKS and c.type != b"IEND"]
    out = [ihdr]
    if P.icc:
        out.append(C.png_iccp(P.icc))
        render = [c for c in render if c.type != b"sRGB"]
    if P.exif is not None:
        out.append(C.PngChunk(b"eXIf", _exif_payload(P.exif)[6:]))
    if P.xmp:
        out.append(C.png_itxt("XML:com.adobe.xmp", P.xmp.decode("utf-8")))
    if src.fmt == "png":
        for c in src.raw["png"]:
            if c.type in (b"tEXt", b"zTXt", b"iTXt"):
                key, _ = C.decode_png_text(c)
                if f"png:text:{key}" in P.native.get("png_text", ()):
                    out.append(c)
            elif c.type == b"tIME" and "png:tIME" in P.native.get("png_text", ()):
                out.append(c)
            elif c.type == b"caBX" and P.native.get("c2pa"):
                out.append(c)
                warnings.append("C2PA manifest kept, but its signature will no longer validate.")
    first_idat = next((i for i, c in enumerate(render) if c.type in (b"IDAT", b"acTL")), None)
    if first_idat is None:
        raise ValueError("This PNG has no image data; it may be damaged.")
    out = out[:1] + render[:first_idat] + out[1:] + render[first_idat:]
    out.append(C.PngChunk(b"IEND", b""))
    return C.write_png(out)


def _write_webp(data: bytes, P: Payloads, src: Inventory, warnings: list[str]) -> bytes:
    chunks = C.parse_webp(data)
    out = [c for c in chunks if c.fourcc in C.WEBP_IMAGE_CHUNKS]
    if P.icc:
        out.append(C.RiffChunk(b"ICCP", P.icc))
    if P.exif is not None:
        out.append(C.RiffChunk(b"EXIF", _exif_payload(P.exif)[6:]))
    if P.xmp:
        out.append(C.RiffChunk(b"XMP ", P.xmp))
    if P.native.get("c2pa") and src.fmt == "webp":
        out += [c for c in src.raw["webp"] if c.fourcc == b"C2PA"]
    im = Image.open(io.BytesIO(data))
    return C.write_webp(out, im.width, im.height, "A" in im.getbands())


# ---------------------------------------------------------------------------
# Pixel helpers
# ---------------------------------------------------------------------------

def _decode(data: bytes, fmt: str) -> Image.Image:
    if fmt == "raw":
        return _decode_raw(data)
    im = Image.open(io.BytesIO(data))
    im.load()
    return im


def _decode_raw(data: bytes) -> Image.Image:
    try:
        import rawpy  # optional full RAW development
        with rawpy.imread(io.BytesIO(data)) as raw:
            rgb = raw.postprocess(use_camera_wb=True, output_bps=8)
        return Image.fromarray(rgb)
    except Exception:
        pass
    best, area, pos = None, 0, 0
    while True:  # fall back to the largest embedded JPEG preview
        i = data.find(b"\xff\xd8\xff", pos)
        if i < 0:
            break
        pos = i + 3
        try:
            im = Image.open(io.BytesIO(data[i:]))
            if im.format == "JPEG" and im.width * im.height > area:
                im.load()
                best, area = im, im.width * im.height
        except Exception:
            continue
    if best is None:
        raise ValueError("Could not decode RAW file (install 'rawpy' for full RAW support)")
    return best


def _apply_orientation(im: Image.Image, orientation: int) -> Image.Image:
    for t in TRANSPOSE.get(orientation, []):
        im = im.transpose(t)
    return im


def _bare(im: Image.Image) -> Image.Image:
    """Copy pixels only, so encoders cannot re-emit metadata from im.info / TIFF tags."""
    out = im.copy()
    out.info = {}
    return out


def _encode(im: Image.Image, fmt: str, quality: int | None, src_im: Image.Image | None = None,
            lossless_hint: bool = False) -> bytes:
    im = _bare(im)
    buf = io.BytesIO()
    if fmt == "jpeg":
        if im.mode not in ("RGB", "L", "CMYK"):
            im = im.convert("RGB")
        kw = {"optimize": True}
        if quality is None and src_im is not None and getattr(src_im, "quantization", None):
            kw.update(qtables=src_im.quantization, subsampling=JpegImagePlugin.get_sampling(src_im))
        else:
            kw["quality"] = quality or 92
        im.save(buf, "JPEG", **kw)
    elif fmt == "png":
        im.save(buf, "PNG", optimize=True)
    elif fmt == "webp":
        if lossless_hint and quality is None:
            im.save(buf, "WEBP", lossless=True, exact=True)
        else:
            im.save(buf, "WEBP", quality=quality or 90, method=6)
    else:
        raise ValueError(fmt)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def same_picture(fmt: str, a: bytes, b: bytes) -> bool:
    """Proof that the picture itself is unchanged: compare the compressed image data byte for byte."""
    if fmt == "jpeg":
        return C.parse_jpeg(a).scan == C.parse_jpeg(b).scan
    if fmt == "png":
        idat = lambda d: b"".join(c.data for c in C.parse_png(d) if c.type in (b"IDAT", b"fdAT"))
        return idat(a) == idat(b)
    if fmt == "webp":
        img = lambda d: b"".join(c.data for c in C.parse_webp(d) if c.fourcc in (b"VP8 ", b"VP8L", b"ALPH", b"ANMF"))
        return img(a) == img(b)
    if fmt in ("heif", "avif"):
        return len(a) == len(b) and inplace.heif_picture_bytes(a) == inplace.heif_picture_bytes(b)
    if fmt in ("tiff", "raw"):
        return len(a) == len(b) and inplace.tiff_picture_bytes(a) == inplace.tiff_picture_bytes(b)
    return False


def diff_inventories(before: Inventory, after: Inventory) -> list[dict]:
    a = after.by_id()
    rows = []
    for f in before.fields:
        g = a.get(f.id)
        if g is None:
            status = "removed"
        elif g.value == f.value:
            status = "kept"
        else:
            status = "changed"
        rows.append({"id": f.id, "label": f.label, "category": f.category, "risk": f.risk,
                     "before": f.value, "after": g.value if g else None, "status": status})
    b_ids = {f.id for f in before.fields}
    for g in after.fields:
        if g.id not in b_ids:
            rows.append({"id": g.id, "label": g.label, "category": g.category, "risk": g.risk,
                         "before": None, "after": g.value, "status": "added"})
    return rows


def clean_bytes(data: bytes, filename: str = "image", options: CleanOptions | dict | None = None,
                inventory: Inventory | None = None) -> CleanResult:
    opts = options if isinstance(options, CleanOptions) else CleanOptions.from_dict(options)
    inv = inventory or inspect_bytes(data, filename)
    fmt = inv.fmt
    warnings: list[str] = []
    if fmt == "unknown":
        raise ValueError("Unsupported file type")

    target = fmt if opts.output_format in ("same", "", None) else opts.output_format

    orient = inv.orientation if inv.orientation in TRANSPOSE else 1
    lossless = False
    in_place = fmt in IN_PLACE_FORMATS and target == fmt and opts.orientation != "bake"

    if in_place:
        # ---- lossless in-place blanking (HEIC/AVIF/TIFF/RAW) ------------------
        write_orient = orient if opts.orientation == "keep" else None
        P = _build_payloads(inv, opts, write_orient)
        exif_tiff = _exif_payload(P.exif)[6:] if P.exif is not None else None
        if fmt in ("heif", "avif"):
            out = inplace.clean_heif(data, exif_tiff, P.xmp, bool(P.native.get("c2pa")), warnings)
        else:
            protected = {f.id for f in inv.fields if not f.keepable} | {"exif:0:274"}
            out = inplace.clean_tiff(data, {f.id for f in inv.fields}, P.intended, protected, P.xmp,
                                     bool(P.native.get("c2pa")))
            if opts.edits:
                warnings.append("New details can't be added to TIFF or RAW photos without changing them; skipped.")
        lossless = True
    elif target == fmt and fmt in LOSSLESS_FORMATS and not (opts.orientation == "bake" and orient != 1):
        # ---- lossless container rewrite ---------------------------------------
        write_orient = orient if opts.orientation == "keep" else None
        P = _build_payloads(inv, opts, write_orient)
        writer = {"jpeg": _write_jpeg, "png": _write_png, "webp": _write_webp}[fmt]
        out = writer(data, P, inv, warnings)
        lossless = True
    else:
        # ---- pixel path: decode, (re)orient, encode, then inject kept metadata --
        src_im = _decode(data, fmt)
        im = src_im
        pixels_oriented = fmt == "heif"  # pillow-heif already applied irot/imir
        if fmt == "raw":
            pixels_oriented = True
        if not pixels_oriented and orient != 1 and (opts.orientation == "bake" or target != fmt):
            im = _apply_orientation(im, orient)
            pixels_oriented = True
        write_orient = orient if (opts.orientation == "keep" and not pixels_oriented) else None
        if opts.orientation == "drop" and orient != 1 and not pixels_oriented:
            warnings.append("Orientation removed without rotating pixels; the photo may display sideways.")
        P = _build_payloads(inv, opts, write_orient)

        if fmt == "raw" and target == "raw":
            target = "jpeg"
        if target in LOSSLESS_FORMATS:
            lossless_hint = fmt == "png" or (fmt == "webp" and any(
                c.fourcc == b"VP8L" for c in inv.raw.get("webp", [])))
            if target == "png" and fmt == "jpeg":
                lossless_hint = True
            plain = _encode(im, target, opts.quality, src_im if fmt == "jpeg" and target == "jpeg" else None,
                            lossless_hint)
            tmp = Inventory(filename, target, len(plain))
            writer = {"jpeg": _write_jpeg, "png": _write_png, "webp": _write_webp}[target]
            # native passthroughs only make sense for the same container
            src_for_native = inv if target == fmt else tmp
            out = writer(plain, P, src_for_native, warnings)
            lossless = target == "png" or (target == "webp" and lossless_hint and opts.quality is None)
            if fmt == "jpeg" and target == "jpeg":
                warnings.append("Rotation was baked into the pixels; JPEG was re-encoded using the "
                                "original quantisation tables to minimise loss.")
        else:
            out = _encode_rich(im, target, opts, P, inv, warnings)
            lossless = target == "tiff"
        if P.native.get("c2pa") and target not in LOSSLESS_FORMATS:
            warnings.append("C2PA manifests cannot be carried through a re-encode; removed.")

    after = inspect_bytes(out, filename)
    diff = diff_inventories(inv, after)
    residual = [
        {"id": f.id, "label": f.label, "value": f.value, "risk": f.risk, "category": f.category}
        for f in after.fields
        if f.id not in P.intended and f.risk in ("medium", "high")
    ]
    unintended_ai = [s for s in after.ai_signals
                     if not ({"c2pa:manifest", "xmp:Iptc4xmpExt:DigitalSourceType"} & P.intended
                             or "ai" in opts.keep_categories)]
    if unintended_ai and not residual:
        residual = [{"id": "ai", "label": s["signal"], "value": s["detail"], "risk": s["risk"],
                     "category": "ai"} for s in unintended_ai]
    ext = EXT.get(target) or ("." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ".bin")
    if lossless and not same_picture(fmt, data, out):
        lossless = False
    return CleanResult(out, ext, target, lossless, inv, after, diff,
                       verified=not residual, residual=residual, warnings=warnings)


def _encode_rich(im: Image.Image, fmt: str, opts: CleanOptions, P: Payloads, inv: Inventory,
                 warnings: list[str]) -> bytes:
    comp = im.info.get("compression", "tiff_lzw")
    frames = getattr(im, "n_frames", 1) if inv.fmt == "tiff" else 1
    pages = []
    if frames > 1:
        for i in range(frames):
            im.seek(i)
            pages.append(_bare(im))
    im = _bare(im)
    buf = io.BytesIO()
    kw: dict = {}
    if P.exif is not None:
        kw["exif"] = _exif_payload(P.exif)
    if P.icc:
        kw["icc_profile"] = P.icc
    if P.xmp:
        kw["xmp"] = P.xmp
    if fmt == "heif":
        import pillow_heif  # noqa: F401  (opener registered in inspector)
        if im.mode not in ("RGB", "RGBA", "L"):
            im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
        im.save(buf, "HEIF", quality=opts.quality or 90, **kw)
        if P.iim:
            warnings.append("IPTC is not supported in HEIF; author/copyright were written to EXIF and XMP.")
    elif fmt == "avif":
        if im.mode not in ("RGB", "RGBA", "L"):
            im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
        im.save(buf, "AVIF", quality=opts.quality or 90, **kw)
    elif fmt == "tiff":
        if comp in ("jpeg", "tiff_jpeg", "raw"):
            comp = "tiff_lzw"
        # Pillow ignores `exif` when `tiffinfo` is given, so put XMP into the same directory.
        # Round-trip through bytes so sub-IFD pointers (Exif, GPS) exist as keys Pillow will write.
        info = Image.Exif()
        if P.exif is not None:
            info.load(_exif_payload(P.exif))
            # restore original value objects (UTF-8 bytes would otherwise come back as latin-1 str)
            for tag, v in P.exif.items():
                if tag not in (IFD_EXIF, IFD_GPS, IFD_INTEROP):
                    info[tag] = v
            for sub in (IFD_EXIF, IFD_GPS):
                src_ifd, dst_ifd = P.exif.get_ifd(sub), info.get_ifd(sub)
                for tag, v in src_ifd.items():
                    dst_ifd[tag] = v
        if P.xmp:
            info[700] = P.xmp
        kw.pop("xmp", None)
        kw.pop("exif", None)
        if P.exif is not None and (P.exif.get_ifd(IFD_EXIF) or P.exif.get_ifd(IFD_GPS)) and comp != "raw":
            # libtiff (used for compressed TIFF) cannot write EXIF/GPS sub-directories.
            comp = None
            warnings.append("Saved the TIFF uncompressed so the kept EXIF/GPS sub-fields could be written.")
        save_kw = dict(compression=comp, **kw)
        if len(info) or P.exif is not None:
            save_kw["exif"] = info
        if pages:
            pages[0].save(buf, "TIFF", save_all=True, append_images=pages[1:], **save_kw)
        else:
            im.save(buf, "TIFF", **save_kw)
    else:
        raise ValueError(f"Cannot write {fmt}")
    return buf.getvalue()
