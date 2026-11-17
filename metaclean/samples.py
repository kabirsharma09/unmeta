"""Generate synthetic images loaded with metadata (used by tests and `metaclean demo`)."""
from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageCms, ImageDraw

from . import containers as C
from . import metadata as M

AI_XMP = b"""<?xpacket begin='\xef\xbb\xbf' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
  xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
  xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"
  xmp:CreatorTool="Adobe Firefly" xmpMM:DocumentID="xmp.did:1234-abcd"
  photoshop:City="London" photoshop:Credit="Made with Google AI">
 <Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>
 <dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>
 <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">(c) 2026 Jane Doe</rdf:li></rdf:Alt></dc:rights>
 <xmpMM:History><rdf:Seq><rdf:li stEvt:action="created" stEvt:softwareAgent="Adobe Photoshop 26.0 (Generative Fill)"/></rdf:Seq></xmpMM:History>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end='w'?>"""


def _cbor_text(s: str) -> bytes:
    b = s.encode()
    return (bytes([0x60 + len(b)]) if len(b) < 24 else bytes([0x78, len(b)])) + b


def fake_c2pa() -> bytes:
    """A JUMBF superbox shaped like a C2PA manifest store (not cryptographically valid)."""
    claim = (b"\xa2" + _cbor_text("claim_generator") + _cbor_text("OpenAI-DALL-E/3 c2pa-rs/0.31")
             + _cbor_text("dc:format") + _cbor_text("image/jpeg"))
    assertion = (b"c2pa.actions" + _cbor_text("action") + _cbor_text("c2pa.created")
                 + b"http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia")
    def box(t: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload) + 8) + t + payload
    jumd = box(b"jumd", b"c2pa" + b"\x00\x11\x00\x10\x80\x00\xaa\x00\x38\x9b\x71\x03" + b"\x03c2pa\x00")
    inner = box(b"jumd", b"c2ma" + b"\x00" * 12 + b"\x03urn:uuid:5f0e3c2a-9a2b-4b2d-8f8e-1c2a3b4c5d6e\x00")
    return box(b"jumb", jumd + box(b"jumb", inner + box(b"cbor", claim) + box(b"cbor", assertion)))


def srgb_icc() -> bytes:
    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def rich_exif(orientation: int = 6) -> Image.Exif:
    e = Image.Exif()
    e[271] = "Apple"
    e[272] = "iPhone 15 Pro"
    e[274] = orientation
    e[305] = "17.4.1"
    e[306] = "2026:03:01 09:15:00"
    e[315] = "Jane Doe"
    e[33432] = "(c) 2026 Jane Doe"
    e[0x013C] = "Jane's iPhone"
    ex = e.get_ifd(0x8769)
    ex[36867] = "2026:03:01 09:15:00"
    ex[36881] = "+01:00"
    ex[33434] = 1 / 120
    ex[42033] = "C39XK1234ABC"          # BodySerialNumber
    ex[42036] = "iPhone 15 Pro back camera 6.86mm f/1.78"
    ex[42032] = "Jane Doe"              # CameraOwnerName
    gps = e.get_ifd(0x8825)
    gps[1], gps[2] = "N", (51.0, 30.0, 26.0)
    gps[3], gps[4] = "W", (0.0, 7.0, 39.0)
    gps[6] = 21.5
    return e


def _pattern(size=(64, 48)) -> Image.Image:
    im = Image.new("RGB", size, (30, 120, 200))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, size[0] // 2, size[1] // 3], fill=(240, 40, 40))  # red block top-left
    return im


def make_jpeg(orientation=6, with_trailer=True) -> bytes:
    im = _pattern()
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90, exif=rich_exif(orientation).tobytes(), icc_profile=srgb_icc())
    jf = C.parse_jpeg(buf.getvalue())
    iim = M.build_iim([(2, 80, b"Jane Doe"), (2, 90, b"London"), (2, 110, b"Made with Google AI"),
                       (2, 116, b"(c) 2026 Jane Doe"), (2, 25, b"holiday")])
    extra = [
        C.JpegSegment(0xE1, b"http://ns.adobe.com/xap/1.0/\0" + AI_XMP),
        C.JpegSegment(0xED, b"Photoshop 3.0\0" + M.build_irb([(0x0404, b"", iim)])),
        C.JpegSegment(0xEB, b"JP\x00\x01\x00\x00\x00\x01" + fake_c2pa()),
        C.JpegSegment(0xFE, b"Generated with Midjourney v7"),
        C.JpegSegment(0xEC, b"Ducky\0\x01\x00\x04\x00\x00\x00\x50"),
    ]
    head = jf.header[:1] + [s for s in jf.header[1:] if s.kind in ("exif", "icc")] + extra + \
        [s for s in jf.header[1:] if s.kind not in ("exif", "icc")]
    out = C.write_jpeg(head, jf.scan)
    if with_trailer:
        out += b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64  # fake motion-photo video
    return out


def make_png() -> bytes:
    im = _pattern()
    buf = io.BytesIO()
    im.save(buf, "PNG")
    chunks = C.parse_png(buf.getvalue())
    params = ("a photo of a cat astronaut\nNegative prompt: blurry\nSteps: 30, Sampler: DPM++ 2M, "
              "CFG scale: 7, Seed: 1234567, Model: sdxl_base_1.0")
    extra = [
        C.PngChunk(b"tEXt", b"parameters\0" + params.encode("latin-1")),
        C.PngChunk(b"tEXt", b"prompt\0" + b'{"3": {"class_type": "KSampler", "inputs": {"seed": 42}}}'),
        C.PngChunk(b"tEXt", b"Author\0Jane Doe"),
        C.PngChunk(b"tEXt", b"Copyright\0(c) 2026 Jane Doe"),
        C.png_itxt("XML:com.adobe.xmp", AI_XMP.decode("utf-8")),
        C.PngChunk(b"eXIf", rich_exif(1).tobytes()[6:]),
        C.PngChunk(b"tIME", struct.pack(">H", 2026) + bytes([3, 1, 9, 15, 0])),
        C.PngChunk(b"caBX", fake_c2pa()),
        C.PngChunk(b"prVt", b"private tracking data"),
        C.png_iccp(srgb_icc()),
    ]
    return C.write_png(chunks[:1] + extra + chunks[1:])


def make_webp(lossless=False, orientation=6) -> bytes:
    im = _pattern()
    buf = io.BytesIO()
    im.save(buf, "WEBP", lossless=lossless, quality=90, exif=rich_exif(orientation).tobytes(),
            xmp=AI_XMP, icc_profile=srgb_icc())
    chunks = C.parse_webp(buf.getvalue()) + [C.RiffChunk(b"C2PA", fake_c2pa())]
    return C.write_webp(chunks, im.width, im.height, False)


def make_heic(orientation=6) -> bytes:
    import pillow_heif  # noqa: F401
    from . import inspector  # noqa: F401  (registers opener)
    buf = io.BytesIO()
    _pattern().save(buf, "HEIF", quality=80, exif=rich_exif(orientation).tobytes(), xmp=AI_XMP)
    return buf.getvalue()


def make_avif(orientation=1) -> bytes:
    buf = io.BytesIO()
    _pattern().save(buf, "AVIF", quality=80, exif=rich_exif(orientation).tobytes(), xmp=AI_XMP)
    return buf.getvalue()


def make_tiff(orientation=1) -> bytes:
    buf = io.BytesIO()
    _pattern().save(buf, "TIFF", compression="tiff_lzw", exif=rich_exif(orientation).tobytes(),
                    tiffinfo={700: AI_XMP})
    return buf.getvalue()


def make_fake_raw() -> bytes:
    """TIFF-structured 'DNG' with camera EXIF plus an appended JPEG preview."""
    preview = io.BytesIO()
    _pattern((96, 64)).save(preview, "JPEG", quality=90)
    return make_tiff() + preview.getvalue()


ALL = {
    "photo_iphone.jpg": make_jpeg, "sd_generation.png": make_png, "firefly.webp": make_webp,
    "phone.heic": make_heic, "graphic.avif": make_avif, "scan.tif": make_tiff, "camera.dng": make_fake_raw,
}


def write_samples(folder: Path) -> list[Path]:
    folder.mkdir(parents=True, exist_ok=True)
    out = []
    for name, fn in ALL.items():
        p = folder / name
        p.write_bytes(fn())
        out.append(p)
    return out
