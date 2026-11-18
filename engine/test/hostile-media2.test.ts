// Hostile videos from the third review: oversized metadata boxes (memory), a compressed QuickTime movie header,
// and a timed-metadata track hidden behind a second handler. Never report clean with the secret inside, never throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { PRESETS } from "../src/presets.ts";
import { type Part, type Source, bytesSource, cleanMedia } from "../src/media.ts";

const enc = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const cat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p.map(x => Buffer.from(x))));
const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return new Uint8Array(b); };
const box = (t: string, ...body: Uint8Array[]) => { const b = cat(...body); return cat(be32(b.length + 8), enc(t), b); };
const full = (t: string, ...body: Uint8Array[]) => box(t, new Uint8Array(4), ...body);
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(enc(s)));
const join = (src: Uint8Array, parts: Part[]) => cat(...parts.map(p => "bytes" in p ? p.bytes : src.subarray(p.from, p.to)));
const ALL = PRESETS.everything.options;

const FTYP = box("ftyp", enc("qt  "), be32(0), enc("qt  "));
const MVHD = full("mvhd", new Uint8Array(96));
const GPS = box("\xa9xyz", new Uint8Array([0, 18, 0x15, 0xc7]), enc("+51.5074-000.1278/"));
const hdlr = (h: string) => full("hdlr", be32(0), enc(h), new Uint8Array(12), enc("\0"));

test("MP4: many huge top-level metadata boxes are refused without reading them, not held in memory", async () => {
  // virtual 2 GB file: ftyp + 8 × 250 MB 'uuid' boxes + empty moov; bytes are made up on read
  const N = 8, BOX = 250 * 1024 * 1024, ftyp = Buffer.from(FTYP), moov = Buffer.from(box("moov"));
  const size = ftyp.length + N * BOX + moov.length;
  let readBytes = 0;
  const src: Source = { size, read: async (o, n) => {
    n = Math.max(0, Math.min(n, size - o)); readBytes += n;
    const b = Buffer.alloc(n);
    for (let p = o; p < o + n; p++) {
      if (p < ftyp.length) { b[p - o] = ftyp[p]; continue; }
      const q = p - ftyp.length;
      if (q >= N * BOX) { b[p - o] = moov[q - N * BOX]; continue; }
      const i = q % BOX;
      if (i < 8) { const h = Buffer.alloc(8); h.writeUInt32BE(BOX); h.write("uuid", 4); b[p - o] = h[i]; }
      else p += Math.min(BOX - i, o + n - p) - 1;
    }
    return new Uint8Array(b.buffer, b.byteOffset, b.length);
  } };
  const t = Date.now();
  const r = await cleanMedia(src, "a.mp4", ALL);
  assert.ok(Date.now() - t < 5000, "took too long");
  assert.equal(r.verified, false);
  assert.ok(r.before.errors.some(e => /too large/.test(e)), JSON.stringify(r.before.errors));
  assert.ok(readBytes < 64 * 1024 * 1024, `read ${readBytes} bytes into memory`);
});

test("MP4: a compressed QuickTime movie header (cmov) is an error, never clean", async () => {
  const inner = box("moov", MVHD, box("udta", GPS));
  const cmov = box("cmov", box("dcom", enc("zlib")), box("cmvd", be32(inner.length), new Uint8Array(deflateSync(inner))));
  const file = cat(FTYP, box("moov", cmov), box("mdat", new Uint8Array(16)));
  const r = await cleanMedia(bytesSource(file), "a.mov", ALL);
  assert.equal(r.verified, false);
  assert.ok(r.before.errors.some(e => /compressed/.test(e)), JSON.stringify(r.before.errors));
});

test("MP4: a 'meta' handler after a 'vide' handler still marks a timed-metadata track; Live Photo mebx stays quiet", async () => {
  const trak = (entry: Uint8Array, ...handlers: string[]) => box("trak", full("tkhd", new Uint8Array(80)), box("mdia", full("mdhd", new Uint8Array(20)),
    ...handlers.map(hdlr), box("minf", full("nmhd"), hdlr("alis"), box("stbl", full("stsd", be32(1), entry)))));
  const file = cat(FTYP, box("moov", MVHD, trak(box("djmd", new Uint8Array(8)), "vide", "meta")), box("mdat", enc("GPS+51.5074")));
  const r = await cleanMedia(bytesSource(file), "a.mov", ALL);
  assert.ok(!(r.verified && has(join(file, r.parts), "+51.5074")), "reported clean with the track still there");
  assert.equal(r.verified, false);
  // two handlers alone, with an ordinary-looking entry, are not trusted either
  const r2 = await cleanMedia(bytesSource(cat(FTYP, box("moov", MVHD, trak(box("avc1", new Uint8Array(8)), "vide", "soun")))), "a.mov", ALL);
  assert.equal(r2.verified, false);
  // an iPhone Live Photo timing track is not a finding
  const mebx = box("mebx", new Uint8Array(8), box("keys", box("\0\0\0\x01", box("keyd", enc("mdta"), enc("com.apple.quicktime.still-image-time")))));
  const r3 = await cleanMedia(bytesSource(cat(FTYP, box("moov", MVHD, trak(mebx, "meta")), box("mdat", new Uint8Array(8)))), "IMG.MOV", ALL);
  assert.equal(r3.verified, true, JSON.stringify([r3.before.fields.map(f => f.id), r3.before.errors]));
});
