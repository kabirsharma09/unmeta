// Hostile files from the independent parser review. Each one once let a private detail survive a clean that
// said "verified", or hung/crashed the engine. The rule every case checks: never report a file clean while the
// secret is still in it. Most cases now also remove the secret outright.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync, inflateRawSync } from "node:zlib";
import { clean } from "../src/clean.ts";
import { inspect } from "../src/inspect.ts";
import { PRESETS } from "../src/presets.ts";
import * as C from "../src/containers.ts";
import { parseXmp } from "../src/xmp.ts";
import { type Part, type Source, bytesSource, cleanMedia } from "../src/media.ts";
import { cleanDocument } from "../src/docs.ts";

const enc = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const cat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p.map(x => Buffer.from(x))));
const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return new Uint8Array(b); };
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return new Uint8Array(b); };
const box = (t: string, ...body: Uint8Array[]) => { const b = cat(...body); return cat(be32(b.length + 8), enc(t), b); };
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, "latin1"));
const join = (src: Uint8Array, parts: Part[]) => cat(...parts.map(p => "bytes" in p ? p.bytes : src.subarray(p.from, p.to)));
const ALL = PRESETS.everything.options;
const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url)));
const safe = (verified: boolean, left: boolean, what: string) => assert.ok(!(verified && left), `${what}: reported clean but the secret is still there`);

async function media(file: Uint8Array, name: string, o = ALL) {
  const r = await cleanMedia(bytesSource(file), name, o);
  return { r, out: join(file, r.parts) };
}

const GPS = box("\xa9xyz", new Uint8Array([0, 18, 0x15, 0xc7]), enc("+51.5074-000.1278/"));
const FTYP = box("ftyp", enc("isom"), be32(0), enc("isom"));
const MVHD = box("mvhd", new Uint8Array(100));

test("MP4: a metadata key named 'constructor' doesn't hide the location", async () => {
  const keys = box("keys", be32(0), be32(1), cat(be32(19), enc("mdta"), enc("constructor")));
  const ilst = box("ilst", cat(be32(25), be32(1), box("data", be32(1), be32(0), enc("x"))));
  const meta = box("meta", be32(0), box("hdlr", be32(0), be32(0), enc("mdta"), new Uint8Array(12)), keys, ilst);
  const file = cat(FTYP, box("moov", MVHD, meta, box("udta", GPS)), box("mdat", new Uint8Array(64)));
  const { r, out } = await media(file, "a.mp4");
  assert.equal(has(out, "+51.5074"), false); assert.equal(r.verified, true);
});

test("MP4: a broken character reference in XMP doesn't abort the scan", async () => {
  const xmp = box("XMP_", enc(`<x:xmpmeta><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description a="&#abc;"/></rdf:RDF></x:xmpmeta>`));
  const file = cat(FTYP, box("moov", MVHD, box("udta", xmp, GPS)), box("mdat", new Uint8Array(64)));
  const { out } = await media(file, "a.mov");
  assert.equal(has(out, "+51.5074"), false);
});

test("MP4: 200,000 nested boxes stop at a depth cap, quickly, and aren't reported clean", async () => {
  const N = 200000, nest = new Uint8Array(N * 8), dv = new DataView(nest.buffer);
  for (let i = 0; i < N; i++) { dv.setUint32(i * 8, (N - i) * 8); nest.set(enc("trak"), i * 8 + 4); }
  const file = cat(FTYP, box("moov", nest, box("udta", GPS)), box("mdat", new Uint8Array(64)));
  const t = Date.now();
  const { r, out } = await media(file, "a.mp4");
  assert.ok(Date.now() - t < 5000);
  safe(r.verified, has(out, "+51.5074"), "deep nesting");
  assert.equal(r.verified, false);
});

test("MP4: a 300 MB details block is refused, not read into memory", async () => {
  const big = 300 * 1024 * 1024, head = cat(FTYP, be32(big), enc("moov"), box("udta", GPS)), size = FTYP.length + big;
  const src: Source = { size, read: async (o: number, n: number) => { const out = new Uint8Array(Math.max(0, Math.min(size, o + n) - o)); out.set(head.subarray(o, o + out.length)); return out; } };
  const r = await cleanMedia(src, "a.mp4", ALL);
  assert.equal(r.verified, false);
  assert.ok(r.before.errors.length > 0);
});

const ss = (n: number) => new Uint8Array([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const frame = (id: string, s: string) => { const b = cat(new Uint8Array([0]), enc(s)); return cat(enc(id), be32(b.length), new Uint8Array(2), b); };
const id3 = (...f: Uint8Array[]) => { const b = cat(...f); return cat(enc("ID3"), new Uint8Array([3, 0, 0]), ss(b.length), b); };
const AUDIO = (() => { const a = new Uint8Array(4000).fill(0x55); a[0] = 0xff; a[1] = 0xfb; return a; })();

test("MP3: an APE tag at the end is removed", async () => {
  const items = cat(le32(8), le32(0), enc("Artist\0Jane Doe"));
  const footer = (flags: number) => cat(enc("APETAGEX"), le32(2000), le32(items.length + 32), le32(1), le32(flags), new Uint8Array(8));
  const ape = cat(footer(0xa0000000), items, footer(0x80000000));
  const { r, out } = await media(cat(id3(frame("TIT2", "x")), AUDIO, ape), "a.mp3");
  assert.equal(has(out, "Jane Doe"), false); assert.equal(r.verified, true);
});

test("MP3: a malformed APE tag is never reported clean", async () => {
  const ape = cat(enc("APETAGEX"), new Uint8Array(24), enc("Artist\0Jane Doe\0"), enc("APETAGEX"), new Uint8Array(24));
  const { r, out } = await media(cat(id3(frame("TIT2", "x")), AUDIO, ape), "a.mp3");
  safe(r.verified, has(out, "Jane Doe"), "malformed APE");
});

test("MP3: an ID3 tag appended at the end is removed", async () => {
  const file = cat(AUDIO, enc("ID3"), new Uint8Array([4, 0, 0x10]), ss(24), frame("TPE1", "Jane Doe"), enc("3DI"), new Uint8Array([4, 0, 0x10]), ss(24));
  const { r, out } = await media(file, "a.mp3");
  safe(r.verified, has(out, "Jane Doe"), "appended ID3");
  assert.equal(has(out, "Jane Doe"), false);
});

test("MP3: a second ID3 tag can't smuggle a location past 'keep everything but location'", async () => {
  const file = cat(id3(frame("TPE1", "Jane Doe"), frame("TXXX", "\0GPS +51.5074")), id3(frame("TXXX", "\0location 51.50 -0.12")), AUDIO);
  const { r, out } = await media(file, "a.mp3", PRESETS.location.options);
  safe(r.verified, has(out, "51.50"), "second ID3");
});

test("WAV: notes in an adtl list are reported and removed", async () => {
  const ck = (id: string, b: Uint8Array) => cat(enc(id), le32(b.length), b, b.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
  const fmt = ck("fmt ", new Uint8Array([1, 0, 1, 0, 0x44, 0xac, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0]));
  const adtl = ck("LIST", cat(enc("adtl"), ck("note", cat(be32(1), enc("Recorded at Jane Doe's flat\0")))));
  const body = cat(fmt, ck("data", new Uint8Array(100)), adtl);
  const { r, out } = await media(cat(enc("RIFF"), le32(body.length + 4), enc("WAVE"), body), "a.wav");
  assert.ok(r.before.fields.length > 0); assert.equal(has(out, "Jane Doe"), false); assert.equal(r.verified, true);
});

test("DNG: camera serial number and original raw file name are found and removed", () => {
  const ents: [number, number, Uint8Array][] = [[256, 3, new Uint8Array([8, 0, 0, 0])], [50735, 2, enc("SN-C39XK1234ABC\0")], [50827, 2, enc("JaneDoe_home.CR2\0")]];
  const n = ents.length, dirLen = 2 + n * 12 + 4; let pos = 8 + dirLen;
  const head = Buffer.alloc(8 + dirLen); head.write("II*\0", 0, "latin1"); head.writeUInt32LE(8, 4); head.writeUInt16LE(n, 8);
  const datas: Buffer[] = [];
  ents.forEach(([tag, type, v], i) => { const o = 10 + i * 12; head.writeUInt16LE(tag, o); head.writeUInt16LE(type, o + 2);
    head.writeUInt32LE(type === 3 ? 1 : v.length, o + 4); if (v.length <= 4) Buffer.from(v).copy(head, o + 8); else { head.writeUInt32LE(pos, o + 8); datas.push(Buffer.from(v)); pos += v.length; } });
  const r = clean(new Uint8Array(Buffer.concat([head, ...datas])), "x.dng", ALL);
  assert.equal(has(r.data, "C39XK1234ABC"), false); assert.equal(has(r.data, "JaneDoe_home"), false);
});

test("JPEG: text hidden in odd segments is removed or the file isn't called clean", () => {
  const jf = C.parseJpeg(fixture("apple.jpg"));
  const structural = jf.header.filter((s: { marker: number; payload: Uint8Array }) => C.segKind(s) === "structural");
  const seg = (marker: number, payload: Uint8Array) => ({ marker, payload });
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/"><xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType="Resource"><xmpGImg:image>ORIGINALTHUMB</xmpGImg:image></rdf:li></rdf:Alt></xmp:Thumbnails><GImage:Data xmlns:GImage="http://ns.google.com/photos/1.0/image/">PORTRAITB64</GImage:Data></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const sosLen = (jf.scan[2] << 8) | jf.scan[3];
  const cases: [string, unknown[], Uint8Array, string][] = [
    ["APP0 that isn't JFIF", [seg(0xe0, enc("Owner: Jane Doe\0")), ...structural], jf.scan, "Jane Doe"],
    ["JFIF thumbnail", [seg(0xe0, cat(enc("JFIF\0"), new Uint8Array([1, 2, 0, 0, 1, 0, 1, 2, 2]), enc("THUMBPIXELS!"))), ...structural], jf.scan, "THUMBPIXELS!"],
    ["comment between scans", structural, cat(jf.scan.subarray(0, jf.scan.length - 2), new Uint8Array([0xff, 0xfe, 0, 15]), enc("Jane Doe GPS!"), new Uint8Array([0xff, 0xd9])), "Jane Doe GPS!"],
    ["text after Adobe APP14", [seg(0xee, enc("Adobe\0d\0\0\0\0\x01Jane Doe")), ...structural], jf.scan, "Jane Doe"],
    ["JPEG extension marker F7", [seg(0xf7, enc("Jane Doe 51.5074")), ...structural], jf.scan, "Jane Doe"],
    ["XMP thumbnails", [seg(0xe1, cat(enc("http://ns.adobe.com/xap/1.0/\0"), enc(xmp))), ...structural], jf.scan, "ORIGINALTHUMB"],
    ["XMP portrait image", [seg(0xe1, cat(enc("http://ns.adobe.com/xap/1.0/\0"), enc(xmp))), ...structural], jf.scan, "PORTRAITB64"],
  ];
  assert.ok(sosLen > 0);
  for (const [name, header, scan, needle] of cases) {
    const r = clean(C.writeJpeg(header as never, scan), "x.jpg", ALL);
    assert.equal(has(r.data, needle), false, name);
  }
});

test("JPEG: a DigitalSourceType of 'constructor' doesn't crash the inspector", () => {
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="x/constructor"/></rdf:RDF></x:xmpmeta>`;
  const jpg = fixture("apple.jpg");
  const seg = cat(new Uint8Array([0xff, 0xe1, (xmp.length + 31) >> 8, (xmp.length + 31) & 255]), enc("http://ns.adobe.com/xap/1.0/\0"), enc(xmp));
  assert.doesNotThrow(() => inspect(cat(jpg.subarray(0, 2), seg, jpg.subarray(2)), "x.jpg"));
});

test("PNG: a 400 MB compressed-text bomb is capped (fast, bounded memory)", () => {
  const ihdr = { type: "IHDR", data: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]) };
  const idat = { type: "IDAT", data: new Uint8Array(deflateSync(Buffer.from([0, 0]))) };
  const z = new Uint8Array(deflateSync(Buffer.alloc(400 * 1024 * 1024), { level: 9 }));
  const png = C.writePng([ihdr, { type: "zTXt", data: cat(enc("Comment\0\0"), z) }, idat, { type: "IEND", data: new Uint8Array(0) }]);
  const t = Date.now();
  inspect(png, "a.png");
  assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
});

test("XMP: pathological markup parses in linear time", () => {
  for (const unit of ["<a", "<!--"]) {
    const t = Date.now();
    parseXmp(`<x:xmpmeta>${unit.repeat(40000)}</x:xmpmeta>`);
    assert.ok(Date.now() - t < 500, unit);
  }
});

test("Word: core.xml under odd case or relative paths still has its author removed", async () => {
  for (const f of ["control.docx", "case.docx", "relcase.docx", "relpath.docx"]) {
    const d = new Uint8Array(readFileSync(new URL(`./hostile/${f}`, import.meta.url)));
    const r = await cleanDocument(bytesSource(d), f, ALL);
    const b = Buffer.from(join(d, r.parts));
    let left = false;
    for (let i = b.indexOf("PK\x03\x04"); i >= 0; i = b.indexOf("PK\x03\x04", i + 4)) {
      const cs = b.readUInt32LE(i + 18), nl = b.readUInt16LE(i + 26), xl = b.readUInt16LE(i + 28), m = b.readUInt16LE(i + 8);
      const data = b.subarray(i + 30 + nl + xl, i + 30 + nl + xl + cs);
      try { if ((m === 8 ? inflateRawSync(data) : data).includes("Jane Doe")) left = true; } catch { /* not a deflate stream */ }
    }
    safe(r.verified, left, f);
    assert.equal(left, false, f);
  }
});
