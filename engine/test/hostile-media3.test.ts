// Hostile videos and recordings from the fourth review: quadratic clean time, WAV metadata hidden after a broken
// chunk, unknown WAV chunks, cover pictures with their own GPS, ID3 chapters, dashcam GPS logs and a second ID3 tag
// in the middle of the audio. Never report clean with the secret inside, never change the samples, never hang.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS } from "../src/presets.ts";
import { type Part, bytesSource, cleanMedia } from "../src/media.ts";

const enc = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const cat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p.map(x => Buffer.from(x))));
const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return new Uint8Array(b); };
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return new Uint8Array(b); };
const be16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return new Uint8Array(b); };
const box = (t: string, ...body: Uint8Array[]) => { const b = cat(...body); return cat(be32(b.length + 8), enc(t), b); };
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(enc(s)));
const join = (src: Uint8Array, parts: Part[]) => cat(...parts.map(p => "bytes" in p ? p.bytes : src.subarray(p.from, p.to)));
const ALL = PRESETS.everything.options, LOC = PRESETS.location.options;
const media = async (f: Uint8Array, name: string, o = ALL) => { const r = await cleanMedia(bytesSource(f), name, o); return { r, out: join(f, r.parts) }; };
/** The promise: either the secret is gone, or the file is not called clean. */
const safe = (r: { verified: boolean }, out: Uint8Array, secret: string) => assert.ok(!r.verified || !has(out, secret), `"${secret}" left in a verified file`);

// WAV
const ck = (id: string, body: Uint8Array, pad = true) => cat(enc(id), le32(body.length), body, pad && body.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
const FMT = ck("fmt ", cat(new Uint8Array([1, 0, 1, 0]), le32(8000), le32(8000), new Uint8Array([1, 0, 8, 0])));
const INFO = ck("LIST", cat(enc("INFO"), ck("IART", enc("Jane Doe\0")), ck("ICMT", enc("recorded at 221B Baker St\0"))));
const riff = (...c: Uint8Array[]) => { const b = cat(enc("WAVE"), ...c); return cat(enc("RIFF"), le32(b.length), b); };
const SAMPLES = new Uint8Array(101).map((_, i) => (i * 37) & 0xff);

// MP3
const ss = (n: number) => new Uint8Array([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const frame = (id: string, body: Uint8Array) => cat(enc(id), be32(body.length), new Uint8Array(2), body);
const tag = (...fr: Uint8Array[]) => { const t = cat(...fr); return cat(enc("ID3\x03\x00\x00"), ss(t.length), t); };
const AUDIO = cat(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), new Uint8Array(413).fill(0x55));

// a baseline JPEG whose EXIF holds an artist and a GPS position
function gpsJpeg() {
  const ent = (t: number, type: number, n: number, v: Uint8Array) => cat(be16(t), be16(type), be32(n), v);
  const art = enc("Jane Doe\0\0"), gpsOff = 8 + 2 + 24 + 4 + art.length, latOff = gpsOff + 2 + 48 + 4, lonOff = latOff + 24;
  const r = (a: number, b: number) => cat(be32(a), be32(b));
  const tiff = cat(enc("MM\0*"), be32(8), be16(2), ent(315, 2, 9, be32(8 + 2 + 24 + 4)), ent(0x8825, 4, 1, be32(gpsOff)), be32(0), art,
    be16(4), ent(1, 2, 2, enc("N\0\0\0")), ent(2, 5, 3, be32(latOff)), ent(3, 2, 2, enc("W\0\0\0")), ent(4, 5, 3, be32(lonOff)), be32(0),
    r(51, 1), r(30, 1), r(2664, 100), r(0, 1), r(7, 1), r(4008, 100));
  const seg = (m: number, p: Uint8Array) => cat(new Uint8Array([0xff, m]), be16(p.length + 2), p);
  return cat(enc("\xff\xd8"), seg(0xe1, cat(enc("Exif\0\0"), tiff)), seg(0xdb, new Uint8Array(65).fill(1)),
    seg(0xc0, new Uint8Array([8, 0, 1, 0, 1, 1, 1, 0x11, 0])), seg(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])), new Uint8Array([0x12, 0x34]), enc("\xff\xd9"));
}

test("1. many tiny chunks or boxes: clean and re-check stay fast", async () => {
  const N = 100_000;
  const body = new Uint8Array(4 + N * 8);
  body.set(enc("WAVE"));
  for (let i = 0; i < N; i++) body.set(enc("JUNK"), 4 + i * 8);
  const wav = cat(enc("RIFF"), le32(body.length), body);
  let t = Date.now();
  const w = await cleanMedia(bytesSource(wav), "a.wav", ALL);
  assert.ok(Date.now() - t < 3000, `WAV took ${Date.now() - t} ms`);
  assert.equal(w.parts.length, 2);   // neighbouring untouched chunks are joined
  // past the block budget: not called clean, and still fast
  const big = new Uint8Array(4 + 3 * N * 8);
  big.set(enc("WAVE"));
  for (let i = 0; i < 3 * N; i++) big.set(enc("JUNK"), 4 + i * 8);
  t = Date.now();
  const w2 = await cleanMedia(bytesSource(cat(enc("RIFF"), le32(big.length), big)), "b.wav", ALL);
  assert.ok(Date.now() - t < 3000 && !w2.verified);
  const u = box("udta", box("\xa9nam", be32(0x00045500), enc("Jane")));
  const mp4 = cat(box("ftyp", enc("isom"), be32(0), enc("isom")), ...Array.from({ length: N }, () => u), box("moov", box("mvhd", new Uint8Array(100))));
  t = Date.now();
  const { r, out } = await media(mp4, "a.mp4");
  assert.ok(Date.now() - t < 3000, `MP4 took ${Date.now() - t} ms`);
  safe(r, out, "Jane");
});

test("2. WAV: metadata after a 0xFFFFFFFF data chunk or an unpadded odd chunk is found and removed", async () => {
  const streaming = riff(FMT, cat(enc("data"), le32(0xffffffff), SAMPLES), INFO);
  const unpadded = riff(FMT, ck("data", SAMPLES, false), INFO);
  for (const f of [streaming, unpadded]) {
    const { r, out } = await media(f, "a.wav");
    assert.ok(r.before.fields.some(x => x.id === "wav:info:IART"));
    for (const s of ["Jane Doe", "Baker St"]) assert.ok(!has(out, s));
    assert.ok(Buffer.from(out).includes(Buffer.from(SAMPLES)));   // samples untouched
  }
  // a block other than 'data' that runs past the end can't be checked: kept, but never called clean
  const over = riff(FMT, ck("data", SAMPLES), cat(enc("bext"), le32(5000), enc("Jane Doe")));
  const { r } = await media(over, "a.wav");
  assert.equal(r.verified, false);
  // garbage after the last chunk is not silently ignored; zero padding is fine
  assert.equal((await media(cat(riff(FMT, ck("data", SAMPLES)), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), "a.wav")).r.verified, false);
  assert.equal((await media(cat(riff(FMT, ck("data", SAMPLES)), new Uint8Array(16)), "a.wav")).r.verified, true);
  // a properly padded odd chunk followed by metadata still reads normally
  const padded = await media(riff(FMT, ck("data", SAMPLES), INFO), "a.wav");
  assert.ok(padded.r.verified && !has(padded.out, "Jane Doe"));
});

test("3. WAV: unknown chunks are reported and removed; playback chunks and zero padding stay", async () => {
  const f = riff(FMT, ck("afsp", enc("AFsp\0user: jdoe\0host: janes-macbook\0")), ck("DISP", cat(le32(1), enc("Jane Doe interview\0"))),
    ck("olym", enc("SN-998877")), ck("JUNK", enc("hidden owner jdoe")), ck("FLLR", new Uint8Array(32)), ck("data", SAMPLES), ck("cue ", le32(0)));
  const { r, out } = await media(f, "a.wav", LOC);
  for (const s of ["jdoe", "Jane Doe", "SN-998877", "janes-macbook"]) assert.ok(!has(out, s), s);
  for (const id of ["wav:chunk:afsp", "wav:chunk:DISP", "wav:chunk:olym", "wav:chunk:JUNK"]) assert.ok(r.before.fields.some(x => x.id === id), id);
  assert.ok(r.verified);
  for (const keep of ["fmt ", "data", "cue ", "FLLR"]) assert.ok(has(out, keep), keep);
  assert.ok(Buffer.from(out).includes(Buffer.from(SAMPLES)));
});

test("4. cover pictures: their own GPS makes them go under 'everything except location'; 'nothing private' always removes them", async () => {
  const photo = gpsJpeg();
  const m4a = cat(box("ftyp", enc("M4A "), be32(0), enc("M4A ")), box("moov", box("mvhd", new Uint8Array(100)),
    box("udta", box("meta", be32(0), box("hdlr", be32(0), be32(0), enc("mdir"), new Uint8Array(12)), box("ilst", box("covr", box("data", be32(13), be32(0), photo)))))),
  box("mdat", new Uint8Array(32)));
  const mp3 = cat(tag(frame("APIC", cat(new Uint8Array([0]), enc("image/jpeg\0"), new Uint8Array([3]), enc("\0"), photo))), AUDIO);
  for (const [f, name] of [[m4a, "a.m4a"], [mp3, "a.mp3"]] as const) {
    for (const o of [LOC, ALL]) {
      const { r, out } = await media(f, name, o);
      assert.ok(r.before.fields.some(x => x.category === "location"), name);
      assert.ok(!has(out, "Jane Doe") && !has(out, "N\0\0\0"), `${name} cover kept`);
      assert.ok(r.verified);
    }
  }
  // a cover with nothing inside survives the location preset, and still goes with 'nothing private'
  const bare = gpsJpeg();
  const exifLen = (bare[4] << 8) | bare[5];
  const clean = cat(bare.subarray(0, 2), bare.subarray(4 + exifLen));
  const plain = cat(tag(frame("APIC", cat(new Uint8Array([0]), enc("image/jpeg\0"), new Uint8Array([3]), enc("\0"), clean))), AUDIO);
  const kept = await media(plain, "b.mp3", LOC), gone = await media(plain, "b.mp3", ALL);
  assert.ok(has(kept.out, "APIC") && kept.r.verified);
  assert.ok(!has(gone.out, "APIC") && gone.r.verified);
});

test("5. ID3 chapters: a location inside a CHAP frame is found, and the chapter goes with it", async () => {
  const txxx = (v: string) => frame("TXXX", cat(new Uint8Array([0]), enc("GPS\0"), enc(v)));
  const chap = frame("CHAP", cat(enc("ch1\0"), be32(0), be32(1000), be32(0xffffffff), be32(0xffffffff), txxx("51.5074,-0.1278"), frame("TIT2", enc("\0Intro"))));
  const ctoc = frame("CTOC", cat(enc("toc\0"), new Uint8Array([3, 1]), enc("ch1\0"), txxx("48.8566,2.3522")));
  const f = cat(tag(chap, ctoc, frame("TPE1", enc("\0Jane Doe"))), AUDIO);
  const { r, out } = await media(f, "a.mp3", LOC);
  assert.ok(r.before.fields.some(x => x.id === "id3:CHAP:0:TXXX:0" && x.category === "location"));
  assert.ok(!has(out, "51.5074") && !has(out, "48.8566"));
  assert.ok(has(out, "Jane Doe"));   // the location preset keeps the artist
  assert.ok(r.verified);
  // chapters without anything private survive
  const plain = cat(tag(frame("CHAP", cat(enc("ch1\0"), be32(0), be32(1000), be32(0xffffffff), be32(0xffffffff), frame("TIT2", enc("\0Intro"))))), AUDIO);
  const p = await media(plain, "b.mp3", LOC);
  assert.ok(has(p.out, "CHAP") && p.r.verified);
});

test("6. dashcam GPS ('gps ' index in moov, freeGPS blocks) is reported and never called clean", async () => {
  const ftyp = box("ftyp", enc("isom"), be32(0), enc("isom"));
  const gpsBlock = cat(be32(64), enc("freeGPS "), enc("A5130.4440N00007.6680W 2026/11/18"), new Uint8Array(23));
  const trak = box("trak", box("tkhd", new Uint8Array(84)), box("mdia", box("hdlr", be32(0), be32(0), enc("vide"), new Uint8Array(13))));
  const f = cat(ftyp, box("moov", box("mvhd", new Uint8Array(100)), trak, box("gps ", be32(0x101), be32(1), be32(0), be32(64))), box("mdat", new Uint8Array(16), gpsBlock));
  const { r, out } = await media(f, "dashcam.mp4");
  assert.ok(r.before.fields.some(x => x.category === "location"));
  safe(r, out, "5130.4440N");
  assert.equal(r.verified, false);
  // a top-level freeGPS block too
  const g = cat(ftyp, box("moov", box("mvhd", new Uint8Array(100))), box("free", enc("GPS "), enc("5130.4440N")), box("mdat", new Uint8Array(8)));
  assert.equal((await media(g, "b.mp4")).r.verified, false);
  // an unknown moov child with text is reported and removed
  const v = cat(ftyp, box("moov", box("mvhd", new Uint8Array(100)), box("xyzw", enc("owner: Jane Doe"))), box("mdat", new Uint8Array(8)));
  const x = await media(v, "c.mp4");
  assert.ok(x.r.before.fields.some(f => f.id === "mp4:movie:box:xyzw") && !has(x.out, "Jane Doe"));
});

test("7. MP3: a second ID3v2 tag between audio frames is found and cut out; the audio stays", async () => {
  const f = cat(tag(frame("TIT2", enc("\0Song"))), AUDIO, tag(frame("TPE1", enc("\0Jane Doe"))), AUDIO);
  const { r, out } = await media(f, "a.mp3");
  assert.ok(r.before.fields.some(x => x.value === "Jane Doe"));
  assert.ok(!has(out, "Jane Doe") && r.verified);
  assert.deepEqual(out, cat(AUDIO, AUDIO));
  // a tag that isn't followed by an audio frame can't be cut out safely: not called clean
  const g = cat(tag(frame("TIT2", enc("\0Song"))), AUDIO, tag(frame("TPE1", enc("\0Jane Doe"))), new Uint8Array(50).fill(0x11));
  const m = await media(g, "b.mp3");
  safe(m.r, m.out, "Jane Doe");
  assert.equal(m.r.verified, false);
  // "ID3" in the samples without a real tag structure is not a tag
  const h = cat(AUDIO, enc("ID3\x09\x00\x00zzzz"), AUDIO);
  const n = await media(h, "c.mp3");
  assert.ok(n.r.verified && n.out.length === h.length);
});
