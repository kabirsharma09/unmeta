// Videos and audio: built-by-hand files with known details, plus real files made by macOS (say, afconvert).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Part, bytesSource, cleanMedia, detectMedia, inspectMedia } from "../src/media.ts";
import { PRESETS } from "../src/presets.ts";
import { highlights } from "../src/highlights.ts";
import { toReport } from "../src/inspect.ts";

const enc = new TextEncoder();
const u8 = (...parts: (Uint8Array | string | number[])[]) => {
  const bs = parts.map(p => (typeof p === "string" ? enc.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bs) { out.set(b, o); o += b.length; }
  return out;
};
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const box = (type: string | number[], ...kids: (Uint8Array | string | number[])[]) => {
  const body = u8(...kids), t = typeof type === "string" ? u8(type.replace("©", "\xa9").split("").map(c => c.charCodeAt(0))) : u8(type);
  return u8(be32(8 + body.length), t, body);
};
const full = (type: string, ...kids: (Uint8Array | string | number[])[]) => box(type, [0, 0, 0, 0], ...kids);
const data = (text: string) => box("data", [0, 0, 0, 1], [0, 0, 0, 0], text);
const qtString = (text: string) => u8(be16(enc.encode(text).length), [0x15, 0xc7], text);

const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
 Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"><dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`;
const XMP_UUID = [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac];
const C2PA_UUID = [0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81];
const FRAMES = u8(Array.from({ length: 4096 }, (_, i) => (i * 37) & 255));
const secs1904 = (iso: string) => Math.floor(Date.parse(iso) / 1000) + 2082844800;

/** An iPhone-style MOV: Apple metadata keys, a QuickTime location atom, XMP and C2PA boxes, then the frames. */
function iphoneMov() {
  const t = secs1904("2026-03-01T08:15:42Z");
  const mvhd = full("mvhd", be32(t), be32(t), be32(600), be32(6000), new Array(80).fill(0));
  const tkhd = full("tkhd", be32(t), be32(t), be32(1), be32(0), be32(6000), new Array(8).fill(0), [0, 0, 0, 0, 0, 0, 0, 0],
    new Array(36).fill(0), be32(1920 << 16), be32(1080 << 16));
  const mdhd = full("mdhd", be32(t), be32(t), be32(600), be32(6000), [0, 0, 0, 0]);
  const hdlr = full("hdlr", [0, 0, 0, 0], "vide", new Array(12).fill(0), "Core Media Video\0");
  const keyNames = ["com.apple.quicktime.location.ISO6709", "com.apple.quicktime.make", "com.apple.quicktime.model",
    "com.apple.quicktime.software", "com.apple.quicktime.creationdate"];
  const keys = full("keys", be32(keyNames.length), ...keyNames.map(k => u8(be32(8 + k.length), "mdta", k)));
  const values = ["+51.5072-000.1275+011.200/", "Apple", "iPhone 15 Pro", "17.2", "2026-03-01T09:15:42+0100"];
  const ilst = box("ilst", ...values.map((v, i) => box(be32(i + 1), data(v))));
  const meta = box("meta", full("hdlr", [0, 0, 0, 0], "mdta", new Array(12).fill(0), "\0"), keys, ilst);
  const udta = box("udta", box("©xyz", qtString("+51.5072-000.1275/")), box("©mak", qtString("Apple")), box("CAME", "C39XK1234ABC"));
  const moov = box("moov", mvhd, box("trak", tkhd, box("mdia", mdhd, hdlr)), meta, udta);
  const xmp = box("uuid", XMP_UUID, XMP);
  const c2pa = box("uuid", C2PA_UUID, "jumb....c2pa....claim_generator\x6dAdobe Firefly");
  return { file: u8(box("ftyp", "qt  ", [0, 0, 0, 0], "qt  "), moov, xmp, c2pa, box("mdat", FRAMES)), frames: FRAMES };
}

/** An Android-style MP4 with the moov after the frames (the usual camera layout). */
function androidMp4() {
  const t = secs1904("2026-03-01T08:15:42Z");
  const mvhd = full("mvhd", be32(t), be32(t), be32(1000), be32(5000), new Array(80).fill(0));
  const udta = box("udta", box("©xyz", qtString("+48.8584+002.2945/")));
  const moov = box("moov", mvhd, box("trak", box("mdia", full("hdlr", [0, 0, 0, 0], "vide", new Array(12).fill(0), "\0"))), udta);
  return u8(box("ftyp", "isom", [0, 0, 2, 0], "isomiso2mp41"), box("mdat", FRAMES), moov);
}

function mp3() {
  const frame = (id: string, body: Uint8Array) => u8(id, be32(body.length), [0, 0], body);
  const text = (s: string) => u8([3], s);
  const frames = u8(
    frame("TIT2", text("Recording at 12 Baker Street")), frame("TPE1", text("Jane Doe")), frame("TYER", text("2026")),
    frame("COMM", u8([3], "eng", "\0", "Made with Suno")), frame("TXXX", u8([3], "Location\0", "+51.5072-000.1275")),
    frame("APIC", u8([0], "image/jpeg\0", [3], "\0", [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])),
  );
  const size = frames.length;
  const tag = u8("ID3", [3, 0, 0], [(size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127], frames);
  const audio = u8([0xff, 0xfb, 0x90, 0x64], FRAMES);
  const v1 = u8("TAG", "Old title".padEnd(30, "\0"), "Jane Doe".padEnd(30, "\0"), "".padEnd(30, "\0"), "2026", "".padEnd(30, "\0"), [12]);
  return { file: u8(tag, audio, v1), audio };
}

function wav() {
  const chunk = (id: string, body: Uint8Array) => u8(id, le32(body.length), body, body.length & 1 ? [0] : []);
  const sub = (id: string, s: string) => chunk(id, u8(s, "\0"));
  const fmt = chunk("fmt ", u8([1, 0, 1, 0], le32(44100), le32(88200), [2, 0, 16, 0]));
  const info = chunk("LIST", u8("INFO", sub("IART", "Jane Doe"), sub("ICRD", "2026-03-01"), sub("ISFT", "Voice Recorder 3.1")));
  const bext = chunk("bext", u8("Interview".padEnd(256, "\0"), "ZOOM H5".padEnd(32, "\0"), "SN C39XK1234ABC".padEnd(32, "\0"),
    "2026-03-01", "09:15:42", new Array(8 + 2 + 64 + 10 + 180).fill(0)));
  const ixml = chunk("iXML", u8("<BWFXML><LOCATION><LOCATION_NAME>London</LOCATION_NAME></LOCATION></BWFXML>"));
  const pcm = chunk("data", FRAMES);
  const body = u8("WAVE", fmt, info, bext, ixml, pcm);
  return { file: u8("RIFF", le32(body.length), body), audio: FRAMES };
}

const NEEDLES = ["Jane Doe", "C39XK1234ABC", "Firefly", "trainedAlgorithmicMedia", "+51.5072", "+48.8584", "iPhone 15 Pro", "Baker Street",
  "Suno", "ZOOM H5", "London", "2026-03-01"];

function assemble(src: Uint8Array, parts: Part[]) {
  return u8(...parts.map(p => ("bytes" in p ? p.bytes : src.subarray(p.from, p.to))));
}
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s));
const contains = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay).includes(Buffer.from(needle));

test("detects videos and audio, and leaves still pictures to the photo engine", () => {
  assert.equal(detectMedia(iphoneMov().file, "IMG_0001.MOV"), "mp4");
  assert.equal(detectMedia(androidMp4(), "VID.mp4"), "mp4");
  assert.equal(detectMedia(mp3().file, "a.mp3"), "mp3");
  assert.equal(detectMedia(wav().file, "a.wav"), "wav");
  assert.equal(detectMedia(u8(box("ftyp", "heic", [0, 0, 0, 0], "mif1heic")), "a.heic"), null);
});

test("iPhone video: finds location, phone, date, owner and AI labels in plain words", async () => {
  const { file } = iphoneMov();
  const inv = await inspectMedia(bytesSource(file), "IMG_0001.MOV");
  assert.deepEqual(inv.errors, []);
  assert.equal(inv.kind, "video");
  assert.deepEqual(inv.gps, [51.5072, -0.1275]);
  assert.equal(inv.width, 1920);
  const keys = highlights(toReport(inv)).map(h => [h.key, h.title]);
  assert.deepEqual(keys.map(k => k[0]), ["location", "device", "personal", "ai"]);
  assert.equal(keys[0][1], "Where it was recorded");
  const dev = highlights(toReport(inv)).find(h => h.key === "device")!;
  assert.match(dev.value, /iPhone 15 Pro/);
  assert.match(dev.value, /serial number/);
});

for (const [name, make] of [["iPhone MOV", () => iphoneMov().file], ["Android MP4", androidMp4]] as const) {
  test(`${name}: clean removes every detail, keeps the frames byte for byte and the file size`, async () => {
    const file = make();
    const r = await cleanMedia(bytesSource(file), "clip.mov", PRESETS.everything.options);
    const out = assemble(file, r.parts);
    assert.ok(r.verified, JSON.stringify(r.residual.map(f => f.id)));
    assert.equal(out.length, file.length, "in-place: same size, every offset still valid");
    assert.ok(contains(out, FRAMES), "frames untouched");
    for (const s of NEEDLES) assert.ok(!has(out, s), `${name} still contains ${s}`);
    const again = await inspectMedia(bytesSource(out), "clip.mov");
    assert.equal(again.gps, null);
    assert.deepEqual(again.errors, []);
    assert.equal(again.fields.filter(f => f.risk === "high" || f.risk === "medium").length, 0);
  });
}

test("video: 'Camera settings' keeps the phone model but not the location or serial number", async () => {
  const { file } = iphoneMov();
  const r = await cleanMedia(bytesSource(file), "IMG_0001.MOV", PRESETS.camera.options);
  const out = assemble(file, r.parts);
  assert.ok(has(out, "iPhone 15 Pro"));
  assert.ok(!has(out, "+51.5072"));
  assert.ok(!has(out, "C39XK1234ABC"));
});

test("MP3: removes the tag and the old ID3v1 block, keeps the audio frames exactly", async () => {
  const { file, audio } = mp3();
  const inv = await inspectMedia(bytesSource(file), "song.mp3");
  assert.equal(inv.kind, "audio");
  const hl = highlights(toReport(inv)).map(h => h.key);
  assert.deepEqual(hl, ["location", "personal", "ai", "hidden"]);
  const r = await cleanMedia(bytesSource(file), "song.mp3", PRESETS.everything.options, inv);
  const out = assemble(file, r.parts);
  assert.ok(r.verified, JSON.stringify(r.residual.map(f => f.id)));
  assert.deepEqual(out, audio, "only the audio frames remain");
});

test("MP3: 'My name and copyright' keeps the artist frame verbatim", async () => {
  const { file } = mp3();
  const inv = await inspectMedia(bytesSource(file), "song.mp3");
  const artist = inv.fields.find(f => f.name === "TPE1")!;
  const r = await cleanMedia(bytesSource(file), "song.mp3", { keepCategories: ["technical"], keepFields: [artist.id] }, inv);
  const out = assemble(file, r.parts);
  assert.ok(has(out, "Jane Doe"));
  assert.ok(!has(out, "Baker Street"));
  const again = await inspectMedia(bytesSource(out), "song.mp3");
  assert.deepEqual(again.fields.map(f => f.name), ["TPE1"]);
});

test("WAV: removes INFO, broadcast and iXML chunks; the samples and format stay", async () => {
  const { file, audio } = wav();
  const inv = await inspectMedia(bytesSource(file), "take1.wav");
  assert.ok(inv.fields.some(f => f.category === "location"));
  const r = await cleanMedia(bytesSource(file), "take1.wav", PRESETS.everything.options, inv);
  const out = assemble(file, r.parts);
  assert.ok(r.verified, JSON.stringify(r.residual.map(f => f.id)));
  for (const s of NEEDLES) assert.ok(!has(out, s), `wav still contains ${s}`);
  assert.ok(contains(out, audio));
  assert.ok(has(out, "fmt "));
  const view = new DataView(out.buffer, out.byteOffset);
  assert.equal(view.getUint32(4, true), out.length - 8, "RIFF size is updated");
});

test("real files from macOS (say, afconvert) read cleanly and come out with identical audio", async () => {
  for (const n of ["say_memo.m4a", "afconvert.wav"]) {
    const file = new Uint8Array(readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url)));
    const inv = await inspectMedia(bytesSource(file), n);
    assert.deepEqual(inv.errors, [], n);
    assert.equal(inv.kind, "audio");
    const r = await cleanMedia(bytesSource(file), n, PRESETS.everything.options, inv);
    const out = assemble(file, r.parts);
    assert.ok(r.verified, n);
    if (n.endsWith(".m4a")) assert.equal(out.length, file.length);
    const again = await inspectMedia(bytesSource(out), n);
    assert.deepEqual(again.errors, [], n);
  }
});

test("damaged files: hundreds of corrupted videos and recordings never hang, crash the parser or leak", async () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const samples: [string, Uint8Array][] = [["a.mov", iphoneMov().file], ["b.mp4", androidMp4()], ["c.mp3", mp3().file], ["d.wav", wav().file]];
  const start = Date.now();
  let cases = 0;
  for (const [name, good] of samples) {
    for (let k = 0; k < 150; k++) {
      const bad = good.slice(0, k % 5 === 0 ? rnd(good.length) : good.length);
      for (let j = 0, n = 1 + rnd(12); j < n && bad.length; j++) bad[rnd(bad.length)] = rnd(256);
      if (k % 7 === 0 && bad.length > 12) bad.set([0xff, 0xff, 0xff, 0xf0], rnd(bad.length - 4));  // absurd sizes
      cases++;
      let inv;
      try { inv = await inspectMedia(bytesSource(bad), name); } catch { continue; }  // "not a video" is a fine answer
      const r = await cleanMedia(bytesSource(bad), name, PRESETS.everything.options, inv);
      const out = assemble(bad, r.parts);
      if (r.verified) for (const s of ["Jane Doe", "+51.5072", "C39XK1234ABC"]) {
        // a verified result must really be free of what the engine could read
        if (inv.fields.some(f => f.value.includes(s))) assert.ok(!has(out, s), `${name} #${k} verified but kept ${s}`);
      }
    }
  }
  assert.ok(Date.now() - start < 5000, "fuzzing must be fast: no runaway loops");
  assert.equal(cases, 600);
});

test("genuine Apple files (ImageIO and AVFoundation): every detail found, removed, and the file still valid", async () => {
  const { inspect } = await import("../src/inspect.ts");
  const { clean } = await import("../src/clean.ts");
  const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url)));
  const LEAKS = ["Jane Doe", "C39XK1234ABC", "iPhone 15 Pro", "+51.5072"];
  for (const n of ["apple.heic", "apple.jpg"]) {
    const d = fx(n), inv = inspect(d, n);
    assert.deepEqual(inv.gps, [51.5072, -0.1275], n);
    assert.deepEqual(highlights(toReport(inv)).slice(0, 3).map(h => h.key), ["location", "device", "personal"], n);
    const r = clean(d, n, PRESETS.everything.options, inv);
    assert.ok(r.verified && r.pixelsUntouched, n);
    for (const s of LEAKS) assert.ok(!has(r.data, s), `${n} kept ${s}`);
  }
  for (const n of ["apple.mov", "apple.mp4"]) {
    const d = fx(n), inv = await inspectMedia(bytesSource(d), n);
    assert.equal(inv.kind, "video");
    assert.ok(inv.gps && Math.abs(inv.gps[0] - 51.5072) < 1e-3, n);
    const r = await cleanMedia(bytesSource(d), n, PRESETS.everything.options, inv);
    const out = assemble(d, r.parts);
    assert.ok(r.verified, n);
    assert.equal(out.length, d.length, n);
    for (const s of LEAKS) assert.ok(!has(out, s), `${n} kept ${s}`);
    const again = await inspectMedia(bytesSource(out), n);
    assert.deepEqual(again.fields.filter(f => f.category !== "technical").map(f => f.id), [], `${n}: no empty entries left behind`);
  }
});
