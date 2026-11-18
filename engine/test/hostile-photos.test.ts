// Hostile photos from the second parser review. Each one once let a private detail survive a clean that said
// "verified", changed the picture while claiming it was untouched, or crashed the cleaner.
// The rule every case checks: never report a file clean while the secret is still in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clean } from "../src/clean.ts";
import { inspect } from "../src/inspect.ts";
import { PRESETS } from "../src/presets.ts";

const enc = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const cat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p.map(x => Buffer.from(x))));
const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return new Uint8Array(b); };
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return new Uint8Array(b); };
const le16 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt16LE(n); return new Uint8Array(b); };
const box = (t: string, ...body: Uint8Array[]) => { const b = cat(...body); return cat(be32(b.length + 8), enc(t), b); };
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, "latin1"));
const ALL = PRESETS.everything.options;
const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url)));
const safe = (verified: boolean, left: boolean, what: string) => assert.ok(!(verified && left), `${what}: reported clean but the secret is still there`);

// little-endian single-IFD TIFF: header | 16 pixel bytes | directory | out-of-line values
type E = [number, number, number, Uint8Array];
function tiff(entries: E[]): Uint8Array {
  const pixels = new Uint8Array(16).fill(0x77), dirAt = 8 + pixels.length;
  const ents = [...entries].sort((a, b) => a[0] - b[0]);
  const dir = Buffer.alloc(2 + ents.length * 12 + 4);
  dir.writeUInt16LE(ents.length);
  let dpos = dirAt + dir.length;
  const data: Uint8Array[] = [];
  ents.forEach(([tag, type, count, v], i) => {
    const e = 2 + i * 12;
    dir.writeUInt16LE(tag, e); dir.writeUInt16LE(type, e + 2); dir.writeUInt32LE(count, e + 4);
    if (v.length <= 4) Buffer.from(v).copy(dir, e + 8); else { dir.writeUInt32LE(dpos, e + 8); data.push(v); dpos += v.length; }
  });
  return cat(enc("II"), le16(42).slice(0, 2), le32(dirAt), pixels, new Uint8Array(dir), ...data);
}
const str = (s: string) => enc(s + "\0");
const IMG: E[] = [[256, 3, 1, le16(4)], [257, 3, 1, le16(4)], [258, 3, 1, le16(8)], [259, 3, 1, le16(1)], [262, 3, 1, le16(1)],
  [273, 4, 1, le32(8)], [278, 3, 1, le16(4)], [279, 4, 1, le32(16)]];

test("TIFF: a tag stored twice has every copy removed, not just the last", () => {
  const file = tiff([...IMG, [315, 2, 9, str("Jane Doe")], [315, 2, 6, str("Other")]]);
  const r = clean(file, "a.tif", ALL);
  safe(r.verified, has(r.data, "Jane Doe"), "duplicate Artist");
  assert.equal(has(r.data, "Jane Doe"), false);
  assert.equal(r.pixelsUntouched, true);
  // keeping the Artist would keep a hidden second value the inventory never showed: not verified
  const artist = r.before.fields.find(f => f.id === "exif:0:315")!;
  const k = clean(file, "a.tif", { keepCategories: [artist.category] });
  safe(k.verified, has(k.data, "Jane Doe"), "duplicate Artist, kept");
});

test("TIFF: a directory with more than 1,000 entries is read, not skipped", () => {
  const filler: E[] = Array.from({ length: 1100 }, (_, i) => [40000 + i, 3, 1, le16(1)] as E);
  const file = tiff([...IMG, [315, 2, 9, str("Jane Doe")], ...filler]);
  const t = Date.now();
  const r = clean(file, "a.tif", ALL);
  assert.ok(Date.now() - t < 2000);
  safe(r.verified, has(r.data, "Jane Doe"), "1,100-entry directory");
  assert.equal(has(r.data, "Jane Doe"), false);
});

test("TIFF: an entry of an unknown type is reported, never verified", () => {
  const file = tiff([...IMG, [315, 2, 9, str("Jane Doe")], [40000, 99, 9, str("Jane Doe")]]);
  const r = clean(file, "a.tif", ALL);
  safe(r.verified, has(r.data, "Jane Doe"), "unknown entry type");
  assert.equal(r.verified, false);
});

test("JPEG: FF D9 inside a comment between progressive scans doesn't end the picture", () => {
  const seg = (m: number, p: Uint8Array) => cat(new Uint8Array([0xff, m, (p.length + 2) >> 8, (p.length + 2) & 255]), p);
  const sos = seg(0xda, new Uint8Array([1, 1, 0, 0, 63, 0]));
  const scan = (n: number) => cat(sos, new Uint8Array(200).map((_, i) => (i * 7 + n) & 0x7f));
  const file = cat(new Uint8Array([0xff, 0xd8]), seg(0xdb, new Uint8Array(65)), seg(0xc2, new Uint8Array([8, 0, 8, 0, 8, 1, 1, 0x11, 0])),
    seg(0xc4, new Uint8Array(20)), scan(1), seg(0xfe, cat(enc("A"), new Uint8Array([0xff, 0xd9]), enc("Jane Doe"))),
    scan(2), seg(0xfe, enc("Jane Doe")), scan(3), new Uint8Array([0xff, 0xd9]));
  const r = clean(file, "a.jpg", ALL);
  const scans = (b: Uint8Array) => { let n = 0; for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0xff && b[i + 1] === 0xda) n++; return n; };
  safe(r.verified, has(r.data, "Jane Doe"), "comment between scans");
  assert.ok(scans(r.data) === 3 || !r.verified, "scans were dropped but the file was reported clean");
  assert.ok(scans(r.data) === 3 || !r.pixelsUntouched, "scans were dropped but the picture was reported untouched");
  assert.equal(scans(r.data), 3);
  assert.equal(r.pixelsUntouched, true);
});

test("RAW without a TIFF header (CR3, RAF, other): inspect works, clean doesn't throw and isn't verified", () => {
  const exif = cat(enc("MM\0*"), be32(8), new Uint8Array([0, 1, 0x01, 0x3b, 0, 2]), be32(9), be32(26), be32(0), str("Jane Doe"));
  const cr3 = cat(box("ftyp", enc("crx "), be32(1), enc("crx isom")),
    box("moov", box("uuid", enc("\x85\xc0\xb6\x87\x82\x0f\x11\xe0\x81\x11\xf4\xce\x46\x2b\x6a\x48"), box("CMT1", exif))), box("mdat", new Uint8Array(64)));
  const raf = cat(enc("FUJIFILMCCD-RAW 0201FF383501"), new Uint8Array(72), fixture("photo_iphone.jpg"));
  const arw = cat(new Uint8Array(32).fill(1), enc("Exif\0\0"), exif);
  for (const [name, file, secret] of [["a.cr3", cr3, "Jane Doe"], ["a.raf", raf, "iPhone"], ["a.arw", arw, "Jane Doe"]] as const) {
    const inv = inspect(file, name);
    assert.equal(inv.fmt, "raw");
    assert.ok(inv.fields.length > 0, `${name}: inspect should still list the details`);
    const r = clean(file, name, ALL);
    safe(r.verified, has(r.data, secret), name);
    assert.equal(r.verified, false);
    assert.ok(r.notes.some(n => /can't clean it yet/.test(n)));
    assert.equal(r.pixelsUntouched, true);
  }
});

test("WebP: XMP inside an animation frame is removed and the frame picture kept", () => {
  const ch = (cc: string, d: Uint8Array) => cat(enc(cc), le32(d.length), d, d.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
  const src = Buffer.from(fixture("firefly.webp"));
  let pos = 12, bits: Uint8Array | null = null, cc = "";
  while (pos + 8 <= src.length) {
    const c = src.toString("latin1", pos, pos + 4), s = src.readUInt32LE(pos + 4);
    if (c === "VP8 " || c === "VP8L") { bits = new Uint8Array(src.subarray(pos + 8, pos + 8 + s)); cc = c; }
    pos += 8 + s + (s & 1);
  }
  const xmp = enc(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Jane Doe"/></rdf:RDF></x:xmpmeta>`);
  const vp8x = new Uint8Array(10); vp8x[0] = 0x02; vp8x[4] = 15; vp8x[7] = 15;
  const anmf = (extra: Uint8Array) => ch("ANMF", cat(new Uint8Array(16), ch(cc, bits!), extra));
  const build = (extra: Uint8Array) => { const body = cat(enc("WEBP"), ch("VP8X", vp8x), ch("ANIM", new Uint8Array(6)), anmf(extra)); return cat(enc("RIFF"), le32(body.length), body); };
  const r = clean(build(cat(ch("XMP ", xmp), ch("EXIF", enc("Jane Doe")))), "a.webp", ALL);
  safe(r.verified, has(r.data, "Jane Doe"), "XMP in ANMF");
  assert.equal(has(r.data, "Jane Doe"), false);
  assert.ok(Buffer.from(r.data).includes(Buffer.from(bits!)));
  assert.equal(r.pixelsUntouched, true);
  // a frame whose inner chunk runs past its end can't be checked: not verified
  const bad = clean(build(cat(enc("XMP "), le32(9999), xmp)), "a.webp", ALL);
  safe(bad.verified, has(bad.data, "Jane Doe"), "damaged ANMF");
  assert.equal(bad.verified, false);
});

test("real photos still clean as verified with the picture untouched", () => {
  for (const n of ["apple.jpg", "photo_iphone.jpg", "camera.dng", "scan.tif", "firefly.webp", "sd_generation.png", "graphic.avif", "phone.heic"]) {
    const r = clean(fixture(n), n, ALL);
    assert.equal(r.verified, true, `${n}: ${r.after.errors.join("; ")}`);
    assert.equal(r.pixelsUntouched, true, n);
  }
});
