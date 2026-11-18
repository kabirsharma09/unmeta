// Hostile photos from the third parser review: TIFF/RAW parts the cleaner never read (Photoshop private tags, later
// directories, SubIFDs, embedded JPEG previews, GPS reached through the Exif IFD, odd tags in the Interop IFD) and a
// tag value that shares its bytes with the main picture. The rule: never report a file clean while the secret is
// still in it, and never claim the picture is untouched when it isn't.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clean } from "../src/clean.ts";
import { PRESETS } from "../src/presets.ts";

const ALL = PRESETS.everything.options;
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, "latin1"));
const safe = (verified: boolean, left: boolean, what: string) => assert.ok(!(verified && left), `${what}: reported clean but the secret is still there`);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt16LE(n); return b; };
const str = (s: string) => Buffer.from(s + "\0", "latin1");

// little-endian TIFF: header | 16 pixel bytes | extra bytes | directories laid out one after another.
// Entries whose value is the string "@n" are patched to point at directory n.
type E = [number, number, number, Buffer | string];
function build(ifds: E[][], chain: boolean[] = [], extra = Buffer.alloc(0)) {
  const pixels = Buffer.alloc(16, 0x77);
  let pos = 8 + pixels.length + extra.length;
  const offs: number[] = [], dirs: Buffer[] = [], patches: [number, number, number][] = [];
  for (const ents of ifds) {
    offs.push(pos);
    const sorted = [...ents].sort((a, b) => a[0] - b[0]);
    const size = 2 + sorted.length * 12 + 4;
    let dp = pos + size;
    const dir = Buffer.alloc(size); dir.writeUInt16LE(sorted.length);
    const data: Buffer[] = [];
    sorted.forEach(([t, ty, c, v], i) => {
      const e = 2 + i * 12;
      dir.writeUInt16LE(t, e); dir.writeUInt16LE(ty, e + 2); dir.writeUInt32LE(c, e + 4);
      if (typeof v === "string") patches.push([dirs.length, e + 8, +v.slice(1)]);
      else if (v.length <= 4) v.copy(dir, e + 8);
      else { dir.writeUInt32LE(dp, e + 8); data.push(v); dp += v.length; }
    });
    dirs.push(Buffer.concat([dir, ...data])); pos = dp;
  }
  for (const [d, at, target] of patches) dirs[d].writeUInt32LE(offs[target], at);
  dirs.forEach((d, i) => { if (chain[i]) d.writeUInt32LE(offs[i + 1], 2 + d.readUInt16LE(0) * 12); });
  const hdr = Buffer.alloc(8); hdr.write("II"); hdr.writeUInt16LE(42, 2); hdr.writeUInt32LE(offs[0], 4);
  return new Uint8Array(Buffer.concat([hdr, pixels, extra, ...dirs]));
}
const IMG: E[] = [[256, 3, 1, u16(4)], [257, 3, 1, u16(4)], [258, 3, 1, u16(8)], [259, 3, 1, u16(1)], [262, 3, 1, u16(1)],
  [273, 4, 1, u32(8)], [278, 3, 1, u16(4)], [279, 4, 1, u32(16)]];

function check(name: string, file: Uint8Array, secret: string, filename = "a.tif") {
  const t = Date.now();
  const r = clean(file, filename, ALL);
  assert.ok(Date.now() - t < 2000, `${name}: too slow`);
  safe(r.verified, has(r.data, secret), name);
  assert.equal(r.pixelsUntouched, true, name);
  assert.ok(Buffer.from(r.data).subarray(8, 24).equals(Buffer.alloc(16, 0x77)), `${name}: picture changed`);
  return r;
}

test("Photoshop / Camera Raw private tags (OwnerName 0xFDE8, SerialNumber 0xFDE9, Lens 0xFDEA) are private, not structural", () => {
  for (const fn of ["a.tif", "a.dng"]) {
    const file = build([[...IMG, [0xfde8, 2, 9, str("Jane Doe")], [0xfde9, 2, 11, str("SN12345678")], [0xfdea, 2, 9, str("LensXYZ1")]]]);
    const r = check(`private tags in ${fn}`, file, "Jane Doe", fn);
    const f = (t: number) => r.before.fields.find(x => x.id === `exif:0:${t}`)!;
    assert.deepEqual([f(65000).category, f(65000).risk], ["personal", "high"]);
    assert.deepEqual([f(65001).category, f(65001).risk], ["device", "high"]);
    assert.equal(f(65002).category, "device");
    for (const s of ["Jane Doe", "SN12345678", "LensXYZ1"]) assert.equal(has(r.data, s), false, `${fn}: ${s} left`);
    assert.equal(r.verified, true);
  }
});

test("every part of the TIFF directory graph is read: Interop, later IFDs, SubIFDs, GPS via Exif, JPEG previews", () => {
  // Artist hidden in the Interop IFD
  check("Interop IFD", build([[...IMG, [0x8769, 4, 1, "@1"]], [[0xa005, 4, 1, "@2"]], [[1, 2, 4, str("R98")], [315, 2, 9, str("Jane Doe")]]]), "Jane Doe");
  // IFD1 whose only entry points past the end of the file, IFD2 with an Artist
  check("IFD2 behind an empty-looking IFD1", build([IMG, [[256, 3, 5000, u32(0x7fffff00)]], [...IMG, [315, 2, 9, str("Jane Doe")]]], [true, true]), "Jane Doe");
  // a SubIFD with an Artist
  const sub = check("SubIFD", build([[...IMG, [0x14a, 4, 1, "@1"]], [...IMG, [315, 2, 9, str("Jane Doe")]]]), "Jane Doe");
  assert.equal(has(sub.data, "Jane Doe"), false);
  // a GPS IFD reached only through the Exif IFD's GPS pointer
  const gps = check("GPS via Exif IFD", build([[...IMG, [0x8769, 4, 1, "@1"]], [[0x8825, 4, 1, "@2"]],
    [[0, 1, 4, Buffer.from([2, 3, 0, 0])], [27, 7, 19, Buffer.from("ASCII\0\0\0Home Street", "latin1")]]]), "Home Street");
  assert.equal(has(gps.data, "Home Street"), false);
  // an embedded JPEG preview (0x201/0x202) whose own EXIF names the author
  const ex = Buffer.concat([Buffer.from("Exif\0\0II*\0\x08\0\0\0", "latin1"), Buffer.from([1, 0, 0x3b, 1, 2, 0, 9, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0]), str("Jane Doe")]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (ex.length + 2) >> 8, (ex.length + 2) & 255]), ex]);
  const scan = Buffer.concat([Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]), Buffer.alloc(32, 0x42), Buffer.from([0xff, 0xd9])]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xdb, 0, 67]), Buffer.alloc(65, 1),
    Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0]), scan]);
  const pv = check("JPEG preview", build([[...IMG, [0x201, 4, 1, u32(24)], [0x202, 4, 1, u32(jpg.length)]]], [], jpg), "Jane Doe");
  assert.ok(pv.before.fields.some(f => f.id.startsWith("preview:0:exif:0:315")), "the preview's Artist is listed");
  assert.equal(has(pv.data, "Jane Doe"), false);
  assert.ok(Buffer.from(pv.data).includes(scan), "the preview's picture data is unchanged");
  // a preview that isn't a JPEG can't be checked: never verified
  const bad = check("non-JPEG preview", build([[...IMG, [0x201, 4, 1, u32(24)], [0x202, 4, 1, u32(12)]]], [], Buffer.from("Jane Doe....", "latin1")), "Jane Doe");
  assert.equal(bad.verified, false);
});

test("a tag value that shares bytes with a SubIFD's main picture is never blanked; the picture stays identical", () => {
  // header | IFD0 strip (16 B @8, 0x77) | main raw strip (64 B @24, 0x55) | IFD0 | SubIFD.
  // IFD0's Artist points into the SubIFD's main-picture strip.
  const b = Buffer.alloc(400); b.write("II"); b.writeUInt16LE(42, 2);
  b.fill(0x77, 8, 24); b.fill(0x55, 24, 88);
  const ifd = (off: number, ents: [number, number, number, number][]) => {
    b.writeUInt16LE(ents.length, off);
    ents.sort((x, y) => x[0] - y[0]).forEach(([t, ty, c, v], i) => {
      const e = off + 2 + i * 12; b.writeUInt16LE(t, e); b.writeUInt16LE(ty, e + 2); b.writeUInt32LE(c, e + 4); b.writeUInt32LE(v, e + 8);
    });
  };
  b.writeUInt32LE(96, 4);
  ifd(96, [[254, 4, 1, 1], [256, 3, 1, 4], [257, 3, 1, 4], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 8], [278, 3, 1, 4],
    [279, 4, 1, 16], [315, 2, 16, 32], [0x14a, 4, 1, 250]]);
  ifd(250, [[254, 4, 1, 0], [256, 3, 1, 8], [257, 3, 1, 8], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 24], [278, 3, 1, 8], [279, 4, 1, 64]]);
  const file = new Uint8Array(b);
  for (const fn of ["a.dng", "a.tif"]) {
    const r = clean(file, fn, ALL);
    const changed = !Buffer.from(file.subarray(24, 88)).equals(Buffer.from(r.data.subarray(24, 88)));
    assert.ok(!changed || !r.pixelsUntouched, `${fn}: the main picture changed but was reported untouched`);
    assert.ok(!changed || !r.verified, `${fn}: the main picture changed but the clean was verified`);
    assert.equal(changed, false, `${fn}: the main picture must not change`);
    assert.equal(r.verified, false, `${fn}: the Artist couldn't be removed, so the clean can't be verified`);
  }
});

test("TIFF: millions of picture strips can't exhaust memory (a 32 MB file stays small and is not verified)", () => {
  const N = 4_000_000, b = Buffer.alloc(8 + 2 + 3 * 12 + 4 + N * 8);
  b.write("II*\0", 0, "latin1"); b.writeUInt32LE(8, 4); b.writeUInt16LE(3, 8);
  const ent = (i: number, tag: number, type: number, count: number, val: number) => {
    const o = 10 + i * 12; b.writeUInt16LE(tag, o); b.writeUInt16LE(type, o + 2); b.writeUInt32LE(count, o + 4); b.writeUInt32LE(val, o + 8);
  };
  const offs = 50, lens = offs + N * 4;
  ent(0, 256, 4, 1, 64); ent(1, 273, 4, N, offs); ent(2, 279, 4, N, lens);
  for (let i = 0; i < N; i++) { b.writeUInt32LE(8, offs + i * 4); b.writeUInt32LE(1, lens + i * 4); }
  const m0 = process.memoryUsage().rss, t = Date.now();
  const r = clean(new Uint8Array(b), "x.tif", PRESETS.everything.options);
  assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
  assert.ok(process.memoryUsage().rss - m0 < 400e6, "memory stayed bounded");
  assert.equal(r.verified, false);
});
