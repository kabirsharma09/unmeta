// Hostile videos and photos from the second independent review: details hidden where the walk didn't look
// (timed GPS tracks, 'udta' inside fragments or sample tables) and an ambiguous HEIC item table. The rule every case
// checks: never report a file clean while the secret is still in it, never throw, never hang.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clean } from "../src/clean.ts";
import { PRESETS } from "../src/presets.ts";
import { boxes, heifItems } from "../src/bmff.ts";
import { type Part, bytesSource, cleanMedia } from "../src/media.ts";

const enc = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const cat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p.map(x => Buffer.from(x))));
const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return new Uint8Array(b); };
const box = (t: string, ...body: Uint8Array[]) => { const b = cat(...body); return cat(be32(b.length + 8), enc(t), b); };
const full = (t: string, ...body: Uint8Array[]) => box(t, new Uint8Array(4), ...body);
const has = (b: Uint8Array, s: Uint8Array | string) => Buffer.from(b).includes(Buffer.from(typeof s === "string" ? enc(s) : s));
const join = (src: Uint8Array, parts: Part[]) => cat(...parts.map(p => "bytes" in p ? p.bytes : src.subarray(p.from, p.to)));
const ALL = PRESETS.everything.options;
const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url)));
const safe = (verified: boolean, left: boolean, what: string) => assert.ok(!(verified && left), `${what}: reported clean but the secret is still there`);

async function media(file: Uint8Array, name: string) {
  const t = Date.now();
  const r = await cleanMedia(bytesSource(file), name, ALL);
  assert.ok(Date.now() - t < 5000, "took too long");
  return { r, out: join(file, r.parts) };
}

const FTYP = box("ftyp", enc("mp42"), be32(0), enc("mp42isom"));
const MVHD = full("mvhd", new Uint8Array(96));
const GPS = box("\xa9xyz", new Uint8Array([0, 18, 0x15, 0xc7]), enc("+51.5074-000.1278/"));
const hdlr = (h: string) => full("hdlr", be32(0), enc(h), new Uint8Array(12), enc("\0"));
const metaTrak = (entry: Uint8Array, handler = "meta") => box("trak", full("tkhd", new Uint8Array(80)),
  box("mdia", full("mdhd", new Uint8Array(20)), hdlr(handler), box("minf", full("nmhd"), box("stbl", full("stsd", be32(1), entry)))));
const mebx = (...keys: string[]) => box("mebx", new Uint8Array(8),
  box("keys", ...keys.map((k, i) => box(String.fromCharCode(0, 0, 0, i + 1), box("keyd", enc("mdta"), enc(k))))));

// ---------------------------------------------------------------- 1. timed GPS tracks
test("MP4: a GoPro GPMF GPS track is reported as a location that can't be removed, never clean", async () => {
  const gps5 = cat(enc("GPS5"), new Uint8Array([0x6c, 20, 0, 1]), be32(515074000), be32(-1278000), be32(35000), be32(0), be32(0));
  const file = cat(FTYP, box("mdat", new Uint8Array(64), gps5), box("moov", MVHD, metaTrak(box("gpmd", new Uint8Array(8)))));
  const { r, out } = await media(file, "GOPR0001.MP4");
  safe(r.verified, has(out, gps5), "GPMF track");
  assert.equal(r.verified, false);
  const f = r.before.fields.find(x => x.category === "location");
  assert.ok(f && f.risk === "high" && !f.keepable && /GPS track/.test(f.note), "a plain GPS-track finding");
  assert.equal(r.pixelsUntouched, true);
  assert.ok(has(out, gps5), "the sample data itself is never rewritten");
});

test("MP4: other timed-metadata tracks (camm, mebx with a location key, mett, unknown 'meta' handler) block 'verified'", async () => {
  for (const entry of [box("camm", new Uint8Array(8)), mebx("com.apple.quicktime.location.iso6709"), box("mett", new Uint8Array(8), enc("text/plain\0")), box("abcd", new Uint8Array(8))]) {
    const { r } = await media(cat(FTYP, box("moov", MVHD, metaTrak(entry)), box("mdat", new Uint8Array(32))), "a.mov");
    assert.equal(r.verified, false, `sample entry ${Buffer.from(entry.subarray(4, 8)).toString("latin1")}`);
  }
});

test("MP4: an Apple Live Photo timing track (mebx still-image-time) is not a finding", async () => {
  const { r } = await media(cat(FTYP, box("moov", MVHD, metaTrak(mebx("com.apple.quicktime.still-image-time"))), box("mdat", new Uint8Array(32))), "IMG.MOV");
  assert.equal(r.before.fields.length, 0);
  assert.equal(r.verified, true);
});

// ---------------------------------------------------------------- 2. udta / meta in fragments and sample tables
test("MP4: 'udta' inside a fragment (moof/traf) is removed", async () => {
  const file = cat(FTYP, box("moov", MVHD), box("moof", full("mfhd", be32(1)), box("traf", full("tfhd", be32(1)), box("udta", GPS))), box("mdat", new Uint8Array(32)));
  const { r, out } = await media(file, "a.mp4");
  safe(r.verified, has(out, "+51.5074"), "udta in traf");
  assert.equal(has(out, "+51.5074"), false);
  assert.equal(out.length, file.length);
});

test("MP4: 'udta' and 'meta' inside a sample table (stbl) are removed", async () => {
  const ilstMeta = box("meta", be32(0), full("hdlr", be32(0), enc("mdir"), new Uint8Array(12)),
    box("ilst", box("\xa9ART", box("data", be32(1), be32(0), enc("Sam Secret")))));
  const file = cat(FTYP, box("moov", MVHD, box("trak", full("tkhd", new Uint8Array(80)), box("mdia", box("minf", box("stbl", box("udta", GPS), ilstMeta))))), box("mdat", new Uint8Array(32)));
  const { r, out } = await media(file, "a.mov");
  safe(r.verified, has(out, "+51.5074") || has(out, "Sam Secret"), "udta/meta in stbl");
  assert.equal(has(out, "+51.5074"), false);
  assert.equal(has(out, "Sam Secret"), false);
});

test("MP4: a 'udta' hidden where the walk doesn't go (inside a sample entry) is an error, not clean", async () => {
  const entry = box("avc1", new Uint8Array(78), box("udta", GPS));
  const file = cat(FTYP, box("moov", MVHD, box("trak", box("mdia", hdlr("vide"), box("minf", box("stbl", full("stsd", be32(1), entry)))))), box("mdat", new Uint8Array(32)));
  const { r, out } = await media(file, "a.mp4");
  safe(r.verified, has(out, "+51.5074"), "udta in sample entry");
  assert.equal(r.verified, false);
});

test("MP4: deep nesting through sample tables and fragments still stops at the depth cap, quickly", async () => {
  let inner = box("udta", GPS);
  for (let i = 0; i < 2000; i++) inner = box(i % 2 ? "stbl" : "traf", inner);
  const file = cat(FTYP, box("moov", MVHD), box("moof", inner), box("mdat", new Uint8Array(32)));
  const { r, out } = await media(file, "a.mp4");
  safe(r.verified, has(out, "+51.5074"), "deep nesting");
  assert.equal(r.verified, false);
});

// ---------------------------------------------------------------- 3. ambiguous HEIC item table
function withDecoyIloc(): Uint8Array {
  const d0 = Buffer.from(fixture("phone.heic"));
  const meta = [...boxes(d0, 0, d0.length)].find(b => b.type === "meta")!;
  const iloc = [...boxes(d0, meta.body + 4, meta.end)].find(b => b.type === "iloc")!;
  const exifId = heifItems(d0).find(i => i.type === "Exif")!.id;
  const decoy = Buffer.alloc(18); decoy.writeUInt16BE(exifId, 0); decoy.writeUInt16BE(1, 8);   // same id, one zero-length extent
  const add = decoy.length;
  const d = Buffer.concat([d0.subarray(0, iloc.end), decoy, d0.subarray(iloc.end)]);
  d.writeUInt32BE(iloc.end - iloc.start + add, iloc.start);
  d.writeUInt32BE(meta.end - meta.start + add, meta.start);
  let p = iloc.body + 6; const count = d.readUInt16BE(p); d.writeUInt16BE(count + 1, p); p += 2;
  for (let i = 0; i < count; i++) { p += 4; d.writeUInt32BE(d.readUInt32BE(p) + add, p); p += 4; const n = d.readUInt16BE(p); p += 2 + n * 8; }
  return new Uint8Array(d);
}

test("HEIC: an item listed twice in iloc (zero-length decoy) is an error, never clean", () => {
  const file = withDecoyIloc();
  const exif = heifItems(fixture("phone.heic")).find(i => i.type === "Exif")!;
  const r = clean(file, "a.heic", ALL);
  assert.equal(r.verified, false);
  assert.ok(r.before.errors.some(e => /same item more than once/.test(e)));
  // the real Exif bytes were not guessed at: nothing claimed clean, picture untouched
  assert.ok(exif.extents.length > 0);
  assert.equal(r.pixelsUntouched, true);
});

test("HEIC: an item id declared twice in iinf is an error", () => {
  const d0 = Buffer.from(fixture("phone.heic"));
  const meta = [...boxes(d0, 0, d0.length)].find(b => b.type === "meta")!;
  const iinf = [...boxes(d0, meta.body + 4, meta.end)].find(b => b.type === "iinf")!;
  const infes = [...boxes(d0, iinf.body + 4 + (d0[iinf.body] === 0 ? 2 : 4), iinf.end)].filter(b => b.type === "infe");
  // turn the second infe into a copy of the first one's id
  const a = infes[0], b = infes[1];
  const idSize = d0[a.body] === 2 ? 2 : 4;
  const d = Buffer.from(d0);
  d.set(d0.subarray(a.body + 4, a.body + 4 + idSize), b.body + 4);
  const r = clean(new Uint8Array(d), "a.heic", ALL);
  assert.equal(r.verified, false);
});

test("HEIC: a huge iloc item count doesn't hang", () => {
  const d0 = Buffer.from(fixture("phone.heic"));
  const meta = [...boxes(d0, 0, d0.length)].find(b => b.type === "meta")!;
  const iloc = [...boxes(d0, meta.body + 4, meta.end)].find(b => b.type === "iloc")!;
  const d = Buffer.from(d0);
  d[iloc.body] = 2; d.writeUInt32BE(0xffffffff, iloc.body + 6);
  const t = Date.now();
  clean(new Uint8Array(d), "a.heic", ALL);
  assert.ok(Date.now() - t < 2000);
});

// ---------------------------------------------------------------- normal files stay clean
test("regression: genuine Apple videos and phone photos are still verified clean", async () => {
  for (const n of ["apple.mov", "apple.mp4"]) {
    const { r } = await media(fixture(n), n);
    assert.equal(r.verified, true, n);
    assert.deepEqual(r.before.errors, [], n);
  }
  for (const n of ["apple.heic", "phone.heic"]) {
    const r = clean(fixture(n), n, ALL);
    assert.equal(r.verified, true, n);
    assert.equal(r.pixelsUntouched, true, n);
  }
});
