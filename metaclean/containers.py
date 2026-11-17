"""Byte-level container parsers and writers.

These operate on the raw file structure so JPEG, PNG and WebP can be cleaned
without touching (re-encoding) the compressed image data.
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Format detection
# ---------------------------------------------------------------------------

RAW_EXTS = {".dng", ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".orf",
            ".rw2", ".pef", ".raf", ".srw", ".3fr", ".iiq", ".erf", ".mos", ".x3f"}


def detect_format(data: bytes, filename: str = "") -> str:
    """Return one of jpeg, png, webp, heif, avif, tiff, raw, unknown."""
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[4:8] == b"ftyp":
        brands = data[8:12] + data[16:min(len(data), 64)]
        if b"avif" in brands or b"avis" in brands:
            return "avif"
        if b"crx " in brands:  # Canon CR3
            return "raw"
        if any(b in brands for b in (b"heic", b"heix", b"mif1", b"msf1", b"heim", b"heis", b"hevc")):
            return "heif"
    if ext in RAW_EXTS:
        return "raw"
    if data[:4] in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"):
        return "tiff"
    if data[:4] in (b"IIRO", b"IIRS", b"IIU\x00") or data[:8] == b"FUJIFILM":
        return "raw"
    return "unknown"


# ---------------------------------------------------------------------------
# JPEG
# ---------------------------------------------------------------------------

@dataclass
class JpegSegment:
    marker: int          # second byte of the marker, e.g. 0xE1 for APP1
    payload: bytes       # bytes after the length field

    @property
    def kind(self) -> str:
        m, p = self.marker, self.payload
        if m == 0xE0:
            return "jfxx" if p.startswith(b"JFXX\0") else "jfif"
        if m == 0xE1:
            if p.startswith(b"Exif\0"):
                return "exif"
            if p.startswith(b"http://ns.adobe.com/xap/1.0/\0"):
                return "xmp"
            if p.startswith(b"http://ns.adobe.com/xmp/extension/\0"):
                return "xmp_ext"
            return "app1"
        if m == 0xE2:
            if p.startswith(b"ICC_PROFILE\0"):
                return "icc"
            if p.startswith(b"MPF\0"):
                return "mpf"
            return "app2"
        if m == 0xEB and p[:2] == b"JP":
            return "jumbf"
        if m == 0xED and p.startswith(b"Photoshop 3.0\0"):
            return "photoshop"
        if m == 0xEE and p.startswith(b"Adobe"):
            return "adobe"  # colour transform; needed for decoding CMYK/YCCK
        if m == 0xFE:
            return "comment"
        if 0xE0 <= m <= 0xEF:
            return f"app{m - 0xE0}"
        return "structural"

    def to_bytes(self) -> bytes:
        return b"\xff" + bytes([self.marker]) + struct.pack(">H", len(self.payload) + 2) + self.payload


@dataclass
class JpegFile:
    header: list[JpegSegment]   # all segments before the first SOS
    scan: bytes                  # SOS .. EOI inclusive (compressed image data)
    trailer: bytes               # anything after EOI (MPF images, motion-photo video, junk)


def parse_jpeg(data: bytes) -> JpegFile:
    if data[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    pos, segs = 2, []
    while pos < len(data):
        if data[pos] != 0xFF:
            raise ValueError(f"bad JPEG marker at {pos}")
        while data[pos + 1] == 0xFF:  # fill bytes
            pos += 1
        marker = data[pos + 1]
        if marker == 0xDA:  # SOS: rest is compressed data
            break
        if marker in (0x01,) or 0xD0 <= marker <= 0xD7:
            pos += 2
            continue
        (length,) = struct.unpack(">H", data[pos + 2:pos + 4])
        segs.append(JpegSegment(marker, data[pos + 4:pos + 2 + length]))
        pos += 2 + length
    eoi = data.find(b"\xff\xd9", pos)
    end = len(data) if eoi < 0 else eoi + 2
    return JpegFile(segs, data[pos:end], data[end:])


def write_jpeg(header: list[JpegSegment], scan: bytes) -> bytes:
    return b"\xff\xd8" + b"".join(s.to_bytes() for s in header) + scan


def jpeg_icc_segments(icc: bytes) -> list[JpegSegment]:
    max_chunk = 65519 - 14
    chunks = [icc[i:i + max_chunk] for i in range(0, len(icc), max_chunk)] or [b""]
    return [JpegSegment(0xE2, b"ICC_PROFILE\0" + bytes([i + 1, len(chunks)]) + c)
            for i, c in enumerate(chunks)]


def jpeg_icc_from_segments(segs: list[JpegSegment]) -> bytes | None:
    parts = sorted((s.payload[12], s.payload[14:]) for s in segs if s.kind == "icc")
    return b"".join(p for _, p in parts) if parts else None


# ---------------------------------------------------------------------------
# PNG
# ---------------------------------------------------------------------------

PNG_SIG = b"\x89PNG\r\n\x1a\n"
# chunks needed to display the image correctly (never removed)
PNG_RENDER_CHUNKS = {b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"cHRM", b"sRGB",
                     b"sBIT", b"pHYs", b"bKGD", b"hIST", b"cICP", b"mDCV", b"mDCv", b"cLLI", b"cLLi",
                     b"acTL", b"fcTL", b"fdAT"}


@dataclass
class PngChunk:
    type: bytes
    data: bytes

    def to_bytes(self) -> bytes:
        crc = zlib.crc32(self.type + self.data) & 0xFFFFFFFF
        return struct.pack(">I", len(self.data)) + self.type + self.data + struct.pack(">I", crc)


def parse_png(data: bytes) -> list[PngChunk]:
    if data[:8] != PNG_SIG:
        raise ValueError("not a PNG")
    pos, chunks = 8, []
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        chunks.append(PngChunk(ctype, data[pos + 8:pos + 8 + length]))
        pos += 12 + length
        if ctype == b"IEND":
            break
    return chunks


def write_png(chunks: list[PngChunk]) -> bytes:
    return PNG_SIG + b"".join(c.to_bytes() for c in chunks)


def decode_png_text(c: PngChunk) -> tuple[str, str]:
    """Return (keyword, text) for tEXt/zTXt/iTXt."""
    try:
        if c.type == b"tEXt":
            k, _, v = c.data.partition(b"\0")
            return k.decode("latin-1"), v.decode("latin-1")
        if c.type == b"zTXt":
            k, _, rest = c.data.partition(b"\0")
            return k.decode("latin-1"), zlib.decompress(rest[1:]).decode("latin-1", "replace")
        if c.type == b"iTXt":
            k, _, rest = c.data.partition(b"\0")
            comp_flag = rest[0]
            rest = rest[2:]
            _lang, _, rest = rest.partition(b"\0")
            _tkey, _, text = rest.partition(b"\0")
            if comp_flag:
                text = zlib.decompress(text)
            return k.decode("latin-1"), text.decode("utf-8", "replace")
    except Exception:  # corrupt chunk: still report it
        pass
    return c.type.decode("latin-1"), repr(c.data[:200])


def png_itxt(keyword: str, text: str) -> PngChunk:
    return PngChunk(b"iTXt", keyword.encode("latin-1") + b"\0\0\0\0\0" + text.encode("utf-8"))


def png_iccp(icc: bytes, name: bytes = b"ICC Profile") -> PngChunk:
    return PngChunk(b"iCCP", name + b"\0\0" + zlib.compress(icc))


def png_icc_from_chunk(c: PngChunk) -> bytes:
    _name, _, rest = c.data.partition(b"\0")
    return zlib.decompress(rest[1:])


# ---------------------------------------------------------------------------
# WebP (RIFF)
# ---------------------------------------------------------------------------

@dataclass
class RiffChunk:
    fourcc: bytes
    data: bytes

    def to_bytes(self) -> bytes:
        pad = b"\0" if len(self.data) % 2 else b""
        return self.fourcc + struct.pack("<I", len(self.data)) + self.data + pad


WEBP_IMAGE_CHUNKS = {b"VP8 ", b"VP8L", b"VP8X", b"ALPH", b"ANIM", b"ANMF"}


def parse_webp(data: bytes) -> list[RiffChunk]:
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("not a WebP")
    (riff_size,) = struct.unpack("<I", data[4:8])
    end = min(len(data), 8 + riff_size)
    pos, chunks = 12, []
    while pos + 8 <= end:
        fourcc = data[pos:pos + 4]
        (size,) = struct.unpack("<I", data[pos + 4:pos + 8])
        chunks.append(RiffChunk(fourcc, data[pos + 8:pos + 8 + size]))
        pos += 8 + size + (size & 1)
    return chunks


def write_webp(chunks: list[RiffChunk], width: int, height: int, has_alpha: bool) -> bytes:
    """Rebuild a WebP, (re)creating the VP8X header with correct feature flags."""
    present = {c.fourcc for c in chunks}
    needs_ext = bool(present & {b"ICCP", b"EXIF", b"XMP ", b"ANIM", b"C2PA"}) or b"ALPH" in present
    body = [c for c in chunks if c.fourcc != b"VP8X"]
    if needs_ext or b"VP8X" in present:
        old = next((c for c in chunks if c.fourcc == b"VP8X"), None)
        flags = 0
        if b"ICCP" in present:
            flags |= 0x20
        if has_alpha or b"ALPH" in present or (old and old.data[0] & 0x10):
            flags |= 0x10
        if b"EXIF" in present:
            flags |= 0x08
        if b"XMP " in present:
            flags |= 0x04
        if b"ANIM" in present:
            flags |= 0x02
        if old:
            canvas = old.data[4:10]
        else:
            canvas = struct.pack("<I", width - 1)[:3] + struct.pack("<I", height - 1)[:3]
        vp8x = RiffChunk(b"VP8X", bytes([flags, 0, 0, 0]) + canvas)
        # Spec order: VP8X, ICCP, ANIM, image data, EXIF, XMP, unknown
        order = {b"ICCP": 1, b"ANIM": 2, b"ANMF": 3, b"ALPH": 3, b"VP8 ": 3, b"VP8L": 3,
                 b"EXIF": 4, b"XMP ": 5}
        body.sort(key=lambda c: order.get(c.fourcc, 6))
        body = [vp8x] + body
    payload = b"WEBP" + b"".join(c.to_bytes() for c in body)
    return b"RIFF" + struct.pack("<I", len(payload)) + payload


# ---------------------------------------------------------------------------
# JUMBF / C2PA helpers
# ---------------------------------------------------------------------------

C2PA_UUID = bytes.fromhex("d8fec3d61b0e483c92975828877ec481")


def _cbor_text_after(blob: bytes, key: bytes) -> list[str]:
    """Find CBOR text strings that follow a CBOR text key (good enough for reporting)."""
    out, start = [], 0
    while True:
        i = blob.find(key, start)
        if i < 0:
            return out
        j = i + len(key)
        start = j
        if j >= len(blob):
            return out
        b = blob[j]
        if 0x60 <= b <= 0x77:
            n, off = b - 0x60, 1
        elif b == 0x78:
            n, off = blob[j + 1], 2
        elif b == 0x79:
            n, off = struct.unpack(">H", blob[j + 1:j + 3])[0], 3
        else:
            continue
        out.append(blob[j + off:j + off + n].decode("utf-8", "replace"))


def summarize_c2pa(blob: bytes) -> dict:
    import re
    info: dict = {"bytes": len(blob)}
    gens = _cbor_text_after(blob, b"claim_generator")
    names = _cbor_text_after(blob, b"name")
    if gens:
        info["claim_generator"] = gens[0]
    if names:
        info["generator_info"] = sorted(set(n for n in names if 0 < len(n) < 80))[:6]
    dst = sorted(set(m.decode() for m in re.findall(rb"digitalsourcetype/(\w+)", blob, re.I)))
    if dst:
        info["digital_source_type"] = dst
    actions = sorted(set(m.decode() for m in re.findall(rb"c2pa\.(?:created|opened|edited|placed|converted|"
                                                      rb"color_adjustments|cropped|filtered|resized|"
                                                      rb"drawing|published|transcoded|repackaged)", blob)))
    if actions:
        info["actions"] = actions
    labels = sorted(set(m.decode() for m in re.findall(rb"urn:(?:uuid|c2pa):[0-9a-zA-Z:\-\._]{8,80}", blob)))
    if labels:
        info["manifests"] = labels[:4]
    if b"c2pa.ai_generative_training" in blob or b"c2pa.training-mining" in blob:
        info["training_assertion"] = True
    return info


def find_bmff_c2pa(data: bytes) -> bytes | None:
    """Locate a top-level C2PA uuid box in ISO-BMFF (HEIF/AVIF/CR3)."""
    pos = 0
    while pos + 8 <= len(data):
        size, btype = struct.unpack(">I4s", data[pos:pos + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", data[pos + 8:pos + 16])[0]
            hdr = 16
        elif size == 0:
            size = len(data) - pos
        if size < hdr:
            break
        if btype == b"uuid" and data[pos + hdr:pos + hdr + 16] == C2PA_UUID:
            return data[pos:pos + size]
        pos += size
    return None
