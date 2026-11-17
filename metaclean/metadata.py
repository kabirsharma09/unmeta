"""Readers and writers for XMP, IPTC-IIM / Photoshop IRB and EXIF values."""
from __future__ import annotations

import struct
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from fractions import Fraction

from .taxonomy import NS_PREFIX

RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
XML_NS = "http://www.w3.org/XML/1998/namespace"


# ---------------------------------------------------------------------------
# XMP
# ---------------------------------------------------------------------------

@dataclass
class XmpProp:
    qname: str      # prefix:local
    ns: str
    value: str      # flattened, human readable
    kind: str       # simple | seq | bag | alt | struct
    items: list[str]


def _prefix(ns: str) -> str:
    if ns in NS_PREFIX:
        return NS_PREFIX[ns]
    tail = ns.rstrip("/#").rsplit("/", 1)[-1]
    return tail or "ns"


def _split(tag: str) -> tuple[str, str]:
    if tag.startswith("{"):
        ns, local = tag[1:].split("}", 1)
        return ns, local
    return "", tag


def _flatten(el: ET.Element) -> tuple[str, str, list[str]]:
    """Flatten an XMP property element into (kind, text, items)."""
    for container, kind in (("Seq", "seq"), ("Bag", "bag"), ("Alt", "alt")):
        c = el.find(f"{{{RDF}}}{container}")
        if c is not None:
            items = []
            for li in c.findall(f"{{{RDF}}}li"):
                k, t, _ = _flatten(li)
                items.append(t)
            return kind, "; ".join(i for i in items if i), items
    children = list(el)
    struct_attrs = {k: v for k, v in el.attrib.items() if not k.startswith(f"{{{RDF}}}") and not k.startswith(f"{{{XML_NS}}}")}
    if children or struct_attrs:
        parts = []
        for k, v in struct_attrs.items():
            ns, local = _split(k)
            parts.append(f"{_prefix(ns)}:{local}={v}")
        for ch in children:
            if ch.tag == f"{{{RDF}}}Description":
                for k, v in ch.attrib.items():
                    if not k.startswith(f"{{{RDF}}}"):
                        ns, local = _split(k)
                        parts.append(f"{_prefix(ns)}:{local}={v}")
                for g in ch:
                    ns, local = _split(g.tag)
                    parts.append(f"{_prefix(ns)}:{local}={_flatten(g)[1]}")
            else:
                ns, local = _split(ch.tag)
                parts.append(f"{_prefix(ns)}:{local}={_flatten(ch)[1]}")
        return "struct", ", ".join(parts), parts
    resource = el.attrib.get(f"{{{RDF}}}resource")
    text = (el.text or "").strip() or (resource or "")
    return "simple", text, [text]


def parse_xmp(packet: bytes | str) -> list[XmpProp]:
    if isinstance(packet, bytes):
        packet = packet.decode("utf-8", "replace")
    start = packet.find("<x:xmpmeta")
    if start < 0:
        start = packet.find("<rdf:RDF")
    end_tag = "</x:xmpmeta>" if "</x:xmpmeta>" in packet else "</rdf:RDF>"
    end = packet.rfind(end_tag)
    if start < 0 or end < 0:
        return []
    xml = packet[start:end + len(end_tag)]
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return [XmpProp("xmp:Unparseable", "", xml[:300], "simple", [])]
    props: list[XmpProp] = []
    rdf = root if root.tag == f"{{{RDF}}}RDF" else root.find(f"{{{RDF}}}RDF")
    if rdf is None:
        return props
    for desc in rdf.findall(f"{{{RDF}}}Description"):
        for k, v in desc.attrib.items():
            ns, local = _split(k)
            if ns in (RDF, XML_NS):
                continue
            props.append(XmpProp(f"{_prefix(ns)}:{local}", ns, v, "simple", [v]))
        for el in desc:
            ns, local = _split(el.tag)
            kind, text, items = _flatten(el)
            props.append(XmpProp(f"{_prefix(ns)}:{local}", ns, text, kind, items))
    return props


def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def build_xmp(props: list[XmpProp]) -> bytes:
    nss = {}
    body = []
    for p in props:
        prefix = p.qname.split(":", 1)[0]
        nss[prefix] = p.ns
        if p.kind in ("seq", "bag", "alt"):
            tag = {"seq": "Seq", "bag": "Bag", "alt": "Alt"}[p.kind]
            lang = ' xml:lang="x-default"' if p.kind == "alt" else ""
            lis = "".join(f"<rdf:li{lang}>{_esc(i)}</rdf:li>" for i in p.items)
            body.append(f"<{p.qname}><rdf:{tag}>{lis}</rdf:{tag}></{p.qname}>")
        else:
            body.append(f"<{p.qname}>{_esc(p.value)}</{p.qname}>")
    ns_attrs = "".join(f' xmlns:{k}="{_esc(v)}"' for k, v in sorted(nss.items()))
    xml = ('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
           '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="' + RDF + '">'
           f'<rdf:Description rdf:about=""{ns_attrs}>' + "".join(body) +
           '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')
    return xml.encode("utf-8")


DC = "http://purl.org/dc/elements/1.1/"
XMP_NS = "http://ns.adobe.com/xap/1.0/"
PHOTOSHOP = "http://ns.adobe.com/photoshop/1.0/"


# ---------------------------------------------------------------------------
# Photoshop IRB / IPTC-IIM
# ---------------------------------------------------------------------------

IRB_NAMES = {0x0404: "IPTC-NAA record", 0x0409: "Thumbnail (PS4)", 0x040C: "Thumbnail",
             0x0425: "IPTC digest", 0x0422: "EXIF data 1", 0x0423: "EXIF data 3",
             0x0424: "XMP", 0x040F: "ICC profile", 0x03ED: "Resolution info", 0x0428: "Print info",
             0x041A: "Slices", 0x0408: "Grid and guides", 0x0414: "Document ID seed",
             0x041E: "URL list", 0x0421: "Version info", 0x0426: "Print scale"}


def parse_irb(data: bytes) -> list[tuple[int, bytes, bytes]]:
    """Parse Photoshop image resource blocks -> [(id, name, data)]."""
    out, pos = [], 0
    while pos + 12 <= len(data) and data[pos:pos + 4] in (b"8BIM", b"PHUT", b"AgHg", b"DCSR"):
        rid = struct.unpack(">H", data[pos + 4:pos + 6])[0]
        nlen = data[pos + 6]
        name = data[pos + 7:pos + 7 + nlen]
        pos += 6 + ((nlen + 2) & ~1)
        (size,) = struct.unpack(">I", data[pos:pos + 4])
        out.append((rid, name, data[pos + 4:pos + 4 + size]))
        pos += 4 + size + (size & 1)
    return out


def build_irb(blocks: list[tuple[int, bytes, bytes]]) -> bytes:
    out = b""
    for rid, name, data in blocks:
        n = bytes([len(name)]) + name
        if len(n) % 2:
            n += b"\0"
        out += b"8BIM" + struct.pack(">H", rid) + n + struct.pack(">I", len(data)) + data
        if len(data) % 2:
            out += b"\0"
    return out


def parse_iim(data: bytes) -> list[tuple[int, int, bytes]]:
    out, pos = [], 0
    while pos + 5 <= len(data) and data[pos] == 0x1C:
        rec, ds = data[pos + 1], data[pos + 2]
        (ln,) = struct.unpack(">H", data[pos + 3:pos + 5])
        pos += 5
        if ln & 0x8000:  # extended dataset
            nb = ln & 0x7FFF
            ln = int.from_bytes(data[pos:pos + nb], "big")
            pos += nb
        out.append((rec, ds, data[pos:pos + ln]))
        pos += ln
    return out


def build_iim(datasets: list[tuple[int, int, bytes]]) -> bytes:
    out = b""
    have_charset = any(r == 1 and d == 90 for r, d, _ in datasets)
    if not have_charset:
        datasets = [(1, 90, b"\x1b%G")] + datasets  # declare UTF-8
    for rec, ds, val in sorted(datasets, key=lambda x: (x[0], x[1])):
        out += bytes([0x1C, rec, ds]) + struct.pack(">H", len(val)) + val
    return out


def iim_text(val: bytes) -> str:
    try:
        return val.decode("utf-8")
    except UnicodeDecodeError:
        return val.decode("latin-1")


# ---------------------------------------------------------------------------
# EXIF value formatting
# ---------------------------------------------------------------------------

def exif_text(name: str, value) -> str:
    if isinstance(value, bytes):
        if name == "UserComment" and len(value) >= 8:
            prefix, body = value[:8], value[8:]
            if prefix.startswith(b"UNICODE"):
                for enc in ("utf-16-be", "utf-16-le"):
                    try:
                        return body.decode(enc).strip("\0 ")
                    except UnicodeDecodeError:
                        pass
            return body.decode("utf-8", "replace").strip("\0 ")
        if name.startswith("XP"):
            return value.decode("utf-16-le", "replace").strip("\0")
        if name == "MakerNote":
            return f"<{len(value)} bytes of vendor data>"
        try:
            text = value.decode("utf-8")
            if text.isprintable() or all(c.isprintable() or c in "\0\t\r\n" for c in text):
                return text.strip("\0 ")
        except UnicodeDecodeError:
            pass
        if all(32 <= b < 127 or b in (0, 9, 10, 13) for b in value[:64]):
            return value.decode("latin-1").strip("\0 ")
        return f"<{len(value)} bytes>"
    if isinstance(value, tuple):
        if name.startswith("XP") and all(isinstance(v, int) for v in value):
            return bytes(value).decode("utf-16-le", "replace").strip("\0")
        return ", ".join(exif_text(name, v) for v in value)
    if isinstance(value, str) and not value.isascii():
        try:  # UTF-8 stored in an ASCII field and decoded as latin-1
            return value.encode("latin-1").decode("utf-8").strip("\0 ")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    if isinstance(value, (Fraction,)) or hasattr(value, "numerator"):
        try:
            f = float(value)
            if name == "ExposureTime" and 0 < f < 1:
                return f"1/{round(1 / f)} s"
            return f"{f:.6g}"
        except (ZeroDivisionError, ValueError, TypeError):
            return str(value)
    return str(value).strip("\0 ")


def gps_to_decimal(gps: dict) -> tuple[float, float] | None:
    try:
        def conv(dms, ref):
            d, m, s = (float(x) for x in dms)
            v = d + m / 60 + s / 3600
            return -v if ref in ("S", "W") else v
        lat = conv(gps[2], gps.get(1, "N"))
        lon = conv(gps[4], gps.get(3, "E"))
        return round(lat, 6), round(lon, 6)
    except Exception:
        return None
