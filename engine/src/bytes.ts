// Small, dependency-free byte helpers (Hermes-safe: no Buffer, no TextDecoder requirement).

export type Bytes = Uint8Array;

export function concat(parts: Bytes[]): Bytes {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const u16be = (b: Bytes, o: number) => (b[o] << 8) | b[o + 1];
export const u16le = (b: Bytes, o: number) => b[o] | (b[o + 1] << 8);
export const u32be = (b: Bytes, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
export const u32le = (b: Bytes, o: number) => ((b[o + 3] << 24) >>> 0) + (b[o + 2] << 16) + (b[o + 1] << 8) + b[o];

export function be16(n: number): Bytes { return new Uint8Array([(n >> 8) & 255, n & 255]); }
export function be32(n: number): Bytes { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
export function le32(n: number): Bytes { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }

export function ascii(s: string): Bytes {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}
export function latin1(b: Bytes, start = 0, end = b.length): string {
  // never trust a length read from a file: clamp to the bytes that exist
  start = Math.max(0, start); end = Math.min(end, b.length);
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function utf8Encode(str: string): Bytes {
  const out: number[] = [];
  for (const ch of str) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

/** Strict UTF-8 decode; returns null if the bytes are not valid UTF-8. */
export function utf8DecodeStrict(b: Bytes, start = 0, end = b.length): string | null {
  start = Math.max(0, start); end = Math.min(end, b.length);
  let s = "";
  for (let i = start; i < end;) {
    const c = b[i];
    let cp: number, n: number;
    if (c < 0x80) { cp = c; n = 1; }
    else if ((c & 0xe0) === 0xc0) { cp = c & 31; n = 2; }
    else if ((c & 0xf0) === 0xe0) { cp = c & 15; n = 3; }
    else if ((c & 0xf8) === 0xf0) { cp = c & 7; n = 4; }
    else return null;
    if (i + n > end) return null;
    for (let k = 1; k < n; k++) {
      if ((b[i + k] & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (b[i + k] & 63);
    }
    s += String.fromCodePoint(cp);
    i += n;
  }
  return s;
}
export function utf8Decode(b: Bytes, start = 0, end = b.length): string {
  return utf8DecodeStrict(b, start, end) ?? latin1(b, start, end);
}

export function startsWith(b: Bytes, prefix: Bytes | string, at = 0): boolean {
  const p = typeof prefix === "string" ? ascii(prefix) : prefix;
  if (b.length < at + p.length) return false;
  for (let i = 0; i < p.length; i++) if (b[at + i] !== p[i]) return false;
  return true;
}

export function indexOf(b: Bytes, needle: Bytes | string, from = 0, limit = b.length): number {
  const n = typeof needle === "string" ? ascii(needle) : needle;
  const last = Math.min(limit, b.length) - n.length;
  outer: for (let i = from; i <= last; i++) {
    if (b[i] !== n[0]) continue;
    for (let k = 1; k < n.length; k++) if (b[i + k] !== n[k]) continue outer;
    return i;
  }
  return -1;
}

export function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let CRC_TABLE: Uint32Array | null = null;
export function crc32(b: Bytes): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
