// EXIF / TIFF directory reader and a minimal writer.
import { type Bytes, concat, u16be, u16le, u32be, u32le, utf8DecodeStrict, latin1, utf8Encode, ascii } from "./bytes.ts";

export const IFD_EXIF = 0x8769, IFD_GPS = 0x8825, IFD_INTEROP = 0xa005;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 129: 1 };
/** Most value bytes decoded per file: bounds time and memory when many entries point at the same large region. */
const VALUE_BUDGET = 32 * 1024 * 1024;
// decoded numbers become JS arrays (8+ bytes each, copied several times by a clean): cap how many we decode so a small
// crafted file with millions of picture strips can't use gigabytes of memory in the browser
const MAX_DECODED = 1_000_000;

export interface Entry {
  tag: number;
  type: number;
  count: number;
  raw: Bytes;          // value bytes in the source byte order
  value: unknown;      // decoded JS value
  pos: number;         // absolute offset of the value bytes in the parsed buffer (for in-place blanking)
}
export type DirKind = "main" | "exif" | "gps" | "interop";
/** One directory of the TIFF graph. Names: "0", "1", "2"… for the main chain, "sub1"… for SubIFDs, and
 *  "exif"/"gps"/"interop" for the first directory of each kind ("exif2", "gps2"… for any later one). */
export interface Dir { name: string; kind: DirKind; off: number; entries: Map<number, Entry>; count: number }
export interface ExifData {
  le: boolean;
  /** Where the TIFF header starts in the parsed buffer; directory offsets are relative to it. */
  base: number;
  ifd0: Map<number, Entry>;
  exif: Map<number, Entry>;
  gps: Map<number, Entry>;
  interop: Map<number, Entry>;
  hasIfd1: boolean;
  /** Every directory reached: the IFD chain, SubIFDs, Exif, GPS (from IFD0 or the Exif IFD) and Interop. */
  dirs: Dir[];
  /** Every entry read, in file order, including repeated copies of a tag (the maps above keep only the last copy). */
  all: { ifd: string; kind: DirKind; entry: Entry }[];
  /** Things the reader skipped without understanding them. Anything here may hide data that wasn't shown. */
  problems: string[];
}

/** Most directories followed, and entries read, per file: bound time and memory when pointers fan out or loop. */
const MAX_DIRS = 512, MAX_ENTRIES = 300_000;
/** Pointer tags the reader follows, and the kind of directory each leads to. */
const CHILD: Record<number, DirKind> = { [IFD_EXIF]: "exif", [IFD_GPS]: "gps", [IFD_INTEROP]: "interop", 0x014a: "main" };
export const IFD_POINTERS = new Set(Object.keys(CHILD).map(Number));

/** Parse TIFF-structured EXIF. Accepts data starting with "Exif\0\0" or a TIFF header. Walks the whole directory
 *  graph (IFD chain, SubIFDs, Exif, GPS, Interop) once per directory, with a hard bound. */
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
  let budget = VALUE_BUDGET, slots = 0, decoded = 0;

  const readIfd = (off: number, name: string, kind: DirKind): [Map<number, Entry>, number, number] => {
    const m = new Map<number, Entry>();
    const n = r16(off);   // at most 65,535 entries, so the loop is bounded
    for (let i = 0; i < n; i++) {
      if (++slots > MAX_ENTRIES) { problem("too many entries to read"); break; }
      const e = off + 2 + i * 12;
      if (e + 12 > size) { problem("a directory runs past the end of the file"); break; }
      const tag = r16(e), type = r16(e + 2), count = r32(e + 4);
      const unit = TYPE_SIZE[type];
      if (!unit) { problem(`tag ${tag} has an unknown value type (${type})`); continue; }
      const len = unit * count;
      if (len > 16 * 1024 * 1024) { problem(`tag ${tag} is too large to read`); continue; }
      const voff = len <= 4 ? e + 8 : r32(e + 8);
      if (voff >= size) continue;   // points outside the file: there is nothing there to leak
      // a value that runs past the end of the file: read (and later blank) the part that is there
      const avail = Math.min(len, size - voff), n2 = avail < len ? Math.floor(avail / unit) : count;
      if (len > 4) {
        if (budget < avail) { problem("too much metadata to read"); continue; }
        budget -= avail;
      }
      if (type !== 1 && type !== 2 && type !== 6 && type !== 7 && (decoded += n2) > MAX_DECODED) {
        problem("too many values to read"); continue;
      }
      const raw = data.subarray(base + voff, base + voff + avail);
      if (avail < len && raw.some(b => b !== 0)) problem(`tag ${tag} runs past the end of the file`);
      const entry: Entry = { tag, type, count: n2, raw, value: decode(raw.subarray(0, n2 * unit), type, n2, le), pos: base + voff };
      m.set(tag, entry);
      all.push({ ifd: name, kind, entry });
    }
    const nextPos = off + 2 + n * 12;
    const next = nextPos + 4 <= size ? r32(nextPos) : 0;
    return [m, next, n];
  };

  const dirs: Dir[] = [], seen = new Set<number>();
  const counters: Record<string, number> = { main: 0, exif: 0, gps: 0, interop: 0, sub: 0 };
  const nameFor = (kind: DirKind, chain: number | null): string => {
    if (chain !== null) return String(chain);
    if (kind === "main") return `sub${++counters.sub}`;
    const n = ++counters[kind];
    return n === 1 ? kind : `${kind}${n}`;
  };
  // breadth-first, so IFD0's own Exif/GPS pointers are named "exif"/"gps" before any reached through another directory
  const queue: { off: number; kind: DirKind; chain: number | null }[] = [{ off: r32(4), kind: "main", chain: 0 }];
  for (let qi = 0; qi < queue.length; qi++) {
    const { off, kind, chain } = queue[qi];
    if (off === 0) continue;
    // a pointer into the header or past the end of the file: there is no directory there to hide anything
    if (off < 8 || off + 2 > size) continue;
    if (seen.has(off)) continue;
    if (dirs.length >= MAX_DIRS) { problem("too many directories to read"); break; }
    seen.add(off);
    const name = nameFor(kind, chain);
    const [entries, next, count] = readIfd(off, name, kind);
    dirs.push({ name, kind, off, entries, count });
    for (const [tag, e] of entries) {
      const child = CHILD[tag];
      if (child === undefined) {
        if (e.type === 13) problem(`tag ${tag} points to a directory that isn't read`);
        continue;
      }
      const vals = typeof e.value === "number" ? [e.value] : Array.isArray(e.value) ? e.value as number[] : null;
      if (!vals || (e.type !== 3 && e.type !== 4 && e.type !== 13)) { problem(`tag ${tag} is a directory pointer of the wrong type`); continue; }
      for (const v of vals) {
        if (queue.length >= MAX_DIRS * 4) { problem("too many directories to read"); break; }
        queue.push({ off: v, kind: child, chain: null });
      }
    }
    // the main chain continues to IFD1, IFD2…; a SubIFD can chain to further SubIFDs; other kinds don't chain
    if (next) {
      if (chain !== null) queue.push({ off: next, kind: "main", chain: chain + 1 });
      else if (kind === "main") queue.push({ off: next, kind: "main", chain: null });
    }
  }
  const first = (k: DirKind, name: string) => dirs.find(d => d.kind === k && d.name === name)?.entries ?? new Map<number, Entry>();
  const ifd1 = dirs.find(d => d.name === "1");
  return { le, base, ifd0: first("main", "0"), exif: first("exif", "exif"), gps: first("gps", "gps"), interop: first("interop", "interop"),
    hasIfd1: !!ifd1 && ifd1.count > 0, dirs, all, problems };
}

/** A [start, end) byte range in the parsed buffer. */
export type Range = [number, number];
const nums = (e: Entry | undefined): number[] | null =>
  !e ? null : typeof e.value === "number" ? [e.value] : Array.isArray(e.value) ? e.value as number[] : null;

/** Picture data of every directory: strips and tiles, as absolute ranges, clipped to the buffer and merged. */
export function imageRanges(ex: ExifData, total: number): Range[] {
  const starts: number[] = [], ends: number[] = [];
  for (const d of ex.dirs) {
    for (const [o, l] of [[273, 279], [324, 325]]) {
      const offs = nums(d.entries.get(o));
      if (!offs) continue;
      const lens = nums(d.entries.get(l)) ?? [];
      for (let i = 0; i < offs.length; i++) {
        const s = ex.base + offs[i];
        // an unknown length could run anywhere: treat it as running to the end of the file
        const e = lens[i] === undefined ? total : Math.min(s + lens[i], total);
        if (s < total && e > s) { starts.push(s); ends.push(e); }
      }
    }
  }
  // union of intervals: sweep the sorted starts and ends (typed-array sorts keep millions of strips cheap)
  const S = Float64Array.from(starts).sort(), E = Float64Array.from(ends).sort(), out: Range[] = [];
  let i = 0, j = 0, depth = 0, open = 0;
  while (i < S.length) {
    if (S[i] <= E[j]) { if (depth++ === 0) open = S[i]; i++; }
    else if (--depth === 0) { const last = out[out.length - 1]; if (last && last[1] === open) last[1] = E[j]; else out.push([open, E[j]]); j++; }
    else j++;
  }
  if (S.length) { const end = E[E.length - 1], last = out[out.length - 1]; if (last && last[1] === open) last[1] = end; else out.push([open, end]); }
  return out;
}

/** JPEG previews pointed to by JPEGInterchangeFormat (0x201) / JPEGInterchangeFormatLength (0x202). */
export function previewRanges(ex: ExifData, total: number): { dir: string; range: Range }[] {
  const out: { dir: string; range: Range }[] = [];
  for (const d of ex.dirs) {
    if (d.kind !== "main") continue;
    const o = d.entries.get(0x201)?.value, l = d.entries.get(0x202)?.value;
    if (typeof o !== "number" || typeof l !== "number" || l <= 0) continue;
    const s = ex.base + o;
    if (s < total) out.push({ dir: d.name, range: [s, Math.min(s + l, total)] });
  }
  return out;
}

export function mergeRanges(rs: Range[]): Range[] {
  const s = [...rs].sort((a, b) => a[0] - b[0]), out: Range[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Does [s, e) overlap any of the merged, sorted ranges? */
export function overlaps(rs: Range[], s: number, e: number): boolean {
  let lo = 0, hi = rs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rs[mid][1] <= s) lo = mid + 1;
    else if (rs[mid][0] >= e) hi = mid - 1;
    else return true;
  }
  return false;
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
