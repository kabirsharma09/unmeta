"""Lossless in-place cleaning for HEIC/HEIF, AVIF, TIFF and RAW.

Instead of decoding and re-encoding the picture, metadata bytes are overwritten where they sit.
Every offset in the file stays valid and the compressed image data is untouched.
(Same approach as the mobile engine in engine/src/bmff.ts and clean.ts.)
"""
from __future__ import annotations

import struct

from .containers import C2PA_UUID

EMPTY_TIFF = b"MM\x00*\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00"


# ---------------------------------------------------------------- ISO-BMFF
def _boxes(d: bytes, start: int, end: int):
    pos = start
    while pos + 8 <= end:
        size, = struct.unpack(">I", d[pos:pos + 4])
        btype = d[pos + 4:pos + 8]
        hdr = 8
        if size == 1:
            size, = struct.unpack(">Q", d[pos + 8:pos + 16])
            hdr = 16
        elif size == 0:
            size = end - pos
        if size < hdr or pos + size > end:
            return
        yield btype, pos, pos + hdr, pos + size
        pos += size


def _n(d: bytes, o: int, n: int) -> int:
    return int.from_bytes(d[o:o + n], "big") if n else 0


def heif_items(d: bytes) -> list[dict]:
    meta = next((b for b in _boxes(d, 0, len(d)) if b[0] == b"meta"), None)
    if not meta:
        return []
    kids = list(_boxes(d, meta[2] + 4, meta[3]))
    items: dict[int, dict] = {}
    iinf = next((k for k in kids if k[0] == b"iinf"), None)
    if iinf:
        v = d[iinf[2]]
        first = iinf[2] + 4 + (2 if v == 0 else 4)
        for t, _s, body, end in _boxes(d, first, iinf[3]):
            if t != b"infe" or d[body] < 2:
                continue
            iv = d[body]
            p = body + 4
            iid = _n(d, p, 2 if iv == 2 else 4)
            p += (2 if iv == 2 else 4) + 2
            itype = d[p:p + 4]
            p += 4
            p = d.index(b"\0", p) + 1
            ctype = b""
            if itype == b"mime":
                z = d.find(b"\0", p, end)
                ctype = d[p:z if z >= 0 else end]
            items[iid] = {"id": iid, "type": itype, "content_type": ctype, "extents": []}
    idat = next((k for k in kids if k[0] == b"idat"), None)
    iloc = next((k for k in kids if k[0] == b"iloc"), None)
    if iloc:
        v = d[iloc[2]]
        p = iloc[2] + 4
        off_s, len_s, base_s = d[p] >> 4, d[p] & 15, d[p + 1] >> 4
        idx_s = d[p + 1] & 15 if v > 0 else 0
        p += 2
        count = _n(d, p, 2 if v < 2 else 4)
        p += 2 if v < 2 else 4
        for _ in range(count):
            iid = _n(d, p, 2 if v < 2 else 4)
            p += 2 if v < 2 else 4
            method = 0
            if v > 0:
                method = _n(d, p, 2) & 15
                p += 2
            p += 2
            base = _n(d, p, base_s)
            p += base_s
            ne = _n(d, p, 2)
            p += 2
            ext = []
            for _ in range(ne):
                p += idx_s
                off = _n(d, p, off_s); p += off_s
                ln = _n(d, p, len_s); p += len_s
                origin = idat[2] if method == 1 and idat else 0
                ext.append((origin + base + off, ln))
            if iid in items and method != 2:
                items[iid]["extents"] = ext
    return list(items.values())


def item_bytes(d: bytes | bytearray, it: dict) -> bytes:
    return b"".join(bytes(d[o:o + n]) for o, n in it["extents"])


def write_item(d: bytearray, it: dict, data: bytes, pad: int = 0) -> bool:
    total = sum(n for _, n in it["extents"])
    if len(data) > total:
        return False
    buf = data + bytes([pad]) * (total - len(data))
    pos = 0
    for o, n in it["extents"]:
        d[o:o + n] = buf[pos:pos + n]
        pos += n
    return True


def blank_c2pa_boxes(d: bytearray) -> int:
    n = 0
    for t, start, body, end in list(_boxes(bytes(d), 0, len(d))):
        if t == b"uuid" and bytes(d[body:body + 16]) == C2PA_UUID:
            d[start + 4:start + 8] = b"free"
            d[body:end] = bytes(end - body)
            n += 1
    return n


def clean_heif(data: bytes, exif_tiff: bytes | None, xmp: bytes | None, keep_c2pa: bool, notes: list[str]) -> bytes:
    d = bytearray(data)
    for it in heif_items(data):
        if not it["extents"]:
            continue
        if it["type"] == b"Exif":
            blob = b"\x00\x00\x00\x06Exif\x00\x00" + (exif_tiff or EMPTY_TIFF)
            if not write_item(d, it, blob):
                write_item(d, it, b"\x00\x00\x00\x06Exif\x00\x00" + EMPTY_TIFF)
                notes.append("Some details you chose to keep didn't fit and were removed.")
        elif it["type"] == b"mime" and b"xml" in it["content_type"]:
            if not xmp or not write_item(d, it, xmp, 0x20):
                write_item(d, it, b"", 0x20)
    if not keep_c2pa:
        blank_c2pa_boxes(d)
    return bytes(d)


def heif_picture_bytes(d: bytes) -> bytes:
    return b"".join(item_bytes(d, it) for it in heif_items(d) if it["type"] not in (b"Exif", b"mime", b"uri "))


# ---------------------------------------------------------------- TIFF / RAW
TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 129: 1}


def tiff_entries(d: bytes) -> dict[str, dict[int, tuple[int, int]]]:
    """Map ifd name -> {tag: (value_offset, value_length)} for IFD0, Exif and GPS."""
    view = b"II*\x00" + d[4:] if d[:4] in (b"IIRO", b"IIRS", b"IIU\x00") else d
    le = view[:2] == b"II"
    e = "<" if le else ">"
    u16 = lambda o: struct.unpack(e + "H", view[o:o + 2])[0]
    u32 = lambda o: struct.unpack(e + "I", view[o:o + 4])[0]

    def ifd(off):
        out = {}
        if not off or off + 2 > len(view):
            return out
        n = u16(off)
        for i in range(min(n, 1000)):
            p = off + 2 + i * 12
            if p + 12 > len(view):
                break
            tag, typ, cnt = u16(p), u16(p + 2), u32(p + 4)
            ln = TYPE_SIZE.get(typ, 0) * cnt
            if not ln:
                continue
            vo = p + 8 if ln <= 4 else u32(p + 8)
            if vo + ln <= len(view):
                out[tag] = (vo, ln, typ)
        return out

    ifd0 = ifd(u32(4))
    ptr = lambda m, t: u32(m[t][0]) if t in m and m[t][1] == 4 else 0
    return {"0": ifd0, "exif": ifd(ptr(ifd0, 0x8769)), "gps": ifd(ptr(ifd0, 0x8825))}


def clean_tiff(data: bytes, field_ids: set[str], intended: set[str], protected: set[str], xmp: bytes | None,
               keep_c2pa: bool) -> bytes:
    d = bytearray(data)
    ents = tiff_entries(data)
    for ifd_name, m in ents.items():
        for tag, (off, ln, _t) in m.items():
            fid = f"exif:{ifd_name}:{tag}"
            if fid in field_ids and fid not in intended and fid not in protected:
                d[off:off + ln] = bytes(ln)
    for tag in (700, 33723, 34377):
        if tag in ents["0"]:
            off, ln, _t = ents["0"][tag]
            if tag == 700 and xmp and len(xmp) <= ln:
                d[off:off + ln] = xmp + b" " * (ln - len(xmp))
            else:
                d[off:off + ln] = bytes(ln)
    if 0x927C in ents["exif"]:
        off, ln, _t = ents["exif"][0x927C]
        d[off:off + ln] = bytes(ln)
    if not keep_c2pa:
        blank_c2pa_boxes(d)
    return bytes(d)


def tiff_picture_bytes(d: bytes) -> bytes:
    ents = tiff_entries(d)["0"]
    view = d
    le = view[:2] == b"II" or view[:4] in (b"IIRO", b"IIRS", b"IIU\x00")
    out = b""
    for otag, ltag in ((273, 279), (324, 325)):
        if otag in ents and ltag in ents:
            def vals(tag):
                off, ln, typ = ents[tag]
                size = 2 if typ == 3 else 4
                fmt = ("<" if le else ">") + ("H" if size == 2 else "I") * (ln // size)
                return struct.unpack(fmt, view[off:off + ln])
            for o, n in zip(vals(otag), vals(ltag)):
                out += view[o:o + n]
    return out
