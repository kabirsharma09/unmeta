// Lossless cleaning for every supported format. The compressed picture data is never decoded or re-encoded:
// JPEG/PNG/WebP are rebuilt block by block; HEIC/AVIF/TIFF/RAW are blanked in place.
import { type Bytes, ascii, concat, equal, utf8Encode } from "./bytes.ts";
import { blankC2paBoxes, heifItems, itemBytes, writeItem } from "./bmff.ts";
import * as C from "./containers.ts";
import { type Field, type Inventory, inspect } from "./inspect.ts";
import type { Category } from "./taxonomy.ts";
import { type WriteEntry, readExif, shortEntry, writeExif } from "./tiff.ts";
import { buildXmp } from "./xmp.ts";

export interface Options {
  keepCategories: Category[];
  keepFields?: string[];
  dropFields?: string[];
  keepIcc?: boolean | null;   // null/undefined = follow the "technical" category
}

export interface Result {
  data: Bytes;
  before: Inventory;
  after: Inventory;
  removed: Field[];
  kept: Field[];
  verified: boolean;
  residual: Field[];
  pixelsUntouched: boolean;
  notes: string[];
}

export function wants(f: Field, o: Options): boolean {
  if (!f.keepable || o.dropFields?.includes(f.id) || f.id === "exif:0:274") return false;
  if (f.id === "icc:profile" && o.keepIcc != null) return o.keepIcc;
  return !!o.keepFields?.includes(f.id) || o.keepCategories.includes(f.category);
}

export interface Payloads { exif: Bytes | null; xmp: string | null; iim: Bytes | null; icc: Bytes | null; c2pa: boolean; native: Set<string>; intended: Set<string> }

export function payloads(inv: Inventory, o: Options): Payloads {
  const kept = inv.fields.filter(f => wants(f, o));
  const intended = new Set(kept.map(f => f.id));
  // EXIF: copy kept entries verbatim + orientation (so the photo stays upright)
  const ex = inv.exif;
  const le = ex ? ex.le : false;
  const ifd0: WriteEntry[] = [], exif: WriteEntry[] = [], gps: WriteEntry[] = [];
  if (ex) for (const f of kept) {
    if (!f.id.startsWith("exif:")) continue;
    const [, ifd, t] = f.id.split(":");
    const map = ifd === "0" ? ex.ifd0 : ifd === "exif" ? ex.exif : ifd === "gps" ? ex.gps : null;
    const e = map?.get(+t);
    if (!e) continue;
    (ifd === "0" ? ifd0 : ifd === "exif" ? exif : gps).push({ tag: e.tag, type: e.type, count: e.count, raw: e.raw });
  }
  if (inv.orientation > 1 && inv.orientation <= 8) {
    ifd0.push(shortEntry(274, inv.orientation, le));
    intended.add("exif:0:274");
  }
  const exifBlob = ifd0.length || exif.length || gps.length ? writeExif(le, ifd0, exif, gps) : null;
  const xmpProps = inv.xmp.filter(p => intended.has(`xmp:${p.qname}`));
  const iptc = inv.iptc.filter(([r, d]) => intended.has(`iptc:${r}:${d}`));
  if (iptc.length) intended.add("iptc:1:90");
  return {
    exif: exifBlob, xmp: xmpProps.length ? buildXmp(xmpProps) : null, iim: iptc.length ? C.buildIim(iptc) : null,
    icc: inv.icc && intended.has("icc:profile") ? inv.icc : null, c2pa: intended.has("c2pa:manifest"),
    native: new Set(kept.filter(f => f.id.startsWith("png:")).map(f => f.id)), intended,
  };
}

// ---------------------------------------------------------------- rebuilt containers
function cleanJpeg(inv: Inventory, P: Payloads): Bytes {
  const jf = inv.jpeg!;
  const kind = (s: C.Seg) => C.segKind(s);
  // a minimal JFIF header: version, units and density only (no thumbnail, no extra bytes)
  const head: C.Seg[] = jf.header.filter(s => kind(s) === "jfif" && s.payload.length >= 12).slice(0, 1)
    .map(s => ({ marker: 0xe0, payload: concat([s.payload.slice(0, 12), new Uint8Array([0, 0])]) }));
  if (P.exif) head.push({ marker: 0xe1, payload: concat([ascii("Exif\0\0"), P.exif]) });
  if (P.xmp) head.push({ marker: 0xe1, payload: concat([ascii("http://ns.adobe.com/xap/1.0/\0"), utf8Encode(P.xmp)]) });
  if (P.icc) head.push(...C.jpegIccSegs(P.icc));
  if (P.c2pa) head.push(...jf.header.filter(s => kind(s) === "jumbf"));
  if (P.iim) head.push({ marker: 0xed, payload: concat([ascii("Photoshop 3.0\0"), C.buildIrb([[0x0404, P.iim]])]) });
  // Adobe's segment is 12 bytes by the standard; anything after that isn't needed to show the picture
  const ls = C.isJpegLs(jf.header);
  head.push(...jf.header.filter(s => kind(s) === "adobe" || kind(s) === "structural" || (ls && (s.marker === 0xf7 || s.marker === 0xf8)))
    .map(s => (kind(s) === "adobe" ? { marker: s.marker, payload: s.payload.slice(0, 12) } : s)));
  return C.writeJpeg(head, C.splitScan(jf.scan).image);
}

function cleanPng(inv: Inventory, P: Payloads): Bytes {
  const chunks = inv.png!;
  let render = chunks.slice(1).filter(c => C.PNG_RENDER.has(c.type) && c.type !== "IEND");
  const meta: C.Chunk[] = [];
  if (P.icc) { meta.push(C.pngIccp(P.icc)); render = render.filter(c => c.type !== "sRGB"); }
  if (P.exif) meta.push({ type: "eXIf", data: P.exif });
  if (P.xmp) meta.push(C.pngItxt("XML:com.adobe.xmp", P.xmp));
  for (const c of chunks) {
    if (c.type === "tEXt" || c.type === "zTXt" || c.type === "iTXt") {
      if (P.native.has(`png:text:${C.pngText(c)[0]}`)) meta.push(c);
    } else if (c.type === "tIME" && P.native.has("png:tIME")) meta.push(c);
    else if (c.type === "caBX" && P.c2pa) meta.push(c);
  }
  const firstData = render.findIndex(c => c.type === "IDAT" || c.type === "acTL");
  return C.writePng([chunks[0], ...render.slice(0, firstData), ...meta, ...render.slice(firstData), { type: "IEND", data: new Uint8Array(0) }]);
}

function cleanWebp(inv: Inventory, P: Payloads): Bytes {
  const chunks = inv.webp!;
  const out = chunks.filter(c => C.WEBP_IMAGE.has(c.fourcc));
  if (P.icc) out.push({ fourcc: "ICCP", data: P.icc });
  if (P.exif) out.push({ fourcc: "EXIF", data: P.exif });
  if (P.xmp) out.push({ fourcc: "XMP ", data: utf8Encode(P.xmp) });
  if (P.c2pa) out.push(...chunks.filter(c => c.fourcc === "C2PA"));
  const [w, h, alpha] = C.webpSize(chunks);
  return C.writeWebp(out, w, h, alpha);
}

// ---------------------------------------------------------------- in-place blanking
function cleanHeif(src: Bytes, inv: Inventory, P: Payloads, notes: string[]): Bytes {
  const d = src.slice();
  for (const it of heifItems(d)) {
    if (it.type === "Exif" && it.extents.length) {
      const body = P.exif ?? concat([ascii("MM\0*"), new Uint8Array([0, 0, 0, 8, 0, 0, 0, 0, 0, 0])]);
      const blob = concat([new Uint8Array([0, 0, 0, 6]), ascii("Exif\0\0"), body]);
      if (!writeItem(d, it, blob)) {
        writeItem(d, it, concat([new Uint8Array([0, 0, 0, 6]), ascii("Exif\0\0"), ascii("MM\0*"), new Uint8Array([0, 0, 0, 8, 0, 0, 0, 0, 0, 0])]));
        if (P.exif) notes.push("Some details you chose to keep didn't fit and were removed.");
      }
    } else if (it.type === "mime" && /xml/.test(it.contentType) && it.extents.length) {
      if (!P.xmp || !writeItem(d, it, utf8Encode(P.xmp), 0x20)) writeItem(d, it, new Uint8Array(0), 0x20);
    }
  }
  if (!P.c2pa) blankC2paBoxes(d, C.C2PA_UUID);
  return d;
}

function cleanTiff(src: Bytes, inv: Inventory, P: Payloads): Bytes {
  const d = src.slice();
  const magic = String.fromCharCode(d[0], d[1], d[2], d[3]);
  const view = /^(IIRO|IIRS|IIU\0)/.test(magic) ? concat([ascii("II*\0"), d.slice(4)]) : d;
  const ex = readExif(view);
  const zero = (pos: number, len: number) => d.fill(0, pos, pos + len);
  const ids = new Set(inv.fields.map(f => f.id));
  const blankMap = (prefix: string, m: Map<number, { tag: number; pos: number; raw: Bytes }>) => {
    for (const [tag, e] of m) {
      const id = `${prefix}:${tag}`;
      if (!ids.has(id) || P.intended.has(id)) continue;
      const f = inv.fields.find(x => x.id === id)!;
      if (prefix === "exif:0" && !f.keepable && f.category === "technical") continue; // structural
      zero(e.pos, e.raw.length);
    }
  };
  blankMap("exif:0", ex.ifd0);
  blankMap("exif:exif", ex.exif);
  blankMap("exif:gps", ex.gps);
  // blocks stored in TIFF tags
  for (const t of [700, 33723, 34377]) {
    const e = ex.ifd0.get(t);
    if (!e) continue;
    if (t === 700 && P.xmp) {
      const b = utf8Encode(P.xmp);
      if (b.length <= e.raw.length) { d.fill(0x20, e.pos, e.pos + e.raw.length); d.set(b, e.pos); continue; }
    }
    zero(e.pos, e.raw.length);
  }
  const mk = ex.exif.get(0x927c);
  if (mk) zero(mk.pos, mk.raw.length);
  if (!P.c2pa) blankC2paBoxes(d, C.C2PA_UUID);
  return d;
}

// ---------------------------------------------------------------- public API
export function clean(data: Bytes, filename: string, o: Options, before?: Inventory): Result {
  const inv = before ?? inspect(data, filename);
  if (inv.fmt === "unknown") throw new Error("This file type isn't supported.");
  const P = payloads(inv, o);
  const notes: string[] = [];
  let out: Bytes;
  switch (inv.fmt) {
    case "jpeg": out = cleanJpeg(inv, P); break;
    case "png": out = cleanPng(inv, P); break;
    case "webp": out = cleanWebp(inv, P); break;
    case "heif": case "avif": out = cleanHeif(data, inv, P, notes); break;
    default: out = cleanTiff(data, inv, P);
  }
  if (P.c2pa) notes.push("Content Credentials were kept, but they will no longer verify after any change.");
  const after = inspect(out, filename);
  const afterIds = new Set(after.fields.map(f => f.id));
  const residual = after.fields.filter(f => !P.intended.has(f.id) && (f.risk === "medium" || f.risk === "high"));
  return {
    data: out, before: inv, after,
    removed: inv.fields.filter(f => !afterIds.has(f.id)),
    kept: after.fields.filter(f => inv.fields.some(b => b.id === f.id)),
    // never "verified" if anything couldn't be read: unread parts may hold exactly what we were asked to remove
    verified: residual.length === 0 && inv.errors.length === 0 && after.errors.length === 0
      && (after.aiSignals.length === 0 || o.keepCategories.includes("ai") || P.c2pa),
    residual, pixelsUntouched: samePixels(inv, data, out), notes,
  };
}

/** Proof that the picture itself is unchanged: compare the compressed image data. */
export function samePixels(inv: Inventory, a: Bytes, b: Bytes): boolean {
  if (inv.fmt === "jpeg") return equal(C.splitScan(C.parseJpeg(a).scan).image, C.splitScan(C.parseJpeg(b).scan).image);
  if (inv.fmt === "png") {
    const idat = (x: Bytes) => concat(C.parsePng(x).filter(c => c.type === "IDAT" || c.type === "fdAT").map(c => c.data));
    return equal(idat(a), idat(b));
  }
  if (inv.fmt === "webp") {
    const img = (x: Bytes) => concat(C.parseWebp(x).filter(c => ["VP8 ", "VP8L", "ALPH", "ANMF"].includes(c.fourcc)).map(c => c.data));
    return equal(img(a), img(b));
  }
  if (a.length !== b.length) return false;
  if (inv.fmt === "heif" || inv.fmt === "avif") {
    const pics = (x: Bytes) => concat(heifItems(x).filter(i => !["Exif", "mime", "uri "].includes(i.type)).map(i => itemBytes(x, i)));
    return equal(pics(a), pics(b));
  }
  // TIFF/RAW: compare every image strip/tile
  const ex = inv.exif;
  if (!ex) return true;
  const offs = ex.ifd0.get(273) ?? ex.ifd0.get(324), lens = ex.ifd0.get(279) ?? ex.ifd0.get(325);
  if (!offs || !lens) return true;
  const o = ([] as number[]).concat(offs.value as number), l = ([] as number[]).concat(lens.value as number);
  return o.every((off, i) => equal(a.subarray(off, off + l[i]), b.subarray(off, off + l[i])));
}
