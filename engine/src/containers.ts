// Byte-level container parsers/writers for lossless cleaning (JPEG, PNG, WebP) + IPTC/IRB + C2PA helpers.
import { Inflate, deflate } from "pako";
import {
  type Bytes, ascii, be16, be32, concat, crc32, indexOf, latin1, le32, startsWith, u16be, u32be, u32le, utf8Decode, utf8Encode,
} from "./bytes.ts";

export type Format = "jpeg" | "png" | "webp" | "heif" | "avif" | "tiff" | "raw" | "mp4" | "mp3" | "wav" | "unknown";
export const RAW_EXTS = new Set([".dng", ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".orf", ".rw2", ".pef",
  ".raf", ".srw", ".3fr", ".iiq", ".erf", ".mos", ".x3f"]);

export function detectFormat(d: Bytes, filename = ""): Format {
  const ext = filename.includes(".") ? "." + filename.split(".").pop()!.toLowerCase() : "";
  if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return "jpeg";
  if (startsWith(d, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (startsWith(d, "RIFF") && startsWith(d, "WEBP", 8)) return "webp";
  if (startsWith(d, "ftyp", 4)) {
    const brands = latin1(d, 8, Math.min(d.length, 64));
    if (/avif|avis/.test(brands)) return "avif";
    if (brands.includes("crx ")) return "raw";
    if (/heic|heix|mif1|msf1|heim|heis|hevc/.test(brands)) return "heif";
  }
  if (RAW_EXTS.has(ext)) return "raw";
  const h = latin1(d, 0, 4);
  if (h === "II*\0" || h === "MM\0*" || h === "II+\0" || h === "MM\0+") return "tiff";
  if (h === "IIRO" || h === "IIRS" || h === "IIU\0" || latin1(d, 0, 8) === "FUJIFILM") return "raw";
  return "unknown";
}

// ---------------------------------------------------------------- JPEG
export interface Seg { marker: number; payload: Bytes }
export interface JpegFile { header: Seg[]; scan: Bytes; trailer: Bytes }

export function segKind(s: Seg): string {
  const { marker: m, payload: p } = s;
  if (m === 0xe0) return startsWith(p, "JFXX\0") ? "jfxx" : startsWith(p, "JFIF\0") ? "jfif" : "app0";
  if (m === 0xe1) {
    if (startsWith(p, "Exif\0")) return "exif";
    if (startsWith(p, "http://ns.adobe.com/xap/1.0/\0")) return "xmp";
    if (startsWith(p, "http://ns.adobe.com/xmp/extension/\0")) return "xmp_ext";
    return "app1";
  }
  if (m === 0xe2) return startsWith(p, "ICC_PROFILE\0") ? "icc" : startsWith(p, "MPF\0") ? "mpf" : "app2";
  if (m === 0xeb && startsWith(p, "JP")) return "jumbf";
  if (m === 0xed && startsWith(p, "Photoshop 3.0\0")) return "photoshop";
  if (m === 0xee && startsWith(p, "Adobe")) return "adobe";
  if (m === 0xfe) return "comment";
  if (m >= 0xe0 && m <= 0xef) return `app${m - 0xe0}`;
  return STRUCTURAL_MARKERS.has(m) ? "structural" : `marker_${m.toString(16)}`;
}

/** Markers the picture needs: tables, frame headers, restart interval. Anything else is not kept. */
const STRUCTURAL_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf, // SOFn
  0xc4, 0xcc, 0xdb, 0xdd, 0xdc, 0xde, 0xdf]);   // DHT, DAC, DQT, DRI, DNL, DHP, EXP
/** JPEG-LS uses SOF55 (0xF7) and LSE (0xF8) as its frame markers; in any other JPEG they are just hidden blocks. */
export const isJpegLs = (header: Seg[]) => header.some(s => s.marker === 0xf7)
  && !header.some(s => STRUCTURAL_MARKERS.has(s.marker) && s.marker >= 0xc0 && s.marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(s.marker));

/** The scan (SOS to EOI) with any APPn/COM segments between progressive scans set aside. */
export function splitScan(scan: Bytes): { image: Bytes; hidden: Seg[] } {
  const keep: Bytes[] = [], hidden: Seg[] = [];
  let from = 0, i = 0;
  while (i + 1 < scan.length) {
    if (scan[i] !== 0xff) { i++; continue; }
    const m = scan[i + 1];
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) { i += m === 0xff ? 1 : 2; continue; }
    if (m === 0xd9 || i + 4 > scan.length) break;
    const len = u16be(scan, i + 2);
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      keep.push(scan.subarray(from, i));
      hidden.push({ marker: m, payload: scan.slice(i + 4, Math.min(scan.length, i + 2 + len)) });
      i = from = Math.min(scan.length, i + 2 + len);
      continue;
    }
    i += 2 + len;   // a table or the next scan header: part of the picture
  }
  keep.push(scan.subarray(from));
  return { image: hidden.length ? concat(keep) : scan, hidden };
}

export function parseJpeg(d: Bytes): JpegFile {
  let pos = 2;
  const header: Seg[] = [];
  while (pos < d.length) {
    if (d[pos] !== 0xff) throw new Error(`bad JPEG marker at ${pos}`);
    while (d[pos + 1] === 0xff) pos++;
    const marker = d[pos + 1];
    if (marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    const len = u16be(d, pos + 2);
    header.push({ marker, payload: d.slice(pos + 4, pos + 2 + len) });
    pos += 2 + len;
  }
  const eoi = indexOf(d, new Uint8Array([0xff, 0xd9]), pos);
  const end = eoi < 0 ? d.length : eoi + 2;
  return { header, scan: d.slice(pos, end), trailer: d.slice(end) };
}

export function writeJpeg(header: Seg[], scan: Bytes): Bytes {
  return concat([new Uint8Array([0xff, 0xd8]),
    ...header.flatMap(s => [new Uint8Array([0xff, s.marker]), be16(s.payload.length + 2), s.payload]), scan]);
}
export function jpegIccSegs(icc: Bytes): Seg[] {
  const max = 65519 - 14, n = Math.max(1, Math.ceil(icc.length / max));
  return Array.from({ length: n }, (_, i) => ({
    marker: 0xe2, payload: concat([ascii("ICC_PROFILE\0"), new Uint8Array([i + 1, n]), icc.slice(i * max, (i + 1) * max)]),
  }));
}
export function jpegIcc(segs: Seg[]): Bytes | null {
  const parts = segs.filter(s => segKind(s) === "icc").sort((a, b) => a.payload[12] - b.payload[12]).map(s => s.payload.slice(14));
  return parts.length ? concat(parts) : null;
}
export function jpegSize(segs: Seg[]): [number, number] {
  const sof = segs.find(s => s.marker >= 0xc0 && s.marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(s.marker));
  return sof ? [u16be(sof.payload, 3), u16be(sof.payload, 1)] : [0, 0];
}

// ---------------------------------------------------------------- PNG
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const PNG_RENDER = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "pHYs", "bKGD",
  "hIST", "cICP", "mDCV", "mDCv", "cLLI", "cLLi", "acTL", "fcTL", "fdAT"]);
export interface Chunk { type: string; data: Bytes }

export function parsePng(d: Bytes): Chunk[] {
  let pos = 8;
  const out: Chunk[] = [];
  while (pos + 8 <= d.length) {
    const len = u32be(d, pos), type = latin1(d, pos + 4, pos + 8);
    out.push({ type, data: d.slice(pos + 8, pos + 8 + len) });
    pos += 12 + len;
    if (type === "IEND") break;
  }
  return out;
}
export function writePng(chunks: Chunk[]): Bytes {
  return concat([PNG_SIG, ...chunks.flatMap(c => {
    const td = concat([ascii(c.type), c.data]);
    return [be32(c.data.length), td, be32(crc32(td))];
  })]);
}
/** zlib inflate that stops once the output passes `cap` (a few hundred KB can otherwise expand to gigabytes). */
export function inflateLimited(data: Bytes, cap: number): Bytes | null {
  const inf = new Inflate() as Inflate & { ended: boolean; err: number };
  const chunks: Bytes[] = [];
  let total = 0;
  inf.onData = (c: unknown) => { const b = c as Bytes; total += b.length; if (total <= cap) chunks.push(b); };
  const STEP = 16 * 1024;
  for (let i = 0; i < data.length && !inf.ended && total <= cap; i += STEP) inf.push(data.subarray(i, i + STEP), i + STEP >= data.length);
  if (total > cap) return null;
  if (inf.err) throw new Error("damaged compressed data");
  return concat(chunks);
}
const TEXT_CAP = 8 * 1024 * 1024, ICC_CAP = 16 * 1024 * 1024;

export function pngText(c: Chunk): [string, string] {
  try {
    const z = c.data.indexOf(0);
    const key = latin1(c.data, 0, z);
    if (c.type === "tEXt") return [key, latin1(c.data, z + 1)];
    if (c.type === "zTXt") { const t = inflateLimited(c.data.slice(z + 2), TEXT_CAP); return [key, t ? latin1(t) : "<compressed text too large to read>"]; }
    if (c.type === "iTXt") {
      const comp = c.data[z + 1];
      let p = z + 3;
      p = c.data.indexOf(0, p) + 1; // language
      p = c.data.indexOf(0, p) + 1; // translated keyword
      const body = c.data.slice(p);
      const t = comp ? inflateLimited(body, TEXT_CAP) : body;
      return [key, t ? utf8Decode(t) : "<compressed text too large to read>"];
    }
  } catch { /* fall through */ }
  return [c.type, `<${c.data.length} bytes>`];
}
export const pngItxt = (key: string, text: string): Chunk => ({ type: "iTXt", data: concat([ascii(key), new Uint8Array(5), utf8Encode(text)]) });
export const pngIccp = (icc: Bytes): Chunk => ({ type: "iCCP", data: concat([ascii("ICC Profile\0\0"), deflate(icc)]) });
export function pngIcc(c: Chunk): Bytes {
  const z = c.data.indexOf(0);
  const icc = inflateLimited(c.data.slice(z + 2), ICC_CAP);
  if (!icc) throw new Error("colour profile too large");
  return icc;
}

// ---------------------------------------------------------------- WebP
export interface Riff { fourcc: string; data: Bytes }
export const WEBP_IMAGE = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);

export function parseWebp(d: Bytes): Riff[] {
  const end = Math.min(d.length, 8 + u32le(d, 4));
  let pos = 12;
  const out: Riff[] = [];
  while (pos + 8 <= end) {
    const fourcc = latin1(d, pos, pos + 4), size = u32le(d, pos + 4);
    out.push({ fourcc, data: d.slice(pos + 8, pos + 8 + size) });
    pos += 8 + size + (size & 1);
  }
  return out;
}
export function webpSize(chunks: Riff[]): [number, number, boolean] {
  const x = chunks.find(c => c.fourcc === "VP8X");
  if (x) {
    const w = 1 + (x.data[4] | (x.data[5] << 8) | (x.data[6] << 16)), h = 1 + (x.data[7] | (x.data[8] << 8) | (x.data[9] << 16));
    return [w, h, !!(x.data[0] & 0x10)];
  }
  const l = chunks.find(c => c.fourcc === "VP8L");
  if (l) {
    const b = l.data, bits = b[1] | (b[2] << 8) | (b[3] << 16) | (b[4] << 24);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, !!((bits >> 28) & 1)];
  }
  const v = chunks.find(c => c.fourcc === "VP8 ");
  if (v) return [(v.data[6] | (v.data[7] << 8)) & 0x3fff, (v.data[8] | (v.data[9] << 8)) & 0x3fff, false];
  return [0, 0, false];
}
export function writeWebp(chunks: Riff[], w: number, h: number, alpha: boolean): Bytes {
  const present = new Set(chunks.map(c => c.fourcc));
  const old = chunks.find(c => c.fourcc === "VP8X");
  let body = chunks.filter(c => c.fourcc !== "VP8X");
  if (old || ["ICCP", "EXIF", "XMP ", "ANIM", "C2PA", "ALPH"].some(k => present.has(k))) {
    let flags = 0;
    if (present.has("ICCP")) flags |= 0x20;
    if (alpha || present.has("ALPH") || (old && old.data[0] & 0x10)) flags |= 0x10;
    if (present.has("EXIF")) flags |= 0x08;
    if (present.has("XMP ")) flags |= 0x04;
    if (present.has("ANIM")) flags |= 0x02;
    const canvas = old ? old.data.slice(4, 10) : concat([le32(w - 1).slice(0, 3), le32(h - 1).slice(0, 3)]);
    const order: Record<string, number> = { ICCP: 1, ANIM: 2, ANMF: 3, ALPH: 3, "VP8 ": 3, VP8L: 3, EXIF: 4, "XMP ": 5 };
    body = [...body].sort((a, b) => (order[a.fourcc] ?? 6) - (order[b.fourcc] ?? 6));
    body.unshift({ fourcc: "VP8X", data: concat([new Uint8Array([flags, 0, 0, 0]), canvas]) });
  }
  const payload = concat([ascii("WEBP"), ...body.flatMap(c => [ascii(c.fourcc), le32(c.data.length), c.data,
    c.data.length & 1 ? new Uint8Array(1) : new Uint8Array(0)])]);
  return concat([ascii("RIFF"), le32(payload.length), payload]);
}

// ---------------------------------------------------------------- Photoshop IRB / IPTC IIM
export function parseIrb(d: Bytes): [number, Bytes][] {
  const out: [number, Bytes][] = [];
  let pos = 0;
  while (pos + 12 <= d.length && ["8BIM", "PHUT", "AgHg", "DCSR"].includes(latin1(d, pos, pos + 4))) {
    const id = u16be(d, pos + 4), nlen = d[pos + 6];
    pos += 6 + ((nlen + 2) & ~1);
    const size = u32be(d, pos);
    out.push([id, d.slice(pos + 4, pos + 4 + size)]);
    pos += 4 + size + (size & 1);
  }
  return out;
}
export function buildIrb(blocks: [number, Bytes][]): Bytes {
  return concat(blocks.flatMap(([id, data]) => [ascii("8BIM"), be16(id), new Uint8Array([0, 0]), be32(data.length), data,
    data.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]));
}
export type Dataset = [number, number, Bytes];
export function parseIim(d: Bytes): Dataset[] {
  const out: Dataset[] = [];
  let pos = 0;
  while (pos + 5 <= d.length && d[pos] === 0x1c) {
    const rec = d[pos + 1], ds = d[pos + 2];
    let len = u16be(d, pos + 3);
    pos += 5;
    if (len & 0x8000) { const nb = len & 0x7fff; len = 0; for (let i = 0; i < nb; i++) len = len * 256 + d[pos + i]; pos += nb; }
    out.push([rec, ds, d.slice(pos, pos + len)]);
    pos += len;
  }
  return out;
}
export function buildIim(ds: Dataset[]): Bytes {
  const all = ds.some(([r, d]) => r === 1 && d === 90) ? ds : [[1, 90, new Uint8Array([0x1b, 0x25, 0x47])] as Dataset, ...ds];
  return concat([...all].sort((a, b) => a[0] - b[0] || a[1] - b[1]).flatMap(([r, d, v]) => [new Uint8Array([0x1c, r, d]), be16(v.length), v]));
}

// ---------------------------------------------------------------- C2PA
export const C2PA_UUID = new Uint8Array([0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81]);

function cborTextsAfter(b: Bytes, key: string): string[] {
  const out: string[] = [];
  const k = ascii(key);
  let from = 0;
  for (;;) {
    const i = indexOf(b, k, from);
    if (i < 0) return out;
    const j = i + k.length;
    from = j;
    const t = b[j];
    let n: number, off: number;
    if (t >= 0x60 && t <= 0x77) { n = t - 0x60; off = 1; }
    else if (t === 0x78) { n = b[j + 1]; off = 2; }
    else if (t === 0x79) { n = u16be(b, j + 1); off = 3; }
    else continue;
    out.push(utf8Decode(b, j + off, j + off + n));
  }
}
export interface C2paSummary { bytes: number; claim_generator?: string; generator_info?: string[]; digital_source_type?: string[]; actions?: string[] }
export function summarizeC2pa(blob: Bytes): C2paSummary {
  const s: C2paSummary = { bytes: blob.length };
  const text = latin1(blob);
  const gens = cborTextsAfter(blob, "claim_generator");
  if (gens.length) s.claim_generator = gens[0];
  const names = cborTextsAfter(blob, "name").filter(n => n.length > 0 && n.length < 80);
  if (names.length) s.generator_info = [...new Set(names)].sort().slice(0, 6);
  const dst = [...new Set([...text.matchAll(/digitalsourcetype\/(\w+)/gi)].map(m => m[1]))].sort();
  if (dst.length) s.digital_source_type = dst;
  const acts = [...new Set([...text.matchAll(/c2pa\.(?:created|opened|edited|placed|converted|color_adjustments|cropped|filtered|resized|drawing|published|transcoded|repackaged)/g)].map(m => m[0]))].sort();
  if (acts.length) s.actions = acts;
  return s;
}
export function findBmffC2pa(d: Bytes): Bytes | null {
  let pos = 0;
  while (pos + 8 <= d.length) {
    let size = u32be(d, pos), hdr = 8;
    const type = latin1(d, pos + 4, pos + 8);
    if (size === 1) { size = u32be(d, pos + 8) * 2 ** 32 + u32be(d, pos + 12); hdr = 16; }
    else if (size === 0) size = d.length - pos;
    if (size < hdr) break;
    if (type === "uuid" && startsWith(d, C2PA_UUID, pos + hdr)) return d.slice(pos, pos + size);
    pos += size;
  }
  return null;
}
