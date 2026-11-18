// ISO-BMFF (HEIC/HEIF/AVIF) item locator: finds Exif and XMP items so they can be read and blanked in place.
import { type Bytes, latin1, u16be, u32be } from "./bytes.ts";

export interface Box { type: string; start: number; body: number; end: number }

export function* boxes(d: Bytes, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32be(d, pos), hdr = 8;
    const type = latin1(d, pos + 4, pos + 8);
    if (size === 1) { size = u32be(d, pos + 8) * 2 ** 32 + u32be(d, pos + 12); hdr = 16; }
    else if (size === 0) size = end - pos;
    if (size < hdr || pos + size > end) return;
    yield { type, start: pos, body: pos + hdr, end: pos + size };
    pos += size;
  }
}

export interface Item { id: number; type: string; contentType: string; extents: [number, number][] }

/** The message for a photo whose item table can't be trusted (see heifItemTable). */
export const ITEM_TABLE_CONFLICT = "This photo's item table lists the same item more than once, so UnMeta can't tell which copy of its details is real.";

function readN(d: Bytes, o: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + d[o + i];
  return v;
}

/** Return the items of the top-level meta box with absolute byte extents. */
/** The items, plus whether the item table is ambiguous (an ID listed twice). Conflicting items are left out, and the
 *  caller must treat the photo as unverifiable: there's no way to tell which copy a reader will use. */
export function heifItemTable(d: Bytes): { items: Item[]; conflict: boolean } {
  let conflict = false;
  const items = heifItemsInner(d, () => { conflict = true; });
  return { items, conflict };
}

export function heifItems(d: Bytes): Item[] {
  return heifItemsInner(d, () => {});
}

function heifItemsInner(d: Bytes, onConflict: () => void): Item[] {
  const meta = [...boxes(d, 0, d.length)].find(b => b.type === "meta");
  if (!meta) return [];
  const kids = [...boxes(d, meta.body + 4, meta.end)];
  const items = new Map<number, Item>();
  // An id listed twice (in iinf or iloc) is ambiguous: readers disagree about which entry wins, and a decoy entry
  // could hide the real Exif. Never pick one: leave those items out entirely and report the table as unreadable.
  const conflicts = new Set<number>();
  const iinf = kids.find(b => b.type === "iinf");
  if (iinf) {
    const v = d[iinf.body];
    const first = iinf.body + 4 + (v === 0 ? 2 : 4);
    for (const infe of boxes(d, first, iinf.end)) {
      if (infe.type !== "infe") continue;
      const iv = d[infe.body];
      if (iv < 2) continue;
      let p = infe.body + 4;
      const id = iv === 2 ? u16be(d, p) : u32be(d, p);
      p += iv === 2 ? 2 : 4;
      p += 2; // protection index
      const type = latin1(d, p, p + 4);
      p += 4;
      const z1 = d.indexOf(0, p);
      p = z1 + 1;
      let contentType = "";
      if (type === "mime") { const z2 = d.indexOf(0, p); contentType = latin1(d, p, z2 < 0 ? infe.end : z2); }
      if (items.has(id)) conflicts.add(id);
      items.set(id, { id, type, contentType, extents: [] });
    }
  }
  const idat = kids.find(b => b.type === "idat");
  const iloc = kids.find(b => b.type === "iloc");
  if (iloc) {
    const v = d[iloc.body];
    let p = iloc.body + 4;
    const offSize = d[p] >> 4, lenSize = d[p] & 15, baseSize = d[p + 1] >> 4, idxSize = v > 0 ? d[p + 1] & 15 : 0;
    p += 2;
    const count = v < 2 ? u16be(d, p) : u32be(d, p);
    p += v < 2 ? 2 : 4;
    const located = new Set<number>();
    for (let i = 0; i < count && p < iloc.end; i++) {   // stop at the end of the box: a huge count can't spin
      const id = v < 2 ? u16be(d, p) : u32be(d, p);
      p += v < 2 ? 2 : 4;
      let method = 0;
      if (v > 0) { method = u16be(d, p) & 15; p += 2; }
      p += 2; // data reference index
      const base = readN(d, p, baseSize);
      p += baseSize;
      const n = u16be(d, p);
      p += 2;
      const ext: [number, number][] = [];
      for (let k = 0; k < n; k++) {
        p += idxSize;
        const off = readN(d, p, offSize); p += offSize;
        const len = readN(d, p, lenSize); p += lenSize;
        const origin = method === 1 && idat ? idat.body : 0;
        // the end of what this extent can refer to: the file (method 0) or the idat box (method 1)
        const limit = method === 1 ? (idat ? idat.end : 0) : d.length;
        const s = origin + base + off;
        // a length of 0 means "the rest of the source" (ISO/IEC 14496-12): for the last extent, run to its end
        let l = len === 0 && k === n - 1 ? limit - s : len;
        // never trust a length past the end of the data: clamp (keeps reads and allocations bounded)
        if (!(s < limit) || !(l > 0)) l = 0; else l = Math.min(l, limit - s);
        ext.push([s, l]);
      }
      if (located.has(id)) conflicts.add(id);
      located.add(id);
      const it = items.get(id);
      if (it && method !== 2) it.extents = ext;
    }
  }
  for (const id of conflicts) items.delete(id);
  if (conflicts.size) onConflict();
  return [...items.values()];
}

export function itemBytes(d: Bytes, it: Item): Bytes {
  const total = it.extents.reduce((n, [, l]) => n + l, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const [off, len] of it.extents) { out.set(d.subarray(off, off + len), o); o += len; }
  return out;
}

/** Overwrite an item's payload in place (padding with `pad`); returns false if `data` doesn't fit. */
export function writeItem(d: Bytes, it: Item, data: Bytes, pad = 0): boolean {
  const total = it.extents.reduce((n, [, l]) => n + l, 0);
  if (data.length > total) return false;
  let o = 0;
  for (const [off, len] of it.extents) {
    for (let i = 0; i < len; i++, o++) d[off + i] = o < data.length ? data[o] : pad;
  }
  return true;
}

/** Turn every top-level C2PA uuid box into a zero-filled 'free' box (keeps all offsets valid). */
export function blankC2paBoxes(d: Bytes, uuid: Bytes): number {
  let n = 0;
  for (const b of boxes(d, 0, d.length)) {
    if (b.type !== "uuid") continue;
    let match = true;
    for (let i = 0; i < 16; i++) if (d[b.body + i] !== uuid[i]) { match = false; break; }
    if (!match) continue;
    d.set([0x66, 0x72, 0x65, 0x65], b.start + 4); // "free"
    d.fill(0, b.body, b.end);
    n++;
  }
  return n;
}
