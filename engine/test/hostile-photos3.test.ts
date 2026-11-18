// Hostile photos from the fourth parser review: dynamic-media XMP (xmpDM) people and places classed as "technical",
// an embedded TIFF preview whose metadata shares bytes with the main picture's strip offsets, a HEIF Exif item whose
// extent length is 0 ("to the end of the file"), and a kept PNG colour profile written after the palette.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { clean, samePixels } from "../src/clean.ts";
import * as C from "../src/containers.ts";
import { PRESETS } from "../src/presets.ts";
import { readExif } from "../src/tiff.ts";

const ALL = PRESETS.everything.options;
const enc = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const cat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p));
const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return new Uint8Array(b); };
const be16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return new Uint8Array(b); };
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return new Uint8Array(b); };
const le16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return new Uint8Array(b); };
const box = (t: string, ...body: Uint8Array[]) => { const b = cat(...body); return cat(be32(b.length + 8), enc(t), b); };
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, "latin1"));
const app = (m: number, payload: Uint8Array) => cat(new Uint8Array([0xff, m]), be16(payload.length + 2), payload);
function jpeg(...segs: Uint8Array[]) {
  const sof = cat(enc("\xff\xc0"), be16(11), new Uint8Array([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
  const dqt = cat(enc("\xff\xdb"), be16(67), new Uint8Array(65).fill(1));
  const sos = cat(enc("\xff\xda"), be16(8), new Uint8Array([1, 1, 0, 0, 63, 0]));
  return cat(enc("\xff\xd8"), ...segs, dqt, sof, sos, new Uint8Array([0x12, 0x34, 0x56]), enc("\xff\xd9"));
}

test("xmpDM people, places and comments are private; only encoding properties are technical", () => {
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/" xmpDM:artist="Jane Doe" xmpDM:shotLocation="221B Baker Street London" xmpDM:videoFrameRate="24" xmpDM:someFutureThing="Secret Value"><xmpDM:engineer>John Smith</xmpDM:engineer><xmpDM:logComment>shot at home, 51.5074 -0.1278</xmpDM:logComment></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const file = jpeg(app(0xe1, cat(enc("http://ns.adobe.com/xap/1.0/\0"), enc(xmp))));
  const r = clean(file, "a.jpg", ALL);
  for (const s of ["Jane Doe", "Baker Street", "John Smith", "51.5074", "Secret Value"]) assert.ok(!has(r.data, s), `${s} left`);
  const cat_ = (q: string) => r.before.fields.find(f => f.id === `xmp:${q}`)?.category;
  assert.equal(cat_("xmpDM:artist"), "personal");
  assert.equal(cat_("xmpDM:shotLocation"), "location");
  assert.equal(cat_("xmpDM:videoFrameRate"), "technical");
  assert.notEqual(cat_("xmpDM:someFutureThing"), "technical");
  assert.equal(r.verified, true);
  assert.equal(r.pixelsUntouched, true);
});

test("TIFF preview metadata that overlaps the strip offsets is not blanked, and samePixels reads each file's own offsets", () => {
  const pix = new Uint8Array(32).fill(0x77);
  const preview = jpeg(app(0xe1, cat(le32(8), le32(24))));   // APP1 payload == StripOffsets array
  const prevOff = 40, soPos = prevOff + 6;
  const artist = enc("Jane Doe\0\0");
  const ifdOff = prevOff + preview.length + (preview.length & 1);
  const ents: [number, number, number, Uint8Array][] = [[256, 3, 1, le16(4)], [257, 3, 1, le16(8)], [258, 3, 1, le16(8)], [259, 3, 1, le16(1)],
    [262, 3, 1, le16(1)], [273, 4, 2, le32(soPos)], [278, 3, 1, le16(4)], [279, 4, 2, le32(0)], [315, 2, artist.length, le32(0)],
    [0x201, 4, 1, le32(prevOff)], [0x202, 4, 1, le32(preview.length)]];
  const dataStart = ifdOff + 2 + ents.length * 12 + 4;
  ents[7][3] = le32(dataStart); ents[8][3] = le32(dataStart + 8);
  const ent = (t: number, ty: number, c: number, v: Uint8Array) => { const x = new Uint8Array(12); x.set(le16(t), 0); x.set(le16(ty), 2); x.set(le32(c), 4); x.set(v, 8); return x; };
  const file = cat(enc("II*\0"), le32(ifdOff), pix, preview, new Uint8Array(preview.length & 1), le16(ents.length), ...ents.map(e => ent(...e)), le32(0), le32(16), le32(16), artist);
  const r = clean(file, "a.tif", ALL);
  assert.deepEqual(readExif(r.data).ifd0.get(273)?.value, [8, 24]);
  assert.equal(r.verified, false);
  assert.equal(r.pixelsUntouched, true);
  assert.ok(!has(r.data, "Jane Doe"));
  // a copy whose strip offsets were zeroed must not count as the same picture
  const broken = file.slice(); broken.fill(0, soPos, soPos + 8);
  assert.equal(samePixels(r.before, file, broken), false);
});

test("HEIF Exif item with extent_length 0 runs to the end of the file and is blanked", () => {
  const full = (t: string, v: number, ...b: Uint8Array[]) => box(t, new Uint8Array([v, 0, 0, 0]), ...b);
  const infe = (id: number, type: string) => full("infe", 2, be16(id), be16(0), enc(type), enc("\0"));
  const art = enc("Jane Doe\0\0");
  const tiff = cat(enc("MM\0*"), be32(8), be16(1), be16(315), be16(2), be32(art.length), be32(26), be32(0), art);
  const exif = cat(be32(0), enc("Exif\0\0"), tiff);
  const pic = new Uint8Array(64).fill(0x55);
  const ftyp = box("ftyp", enc("heic"), be32(0), enc("mif1heic"));
  const mk = (exifOff: number, picOff: number) => {
    const e = (id: number, off: number, len: number) => cat(be16(id), be16(0), be16(0), be16(1), be32(off), be32(len));
    return full("meta", 0, full("hdlr", 0, be32(0), enc("pict"), new Uint8Array(13)), full("pitm", 0, be16(1)),
      full("iinf", 0, be16(2), infe(1, "hvc1"), infe(2, "Exif")),
      full("iloc", 1, new Uint8Array([0x44, 0x00]), be16(2), e(1, picOff, pic.length), e(2, exifOff, 0)));
  };
  const body = ftyp.length + mk(0, 0).length + 8;
  const file = cat(ftyp, mk(body + pic.length, body), box("mdat", pic, exif));
  const r = clean(file, "a.heic", ALL);
  assert.ok(r.before.fields.some(f => f.id === "exif:0:315"), "the Exif item should be found");
  assert.ok(!has(r.data, "Jane Doe"));
  assert.equal(r.pixelsUntouched, true);
  // the same zero-length Exif item placed before the picture would run over it: left alone, and never verified
  const body2 = ftyp.length + mk(0, 0).length + 8;
  const file2 = cat(ftyp, mk(body2, body2 + exif.length), box("mdat", exif, pic));
  const r2 = clean(file2, "b.heic", ALL);
  assert.equal(r2.verified, false);
  assert.equal(r2.pixelsUntouched, true);
});

test("PNG: a kept colour profile is written before PLTE and IDAT", () => {
  const ch = (type: string, data: Uint8Array) => ({ type, data });
  const icc = new Uint8Array(200); icc.set(enc("acsp"), 36);
  const file = C.writePng([ch("IHDR", cat(be32(1), be32(1), new Uint8Array([8, 3, 0, 0, 0]))),
    ch("iCCP", cat(enc("prof\0\0"), new Uint8Array(deflateSync(Buffer.from(icc))))), ch("gAMA", be32(45455)),
    ch("PLTE", new Uint8Array([255, 0, 0])), ch("IDAT", new Uint8Array(deflateSync(Buffer.from([0, 0])))),
    ch("tEXt", enc("Author\0Jane Doe")), ch("IEND", new Uint8Array(0))]);
  const r = clean(file, "a.png", ALL);
  const order = C.parsePng(r.data).map(c => c.type);
  assert.ok(order.includes("iCCP"));
  assert.ok(order.indexOf("iCCP") < order.indexOf("PLTE") && order.indexOf("gAMA") < order.indexOf("PLTE"), order.join(","));
  assert.ok(order.indexOf("PLTE") < order.indexOf("IDAT"));
  assert.ok(!has(r.data, "Jane Doe"));
  assert.equal(r.verified, true);
  assert.equal(r.pixelsUntouched, true);
});
