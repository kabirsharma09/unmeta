// EXIF / TIFF directory reader and a minimal writer.
import { type Bytes, concat, u16be, u16le, u32be, u32le, utf8DecodeStrict, latin1, utf8Encode, ascii } from "./bytes.ts";

export const IFD_EXIF = 0x8769, IFD_GPS = 0x8825, IFD_INTEROP = 0xa005;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 129: 1 };
/** Most value bytes decoded per file: bounds time and memory when many entries point at the same large region. */
const VALUE_BUDGET = 32 * 1024 * 1024;

export interface Entry {
  tag: number;
  type: number;
  count: number;
  raw: Bytes;          // value bytes in the source byte order
  value: unknown;      // decoded JS value
  pos: number;         // absolute offset of the value bytes in the parsed buffer (for in-place blanking)
}
export interface ExifData {
  le: boolean;
  ifd0: Map<number, Entry>;
  exif: Map<number, Entry>;
  gps: Map<number, Entry>;
  interop: Map<number, Entry>;
  hasIfd1: boolean;
  /** Every entry read, in file order, including repeated copies of a tag (the maps above keep only the last copy). */
  all: { ifd: "0" | "exif" | "gps" | "interop"; entry: Entry }[];
  /** Things the reader skipped without understanding them. Anything here may hide data that wasn't shown. */
  problems: string[];
}

/** Parse TIFF-structured EXIF. Accepts data starting with "Exif\0\0" or a TIFF header. */
export function readExif(data: Bytes, offset = 0): ExifData {
  let base = offset;
  if (data[base] === 0x45 && data[base + 1] === 0x78 && data[base + 4] === 0 && data[base + 5] === 0) base += 6;
  const le = data[base] === 0x49;
  if (!le && data[base] !== 0x4d) throw new Error("bad TIFF header");
  const r16 = (o: number) => (le ? u16le(data, base + o) : u16be(data, base + o));
  const r32 = (o: number) => (le ? u32le(data, base + o) : u32be(data, base + o));
  const size = data.length - base;

  const all: ExifData["all"] = [], problems: string[] = [];
  const problem = (p: string) => { if (!problems.includes(p)) problems.push(p); };
  if (r16(2) !== 42) problem("not a standard TIFF header");
  let budget = VALUE_BUDGET;

  const readIfd = (off: number, ifd: ExifData["all"][number]["ifd"] | null): [Map<number, Entry>, number] => {
    const m = new Map<number, Entry>();
    if (off <= 0 || off + 2 > size) return [m, 0];
    const n = r16(off);   // at most 65,535 entries, so the loop is bounded
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > size) { problem("a directory runs past the end of the file"); break; }
      const tag = r16(e), type = r16(e + 2), count = r32(e + 4);
      const unit = TYPE_SIZE[type];
      if (!unit) { problem(`tag ${tag} has an unknown value type (${type})`); continue; }
      const len = unit * count;
      if (len > 16 * 1024 * 1024) { problem(`tag ${tag} is too large to read`); continue; }
      const voff = len <= 4 ? e + 8 : r32(e + 8);
      if (voff + len > size) continue;   // points outside the file: there is nothing there to leak
      if (len > 4) {
        if (budget < len) { problem("too much metadata to read"); continue; }
        budget -= len;
      }
      const raw = data.subarray(base + voff, base + voff + len);
      const entry: Entry = { tag, type, count, raw, value: decode(raw, type, count, le), pos: base + voff };
      m.set(tag, entry);
      if (ifd) all.push({ ifd, entry });
    }
    const nextPos = off + 2 + n * 12;
    const next = nextPos + 4 <= size ? r32(nextPos) : 0;
    return [m, next];
  };
  const [ifd0, next] = readIfd(r32(4), "0");
  const ptr = (m: Map<number, Entry>, t: number) => {
    const e = m.get(t);
    return e && typeof e.value === "number" ? (e.value as number) : 0;
  };
  const [exif] = readIfd(ptr(ifd0, IFD_EXIF), "exif");
  const [gps] = readIfd(ptr(ifd0, IFD_GPS), "gps");
  const [interop] = readIfd(ptr(exif, IFD_INTEROP), "interop");
  let hasIfd1 = false;
  if (next > 0 && next < size) hasIfd1 = readIfd(next, null)[0].size > 0;
  return { le, ifd0, exif, gps, interop, hasIfd1, all, problems };
}

function decode(raw: Bytes, type: number, count: number, le: boolean): unknown {
  const r16 = (o: number) => (le ? u16le(raw, o) : u16be(raw, o));
  const r32 = (o: number) => (le ? u32le(raw, o) : u32be(raw, o));
  const list = (n: number, f: (i: number) => number) => {
    const a = Array.from({ length: n }, (_, i) => f(i));
    return n === 1 ? a[0] : a;
  };
  switch (type) {
    case 2: case 129: {
      let end = raw.length;
      while (end > 0 && raw[end - 1] === 0) end--;
      return utf8DecodeStrict(raw, 0, end) ?? latin1(raw, 0, end);
    }
    case 1: case 6: return count > 8 ? raw : list(count, i => raw[i]);
    case 7: return raw;
    case 3: return list(count, i => r16(i * 2));
    case 8: return list(count, i => { const v = r16(i * 2); return v > 32767 ? v - 65536 : v; });
    case 4: case 13: return list(count, i => r32(i * 4));
    case 9: return list(count, i => r32(i * 4) | 0);
    case 5: return list(count, i => { const d = r32(i * 8 + 4); return d ? r32(i * 8) / d : 0; });
    case 10: return list(count, i => { const d = r32(i * 8 + 4) | 0; return d ? (r32(i * 8) | 0) / d : 0; });
    default: return raw;
  }
}

export function gpsDecimal(gps: Map<number, Entry>): [number, number] | null {
  const lat = gps.get(2)?.value, lon = gps.get(4)?.value;
  if (!Array.isArray(lat) || !Array.isArray(lon)) return null;
  const conv = (v: number[], ref: unknown) => {
    const d = v[0] + v[1] / 60 + v[2] / 3600;
    return ref === "S" || ref === "W" ? -d : d;
  };
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return [r(conv(lat, gps.get(1)?.value)), r(conv(lon, gps.get(3)?.value))];
}

// ---------------------------------------------------------------- writer

export interface WriteEntry { tag: number; type: number; count: number; raw: Bytes }

export function asciiEntry(tag: number, text: string): WriteEntry {
  const raw = concat([utf8Encode(text), new Uint8Array([0])]); // UTF-8 in an ASCII field, as ExifTool does
  return { tag, type: 2, count: raw.length, raw };
}
export function shortEntry(tag: number, v: number, le: boolean): WriteEntry {
  return { tag, type: 3, count: 1, raw: le ? new Uint8Array([v & 255, v >> 8]) : new Uint8Array([v >> 8, v & 255]) };
}

/** Build a TIFF/EXIF blob (without the "Exif\0\0" prefix). Raw values must be in `le` byte order. */
export function writeExif(le: boolean, ifd0: WriteEntry[], exif: WriteEntry[], gps: WriteEntry[]): Bytes {
  const w16 = (v: number) => (le ? new Uint8Array([v & 255, (v >> 8) & 255]) : new Uint8Array([(v >> 8) & 255, v & 255]));
  const w32 = (v: number) => (le ? new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255])
    : new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]));
  const dir0 = [...ifd0.filter(e => e.tag !== IFD_EXIF && e.tag !== IFD_GPS)];
  const placeholder = (tag: number): WriteEntry => ({ tag, type: 4, count: 1, raw: w32(0) });
  if (exif.length) dir0.push(placeholder(IFD_EXIF));
  if (gps.length) dir0.push(placeholder(IFD_GPS));
  const dirs = [dir0, exif, gps].map(d => [...d].sort((a, b) => a.tag - b.tag));
  const dirSize = (d: WriteEntry[]) => 2 + d.length * 12 + 4;
  const dataSize = (d: WriteEntry[]) => d.reduce((n, e) => n + (e.raw.length > 4 ? e.raw.length + (e.raw.length & 1) : 0), 0);

  // layout: header(8) | dir0 + data0 | exif dir + data | gps dir + data
  const offsets: number[] = [];
  let pos = 8;
  for (const d of dirs) { offsets.push(d.length ? pos : 0); if (d.length) pos += dirSize(d) + dataSize(d); }
  const patch = (d: WriteEntry[], tag: number, off: number) => {
    const e = d.find(x => x.tag === tag);
    if (e) e.raw = w32(off);
  };
  patch(dirs[0], IFD_EXIF, offsets[1]);
  patch(dirs[0], IFD_GPS, offsets[2]);

  const chunks: Bytes[] = [le ? ascii("II") : ascii("MM"), w16(42), w32(8)];
  dirs.forEach((d, i) => {
    if (!d.length) return;
    let dataPos = offsets[i] + dirSize(d);
    const entries: Bytes[] = [w16(d.length)];
    const data: Bytes[] = [];
    for (const e of d) {
      entries.push(w16(e.tag), w16(e.type), w32(e.count));
      if (e.raw.length <= 4) {
        const v = new Uint8Array(4); v.set(e.raw); entries.push(v);
      } else {
        entries.push(w32(dataPos));
        data.push(e.raw);
        if (e.raw.length & 1) data.push(new Uint8Array(1));
        dataPos += e.raw.length + (e.raw.length & 1);
      }
    }
    entries.push(w32(0));
    chunks.push(...entries, ...data);
  });
  return concat(chunks);
}
