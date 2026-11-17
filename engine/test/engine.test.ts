// Run with: npm test  (Node's built-in test runner; fixtures + expectations come from the Python engine)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { inspect, toReport } from "../src/inspect.ts";
import { clean } from "../src/clean.ts";
import { PRESETS } from "../src/presets.ts";
import { highlights } from "../src/highlights.ts";

const dir = new URL("../src/fixtures/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8"));
const load = (n: string) => new Uint8Array(readFileSync(new URL(n, dir)));
const names = Object.keys(expected);
const NEEDLES = ["Jane Doe", "C39XK1234ABC", "Firefly", "trainedAlgorithmicMedia", "c2pa", "Midjourney", "London", "Steps: 30", "Jane's iPhone"];
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s));

for (const n of names) {
  test(`inspect ${n} matches the desktop engine`, () => {
    const inv = inspect(load(n), n);
    const exp = expected[n];
    assert.equal(inv.fmt, exp.fmt);
    assert.deepEqual(inv.errors, []);
    const ids = new Set(inv.fields.map(f => f.id));
    const pyOnly = exp.ids.filter((i: string) => !ids.has(i) && !i.startsWith("heif:"));
    if (["jpeg", "png", "webp"].includes(exp.fmt)) {
      assert.deepEqual([...ids].sort(), exp.ids, "same field ids as Python");
    } else {
      assert.deepEqual(pyOnly, [], "every Python field is found");
    }
    if (exp.gps) assert.deepEqual(inv.gps, exp.gps);
    assert.ok(inv.aiSignals.some(s => s.verdict === "AI-generated"));
  });

  test(`clean ${n}: nothing private left, picture untouched`, () => {
    const data = load(n);
    const r = clean(data, n, PRESETS.everything.options);
    assert.ok(r.verified, JSON.stringify(r.residual.map(f => f.id)));
    assert.ok(r.pixelsUntouched, "compressed picture data must be identical");
    for (const s of NEEDLES) assert.ok(!has(r.data, s), `${n} still contains ${s}`);
    assert.equal(r.after.gps, null);
    assert.equal(r.after.aiSignals.length, 0);
    mkdirSync("/tmp/metaclean-ts-out", { recursive: true });
    writeFileSync(`/tmp/metaclean-ts-out/${n}`, r.data);
  });
}

test("orientation survives cleaning", () => {
  const r = clean(load("photo_iphone.jpg"), "a.jpg", PRESETS.everything.options);
  assert.equal(r.after.orientation, 6);
  assert.deepEqual(r.after.fields.map(f => f.id).sort(), ["exif:0:274", "icc:profile"]);
});

test("keep copyright preset keeps only author and copyright", () => {
  const r = clean(load("photo_iphone.jpg"), "a.jpg", PRESETS.copyright.options);
  const ids = new Set(r.after.fields.map(f => f.id));
  for (const id of ["exif:0:315", "exif:0:33432", "xmp:dc:creator", "xmp:dc:rights", "iptc:2:116"]) assert.ok(ids.has(id), id);
  assert.equal(r.after.gps, null);
  assert.equal(r.after.aiSignals.length, 0);
  assert.ok(r.verified);
});

test("HEIC keeps chosen fields in place", () => {
  const r = clean(load("phone.heic"), "a.heic", PRESETS.copyright.options);
  assert.ok(r.after.fields.some(f => f.id === "exif:0:33432" && f.value === "(c) 2026 Jane Doe"));
  assert.ok(r.pixelsUntouched);
});

test("cleaning twice changes nothing", () => {
  const once = clean(load("photo_iphone.jpg"), "a.jpg", PRESETS.everything.options).data;
  const twice = clean(once, "a.jpg", PRESETS.everything.options).data;
  assert.deepEqual(twice, once);
});

test("highlights are short and plain", () => {
  const h = highlights(toReport(inspect(load("photo_iphone.jpg"), "a.jpg")));
  assert.ok(h.length <= 5);
  assert.deepEqual(h.map(x => x.key), ["location", "device", "personal", "ai", "hidden"]);
  assert.equal(h[0].title, "Where it was taken");
  assert.equal(highlights(toReport(inspect(clean(load("photo_iphone.jpg"), "a.jpg", PRESETS.everything.options).data, "a.jpg"))).length, 0);
});

test("damaged photos: corrupted copies of every fixture never hang or exhaust memory", () => {
  let seed = 11;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const start = Date.now();
  let cases = 0;
  for (const n of names) {
    const good = load(n);
    for (let k = 0; k < 60; k++) {
      const bad = good.slice(0, k % 4 === 0 ? rnd(good.length) : good.length);
      for (let j = 0, m = 1 + rnd(16); j < m && bad.length; j++) bad[rnd(Math.min(bad.length, 65536))] = rnd(256);
      if (k % 5 === 0 && bad.length > 64) bad.set([0xff, 0xff, 0xff, 0xf0], rnd(Math.min(bad.length - 4, 4096)));
      cases++;
      try {
        const inv = inspect(bad, n);
        if (inv.fmt !== "unknown") clean(bad, n, PRESETS.everything.options, inv);
      } catch { /* the app shows "Couldn't read this photo": fine */ }
    }
  }
  assert.ok(Date.now() - start < 20000, `fuzzing took ${Date.now() - start} ms`);
  assert.equal(cases, names.length * 60);
});

test("previews: HEIC thumbnails come with their HEVC settings; RAW previews skip lossless sensor data", async () => {
  const { previewFor, embeddedJpeg, hevcCodec } = await import("../src/preview.ts");
  const apple = previewFor("heif", load("apple.heic"));
  assert.ok(apple && apple.type === "hevc");
  assert.equal(`${apple.width}x${apple.height}`, "320x240");
  assert.match(apple.codec, /^hvc1\.\d+\.[0-9A-F]+\.[LH]\d+/);
  const phone = previewFor("heif", load("phone.heic"));
  assert.ok(phone && phone.type === "hevc" && phone.rotate === 270, "rotation is carried with the thumbnail");
  // a RAW-like file: TIFF header, a lossless (SOF3) sensor JPEG, then the real preview
  const jpg = load("apple.jpg");
  const lossless = new Uint8Array([0xff, 0xd8, 0xff, 0xc3, 0, 11, 8, 0x0b, 0xb8, 0x0f, 0xa0, 1, 1, 0x11, 0, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
  const raw = new Uint8Array([...new TextEncoder().encode("II*\0\x08\0\0\0"), ...new Uint8Array(64), ...lossless, ...jpg, 0, 0]);
  const found = embeddedJpeg(raw);
  assert.ok(found && found.length === jpg.length && found[3] !== 0xc3, "the displayable preview, not the sensor data");
  assert.equal(previewFor("jpeg", jpg), null, "browsers show JPEG themselves");
  assert.equal(previewFor("heif", new Uint8Array(100)), null, "damaged files just get no preview");
  assert.equal(hevcCodec(new Uint8Array([1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93])), "hvc1.1.6.L93.B0");
});
