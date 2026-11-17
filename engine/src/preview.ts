// Small preview pictures for formats most browsers can't display themselves.
// RAW files carry ready-made JPEG previews; HEIC photos carry an HEVC thumbnail the page can decode with WebCodecs.
// Nothing here decodes pixels: it only finds the preview bytes and the settings needed to show them.
import { type Bytes, u16be, u32be } from "./bytes.ts";
import { boxes, heifItems, itemBytes } from "./bmff.ts";

export type Preview =
  | { type: "jpeg"; data: Bytes }
  | { type: "hevc"; codec: string; description: Bytes; data: Bytes; width: number; height: number; rotate: number };

const MAX_PREVIEW = 16 * 1024 * 1024;

/** The largest ordinary (baseline or progressive) JPEG inside a file, e.g. a RAW file's built-in preview. */
export function embeddedJpeg(d: Bytes, skipStart = false): Bytes | null {
  let best: { at: number; end: number; area: number } | null = null;
  for (let i = skipStart ? 2 : 0; i + 4 < d.length; i++) {
    if (d[i] !== 0xff || d[i + 1] !== 0xd8 || d[i + 2] !== 0xff) continue;
    // walk the segments up to the start of scan; reject lossless (raw sensor) JPEGs
    let p = i + 2, w = 0, h = 0, ok = false;
    while (p + 4 < d.length && d[p] === 0xff) {
      const m = d[p + 1], len = u16be(d, p + 2);
      if (m === 0xc0 || m === 0xc1 || m === 0xc2) { h = u16be(d, p + 5); w = u16be(d, p + 7); }
      if (m === 0xc3 || m === 0xc7 || m === 0xcb || m === 0xcf) break;     // lossless: not displayable
      if (m === 0xda) { ok = w > 0 && h > 0; p += 2 + len; break; }
      if (len < 2) break;
      p += 2 + len;
    }
    if (!ok || w < 160) continue;
    let e = p;
    while (e + 1 < d.length && !(d[e] === 0xff && d[e + 1] === 0xd9)) e++;
    if (e + 1 >= d.length || e + 2 - i > MAX_PREVIEW) continue;
    if (!best || w * h > best.area) best = { at: i, end: e + 2, area: w * h };
    i = e + 1;  // jump past this image (its own thumbnails were inside its header)
  }
  return best ? d.slice(best.at, best.end) : null;
}

/** RFC 6381 codec string for an hvcC configuration, e.g. "hvc1.1.6.L93.B0". */
export function hevcCodec(c: Bytes): string {
  const space = ["", "A", "B", "C"][c[1] >> 6], tier = c[1] & 0x20 ? "H" : "L", profile = c[1] & 31;
  let compat = u32be(c, 2), rev = 0;
  for (let k = 0; k < 32; k++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const cons = [...c.subarray(6, 12)];
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return [`hvc1`, `${space}${profile}`, (rev >>> 0).toString(16).toUpperCase(), `${tier}${c[12]}`,
    ...cons.map(b => b.toString(16).toUpperCase())].join(".");
}

/** The HEVC thumbnail of a HEIC photo (or the picture itself when it is a single small image). */
export function heicThumbnail(d: Bytes): Preview | null {
  const meta = [...boxes(d, 0, d.length)].find(b => b.type === "meta");
  if (!meta) return null;
  const kids = [...boxes(d, meta.body + 4, meta.end)];
  const items = heifItems(d);
  // thumbnails point at the picture they summarise through 'thmb' references
  const thumbs = new Set<number>();
  const iref = kids.find(b => b.type === "iref");
  if (iref) {
    const v = d[iref.body], idSize = v === 0 ? 2 : 4;
    for (const r of boxes(d, iref.body + 4, iref.end)) {
      if (r.type === "thmb") thumbs.add(idSize === 2 ? u16be(d, r.body) : u32be(d, r.body));
    }
  }
  const pitm = kids.find(b => b.type === "pitm");
  const primary = pitm ? (d[pitm.body] === 0 ? u16be(d, pitm.body + 4) : u32be(d, pitm.body + 4)) : -1;
  const candidates = items.filter(it => it.type === "hvc1" && it.extents.length && (thumbs.has(it.id) || it.id === primary));
  // properties: ipco holds them, ipma says which item uses which
  const iprp = kids.find(b => b.type === "iprp");
  if (!iprp || !candidates.length) return null;
  const ip = [...boxes(d, iprp.body, iprp.end)];
  const ipco = ip.find(b => b.type === "ipco"), ipma = ip.find(b => b.type === "ipma");
  if (!ipco || !ipma) return null;
  const props = [...boxes(d, ipco.body, ipco.end)];
  const assoc = new Map<number, number[]>();
  {
    const v = d[ipma.body], flags = d[ipma.body + 3];
    let p = ipma.body + 4;
    const n = u32be(d, p); p += 4;
    for (let i = 0; i < n && p < ipma.end; i++) {
      const id = v < 1 ? u16be(d, p) : u32be(d, p); p += v < 1 ? 2 : 4;
      const count = d[p++], list: number[] = [];
      for (let k = 0; k < count; k++) {
        const idx = flags & 1 ? u16be(d, p) & 0x7fff : d[p] & 0x7f;
        p += flags & 1 ? 2 : 1;
        list.push(idx);
      }
      assoc.set(id, list);
    }
  }
  // prefer a real thumbnail; fall back to the primary picture only if it is a single, small image
  candidates.sort((a, b) => Number(thumbs.has(b.id)) - Number(thumbs.has(a.id)));
  for (const it of candidates) {
    const mine = (assoc.get(it.id) ?? []).map(i => props[i - 1]).filter(Boolean);
    const hvcC = mine.find(b => b.type === "hvcC"), ispe = mine.find(b => b.type === "ispe"), irot = mine.find(b => b.type === "irot");
    if (!hvcC || !ispe) continue;
    const width = u32be(d, ispe.body + 4), height = u32be(d, ispe.body + 8);
    if (!thumbs.has(it.id) && width * height > 1024 * 1024) continue;
    const data = itemBytes(d, it);
    if (!data.length || data.length > MAX_PREVIEW) continue;
    return { type: "hevc", codec: hevcCodec(d.subarray(hvcC.body, hvcC.end)), description: d.slice(hvcC.body, hvcC.end),
      data, width, height, rotate: irot ? (d[irot.body] & 3) * 90 : 0 };
  }
  return null;
}

/** A preview for formats browsers can't show natively, or null when the browser can show the file itself. */
export function previewFor(fmt: string, d: Bytes): Preview | null {
  try {
    if (fmt === "heif") return heicThumbnail(d);
    if (fmt === "raw" || fmt === "tiff") {
      const jpg = embeddedJpeg(d);
      return jpg ? { type: "jpeg", data: jpg } : null;
    }
  } catch { /* a damaged file just gets no preview */ }
  return null;
}
