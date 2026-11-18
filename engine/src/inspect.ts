// Turn image bytes into an inventory of metadata fields. Mirrors metaclean/inspector.py.
import { type Bytes, ascii, concat, indexOf, latin1, startsWith, u32be, utf8Decode } from "./bytes.ts";
import * as C from "./containers.ts";
import { EXIF_TAGS, GPS_TAGS } from "./exifTags.ts";
import {
  AI_PNG_KEYS, AI_SOURCE_TYPES, CATEGORIES, type Category, FRIENDLY, IPTC_NAMES, type Risk, classifyExif, classifyIptc,
  classifyXmp, isAiText, maxRisk,
} from "./taxonomy.ts";
import { type ExifData, type Entry, IFD_EXIF, IFD_GPS, IFD_INTEROP, gpsDecimal, previewRanges, readExif } from "./tiff.ts";
import { type XmpProp, parseXmp } from "./xmp.ts";
import { ITEM_TABLE_CONFLICT, heifItemTable, itemBytes } from "./bmff.ts";

export interface Field {
  id: string; category: Category; source: string; name: string; label: string; value: string; risk: Risk; keepable: boolean; note: string;
  /** Shown to the person but never removed or changed (comments, tracked changes…); never counts against verification. */
  informational?: boolean;
}
export interface AiSignal { signal: string; verdict: string; detail: string; risk: Risk; read_by: string }
export type Kind = "photo" | "video" | "audio";
export interface Inventory {
  filename: string; fmt: C.Format; kind?: Kind; size: number; width: number; height: number; orientation: number;
  fields: Field[]; aiSignals: AiSignal[]; gps: [number, number] | null; errors: string[];
  exif: ExifData | null; xmp: XmpProp[]; iptc: C.Dataset[]; icc: Bytes | null; c2pa: C.C2paSummary[];
  jpeg?: C.JpegFile; png?: C.Chunk[]; webp?: C.Riff[];
}
export interface Report {
  filename: string; format: C.Format; kind: Kind; size_bytes: number; width: number; height: number; orientation: number;
  gps: [number, number] | null; overall_risk: Risk; field_count: number;
  groups: Record<Category, { title: string; risk: Risk; count: number; fields: Field[] }>;
  ai_signals: AiSignal[]; errors: string[]; notes: string[];
}

const POINTER_TAGS = new Set([IFD_EXIF, IFD_GPS, IFD_INTEROP, 0x014a, 0x0201, 0x0202, 700, 33723, 34377, 34675]);
/** Tags a decoder needs to draw the picture (TIFF baseline/extension, JPEG-in-TIFF, TIFF/EP raw layout). */
const STRUCTURAL = new Set([254, 255, 256, 257, 258, 259, 262, 263, 266, 273, 277, 278, 279, 280, 281, 284, 290, 291, 292, 293,
  317, 320, 322, 323, 324, 325, 332, 334, 336, 338, 339, 340, 341, 342, 347, 512, 515, 517, 518, 519, 520, 521, 530, 531, 532,
  32997, 32998, 33421, 33422, 37399, 50706, 50707]);
/** Blocks stored in TIFF tags (XMP, IPTC, Photoshop resources): read and removed as a whole. */
export const BLOCK_TAGS = new Set([700, 33723, 34377]);
/** Interop IFD tags the Exif standard defines; anything else there is out of place. */
const INTEROP_STD = new Set([1, 2, 0x1000, 0x1001, 0x1002]);
const trim = (s: string, n = 400) => { s = s.replace(/\0/g, ""); return s.length <= n ? s : `${s.slice(0, n)}… (+${s.length - n} chars)`; };
export const F = (id: string, category: Category, source: string, name: string, label: string, value: string, risk: Risk,
  keepable = true, note = "", informational = false): Field =>
  ({ id, category, source, name, label, value: trim(value), risk, keepable, note, ...(informational ? { informational: true } : {}) });

export function exifText(name: string, e: Entry): string {
  const v = e.value;
  if (v instanceof Uint8Array) {
    if (name === "UserComment" && v.length >= 8) {
      const prefix = latin1(v, 0, 8);
      if (prefix.startsWith("UNICODE")) {
        let s = "";
        for (let i = 8; i + 1 < v.length; i += 2) s += String.fromCharCode((v[i] << 8) | v[i + 1]);
        return s.replace(/\0/g, "").trim();
      }
      return utf8Decode(v, 8).replace(/\0/g, "").trim();
    }
    if (name.startsWith("XP")) {
      let s = "";
      for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode(v[i] | (v[i + 1] << 8));
      return s.replace(/\0/g, "");
    }
    if (name === "MakerNote") return `<${v.length} bytes of vendor data>`;
    const s = utf8Decode(v).replace(/\0+$/, "");
    return /^[\x20-\x7e\t\r\n -￿]*$/.test(s) ? s.trim() : `<${v.length} bytes>`;
  }
  const fmt = (x: unknown) => typeof x === "number"
    ? (name === "ExposureTime" && x > 0 && x < 1 ? `1/${Math.round(1 / x)} s` : String(Number.isInteger(x) ? x : +x.toPrecision(6)))
    : String(x);
  if (Array.isArray(v)) {
    if (name.startsWith("XP")) return String.fromCharCode(...v.filter((_, i) => i % 2 === 0)).replace(/\0/g, "");
    return v.map(fmt).join(", ");
  }
  return fmt(v).replace(/\0/g, "").trim();
}

const blank = (e: Entry) => e.raw.every(b => b === 0);
// RAW developers need these to decode colours, so they are never blanked in RAW files.
const RAW_REQUIRED = new Set([271, 272, 50708]);
/** DNG tags that are private rather than needed for development: camera serial, original file name, vendor data, raw ID,
 *  display-only camera name and label, and when/what made the preview. */
const DNG_PRIVATE: Record<number, [Category, Risk]> = { 50735: ["device", "high"], 50827: ["personal", "medium"],
  50828: ["personal", "medium"], 50740: ["device", "medium"], 50781: ["device", "low"], 50709: ["device", "medium"],
  51081: ["device", "medium"], 50971: ["personal", "medium"], 50966: ["ai", "medium"], 50967: ["ai", "medium"] };
const tagName = (tag: number) => EXIF_TAGS[tag] ?? `Tag0x${tag.toString(16).toUpperCase().padStart(4, "0")}`;

/** How a tag in a main directory (IFD0, IFD1…, SubIFD) is treated. Structural tags are needed to draw the picture and
 *  are never changed. DNG tags (50706–52599) are needed to develop the raw, except the private ones listed above; the
 *  Photoshop/Camera Raw private tags above that (0xFDE8 OwnerName, 0xFDE9 SerialNumber…) are classified like any other. */
export function mainTag(fmt: string, tag: number, name: string, text: string): { structural: boolean; cat: Category; risk: Risk } {
  const dngPrivate = DNG_PRIVATE[tag];
  if (dngPrivate) return { structural: false, cat: dngPrivate[0], risk: dngPrivate[1] };
  if (STRUCTURAL.has(tag) || (tag >= 50706 && tag < 52600) || (fmt === "raw" && RAW_REQUIRED.has(tag)))
    return { structural: true, cat: "technical", risk: "none" };
  const [cat, risk] = classifyExif(name, text);
  return { structural: false, cat, risk };
}

function readExifInto(inv: Inventory, ex: ExifData, source = "EXIF") {
  inv.exif = ex;
  for (const dir of ex.dirs) {
    const { name: ifd, kind, entries } = dir;
    if (kind === "gps") {
      if (ifd === "gps" && [...entries.values()].some(e => !blank(e))) inv.gps = gpsDecimal(entries);
      for (const [tag, e] of entries) {
        if (blank(e)) continue;
        const name = GPS_TAGS[tag] ?? `GPS0x${tag.toString(16)}`;
        inv.fields.push(F(`exif:${ifd}:${tag}`, "location", source, name, FRIENDLY[name] ?? name, exifText(name, e),
          name === "GPSVersionID" ? "low" : "high"));
      }
      continue;
    }
    for (const [tag, e] of entries) {
      if (blank(e) || (POINTER_TAGS.has(tag) && !BLOCK_TAGS.has(tag) && tag !== 34675)) continue;
      // blocks (XMP, IPTC, Photoshop) in IFD0 are read on their own; anywhere else they're always removed
      if (BLOCK_TAGS.has(tag) || tag === 34675) {
        if (ifd === "0" || tag === 34675) continue;
        inv.fields.push(F(`exif:${ifd}:${tag}`, "other", source, tagName(tag), "Metadata block in a secondary directory",
          `${e.raw.length.toLocaleString("en-US")} bytes`, "medium", false));
        continue;
      }
      if (kind === "interop") {
        const name = tag === 1 ? "InteroperabilityIndex" : tag === 2 ? "InteroperabilityVersion" : tagName(tag);
        // only the standard Interop tags are technical; anything else hidden there is classified, never trusted
        const [cat, risk] = INTEROP_STD.has(tag) ? ["technical", "none"] as [Category, Risk] : classifyExif(name, exifText(name, e));
        const [c, r] = !INTEROP_STD.has(tag) && cat === "technical" ? ["other", "low"] as [Category, Risk] : [cat, risk];
        inv.fields.push(F(`exif:${ifd}:${tag}`, c, source, name, FRIENDLY[name] ?? name, exifText(name, e), r));
        continue;
      }
      const name = tagName(tag);
      const text = exifText(name, e);
      if (kind === "exif") {
        const [cat, risk] = classifyExif(name, text);
        const mk = tag === 0x927c;
        inv.fields.push(F(`exif:${ifd}:${tag}`, cat, source, name, FRIENDLY[name] ?? name, text, risk, !mk,
          mk ? "Vendor-private block; may hide serial numbers or location. Always removed." : ""));
        continue;
      }
      // main directories: IFD0, the rest of the IFD chain and SubIFDs
      if (ifd === "0" && tag === 274 && typeof e.value === "number") inv.orientation = e.value;
      const { structural, cat, risk } = mainTag(inv.fmt, tag, name, text);
      // later directories (thumbnails, pages, raw data) only list what is private; their picture tags are never touched
      if (ifd !== "0" && (structural || cat === "technical")) continue;
      inv.fields.push(F(`exif:${ifd}:${tag}`, cat, source, name, FRIENDLY[name] ?? name, text, risk, !structural && tag !== 50740));
    }
  }
  if (ex.hasIfd1) inv.fields.push(F("exif:thumbnail", "personal", source, "ThumbnailImage", "Embedded thumbnail",
    "IFD1 preview image", "medium", false, "A thumbnail can show the original, un-cropped or un-edited picture."));
}

/** JPEG previews inside a TIFF/RAW (JPEGInterchangeFormat): list what each one carries, under its own ids. */
function readPreviewsInto(inv: Inventory, d: Bytes, ex: ExifData) {
  for (const { dir, range: [s, e] } of previewRanges(ex, d.length)) {
    const sub = d.subarray(s, e);
    if (!sub.some(b => b !== 0)) continue;
    if (!(sub[0] === 0xff && sub[1] === 0xd8)) {
      inv.errors.push(`An embedded preview (directory ${dir}) isn't a JPEG the cleaner can read, so it may still hold hidden details.`);
      continue;
    }
    const p = inspect(sub, "preview.jpg");
    for (const err of p.errors) inv.errors.push(`Embedded preview (directory ${dir}): ${err}`);
    for (const f of p.fields) {
      if (f.category === "technical") continue;
      inv.fields.push({ ...f, id: `preview:${dir}:${f.id}`, source: `Preview ${f.source}`, keepable: false,
        note: "Inside the embedded preview picture. Always removed." });
    }
  }
}

export function readXmpInto(inv: Inventory, packet: string) {
  inv.xmp = parseXmp(packet);
  for (const p of inv.xmp) {
    const [cat, risk] = classifyXmp(p.qname, p.value);
    let label = p.qname.split(":").slice(1).join(":"), note = "";
    if (p.qname === "Iptc4xmpExt:DigitalSourceType") {
      const key = p.value.replace(/\/+$/, "").split("/").pop()!;
      label = "Digital source type (IPTC)";
      note = AI_SOURCE_TYPES[key]?.[0] ?? "Unknown source type";
    }
    inv.fields.push(F(`xmp:${p.qname}`, cat, "XMP", p.qname, label, p.value, risk, p.kind !== "struct", note));
  }
}

function readIptcInto(inv: Inventory, iim: Bytes) {
  inv.iptc = C.parseIim(iim);
  for (const [rec, ds, v] of inv.iptc) {
    const name = IPTC_NAMES[`${rec}:${ds}`] ?? `IIM ${rec}:${ds}`;
    const text = utf8Decode(v);
    const [cat, risk] = classifyIptc(rec, ds, text);
    inv.fields.push(F(`iptc:${rec}:${ds}`, cat, "IPTC", name, name, text, risk, rec === 2 && ds !== 0));
  }
}

export function readC2paInto(inv: Inventory, blob: Bytes) {
  const s = C.summarizeC2pa(blob);
  inv.c2pa.push(s);
  if (inv.fields.some(f => f.id === "c2pa:manifest")) return;
  const parts: string[] = [];
  if (s.claim_generator) parts.push(`generator: ${s.claim_generator}`);
  if (s.generator_info) parts.push("tools: " + s.generator_info.join(", "));
  if (s.digital_source_type) parts.push("source: " + s.digital_source_type.join(", "));
  if (s.actions) parts.push("actions: " + s.actions.join(", "));
  parts.push(`${s.bytes.toLocaleString("en-US")} bytes, signed manifest`);
  inv.fields.push(F("c2pa:manifest", "ai", "C2PA", "C2PA manifest", "Content Credentials (C2PA)", parts.join("; "), "high", true,
    "Signed provenance record read by LinkedIn, TikTok, Google and Adobe. Any edit to the file invalidates its signature."));
}

function readIccInto(inv: Inventory, icc: Bytes) {
  inv.icc = icc;
  let desc = "";
  const i = indexOf(icc, "desc", 128, 128 + 12 * 64);
  if (i > 0) {
    const off = u32be(icc, i + 4), len = u32be(icc, i + 8);
    const tag = icc.slice(off, off + len);
    if (startsWith(tag, "desc")) desc = latin1(tag, 12, Math.min(tag.length, 12 + Math.min(u32be(tag, 8), 256))).replace(/\0/g, "");
    else if (startsWith(tag, "mluc")) {
      const sl = Math.min(u32be(tag, 20), 256), so = u32be(tag, 24);
      for (let k = 0; k + 1 < sl && so + k + 1 < tag.length; k += 2) desc += String.fromCharCode((tag[so + k] << 8) | tag[so + k + 1]);
    }
  }
  inv.fields.push(F("icc:profile", "technical", "ICC", "ICCProfile", "Colour profile",
    `${desc.trim() || "embedded profile"} (${icc.length.toLocaleString("en-US")} bytes)`, "low", true,
    "Keeps colours accurate (e.g. Display P3). Removing it can shift colours."));
}

// ---------------------------------------------------------------- formats
function inspectJpeg(inv: Inventory, d: Bytes) {
  const jf = C.parseJpeg(d);
  inv.jpeg = jf;
  [inv.width, inv.height] = C.jpegSize(jf.header);
  const jumbf: Bytes[] = [];
  let extXmp = false;
  for (const s of jf.header) {
    const k = C.segKind(s);
    if (k === "exif") {
      try { readExifInto(inv, readExif(s.payload)); }
      catch (e) { inv.errors.push(`EXIF parse error: ${e}`); }
    } else if (k === "xmp") readXmpInto(inv, utf8Decode(s.payload, 29));
    else if (k === "xmp_ext" && !extXmp) {
      extXmp = true;
      inv.fields.push(F("jpeg:xmp_extended", "other", "XMP", "ExtendedXMP", "Extended XMP",
        "Large XMP overflow (often depth maps, edit history or gain maps)", "medium", false));
    } else if (k === "photoshop") {
      const others: string[] = [];
      for (const [id, data] of C.parseIrb(s.payload.slice(14))) {
        if (id === 0x0404) readIptcInto(inv, data);
        else if (id !== 0x0425) others.push(id === 0x040c || id === 0x0409 ? "Thumbnail" : `0x${id.toString(16).padStart(4, "0")}`);
      }
      if (others.length) inv.fields.push(F("jpeg:photoshop_irb", "other", "Photoshop", "PhotoshopIRB", "Photoshop resources",
        others.join(", "), others.includes("Thumbnail") ? "medium" : "low", false));
    } else if (k === "jumbf") jumbf.push(s.payload.slice(8));
    else if (k === "comment") {
      const text = utf8Decode(s.payload), ai = isAiText(text);
      inv.fields.push(F("jpeg:comment", ai ? "ai" : "other", "JPEG", "Comment", "JPEG comment", text, ai ? "high" : "low"));
    } else if (k === "mpf") inv.fields.push(F("jpeg:mpf", "other", "JPEG", "MPF", "Multi-picture data",
      "Secondary images (depth map, HDR gain map or preview)", "medium", false));
    else if (k === "jfxx") inv.fields.push(F("jpeg:jfxx", "personal", "JPEG", "JFXX", "JFIF thumbnail", "Embedded thumbnail", "medium", false));
    else if (k === "jfif") {
      if (s.payload.length > 14 || (s.payload.length >= 14 && s.payload[12] * s.payload[13] > 0))
        inv.fields.push(F("exif:thumbnail", "personal", "JPEG", "JFIFThumbnail", "Embedded thumbnail", "Preview image in the JFIF header", "medium", false,
          "A thumbnail can show the original, un-cropped or un-edited picture."));
    } else if (k === "adobe") {
      if (s.payload.length > 12) inv.fields.push(F("jpeg:adobe_extra", "other", "JPEG", "APP14", "Extra data in the Adobe segment",
        `${(s.payload.length - 12).toLocaleString("en-US")} bytes`, "medium", false));
    } else if (k.startsWith("marker_") && !(C.isJpegLs(jf.header) && (s.marker === 0xf7 || s.marker === 0xf8))) {
      inv.fields.push(F(`jpeg:${k}`, "other", "JPEG", k, "Unknown block", `${s.payload.length.toLocaleString("en-US")} bytes`, "medium", false));
    } else if (k.startsWith("app")) {
      const z = s.payload.slice(0, 24).indexOf(0);
      const ident = latin1(s.payload, 0, z < 0 ? Math.min(24, s.payload.length) : z);
      inv.fields.push(F(`jpeg:${k}:${ident}`, "other", "JPEG", k.toUpperCase(), `${k.toUpperCase()} segment`,
        `${ident || "unnamed"} (${s.payload.length.toLocaleString("en-US")} bytes)`, "low", false));
    }
  }
  // blocks hidden between progressive scans, where a cleaner that stops at the first scan would never look
  const hidden = C.splitScan(jf.scan).hidden;
  if (hidden.length) {
    const text = hidden.filter(h => h.marker === 0xfe).map(h => utf8Decode(h.payload)).join(" ").trim();
    inv.fields.push(F("jpeg:scan_blocks", isAiText(text) ? "ai" : "other", "JPEG", "ScanBlocks", "Hidden blocks inside the picture data",
      text || `${hidden.length} block${hidden.length > 1 ? "s" : ""}`, isAiText(text) ? "high" : "medium", false));
  }
  const icc = C.jpegIcc(jf.header);
  if (icc) readIccInto(inv, icc);
  if (jumbf.length) readC2paInto(inv, concat(jumbf));
  if (jf.trailer.some(b => b !== 0)) {
    const t = jf.trailer;
    const what = indexOf(t, "ftyp", 0, 64) >= 0 || indexOf(d, "MotionPhoto", 0, 65536) >= 0 ? "motion-photo video" : "extra data";
    inv.fields.push(F("jpeg:trailer", "other", "JPEG", "Trailer", "Data after end of image",
      `${t.length.toLocaleString("en-US")} bytes of ${what}`, "medium", false,
      "Appended images or video (e.g. phone motion photos) can leak an un-edited version."));
  }
}

function inspectPng(inv: Inventory, d: Bytes) {
  const chunks = C.parsePng(d);
  inv.png = chunks;
  const ihdr = chunks.find(c => c.type === "IHDR");
  if (ihdr) { inv.width = u32be(ihdr.data, 0); inv.height = u32be(ihdr.data, 4); }
  for (const c of chunks) {
    const t = c.type;
    if (C.PNG_RENDER.has(t)) continue;
    if (t === "eXIf") {
      try { readExifInto(inv, readExif(c.data)); } catch (e) { inv.errors.push(`EXIF parse error: ${e}`); }
    } else if (t === "iCCP") {
      try { readIccInto(inv, C.pngIcc(c)); } catch (e) { inv.errors.push(`ICC error: ${e}`); }
    } else if (t === "tEXt" || t === "zTXt" || t === "iTXt") {
      const [key, text] = C.pngText(c);
      if (key === "XML:com.adobe.xmp") { readXmpInto(inv, text); continue; }
      const k = key.toLowerCase();
      if (k === "raw profile type exif" || k === "raw profile type app1") {
        inv.fields.push(F(`png:text:${key}`, "other", "PNG", key, "Legacy EXIF text block", `${text.length} chars`, "medium"));
        continue;
      }
      const ai = (AI_PNG_KEYS.has(k) && (k !== "comment" || isAiText(text))) || isAiText(text);
      let cat: Category, risk: Risk;
      if (ai) [cat, risk] = ["ai", "high"];
      else if (["author", "copyright", "description", "title", "creation time", "comment", "disclaimer", "source"].includes(k)) [cat, risk] = ["personal", "medium"];
      else if (k === "software") [cat, risk] = ["ai", "medium"];
      else [cat, risk] = ["other", "low"];
      const label = (Object.assign(Object.create(null), { parameters: "Generation parameters (Stable Diffusion)", prompt: "ComfyUI prompt graph", workflow: "ComfyUI workflow" }) as Record<string, string>)[k] ?? key;
      inv.fields.push(F(`png:text:${key}`, cat, "PNG", key, label, text, risk));
    } else if (t === "tIME") {
      const b = c.data, p = (n: number) => String(n).padStart(2, "0");
      inv.fields.push(F("png:tIME", "personal", "PNG", "tIME", "Last modified",
        `${(b[0] << 8) | b[1]}-${p(b[2])}-${p(b[3])} ${p(b[4])}:${p(b[5])}:${p(b[6])}`, "low"));
    } else if (t === "caBX") readC2paInto(inv, c.data);
    else if (t[0] === t[0].toLowerCase()) inv.fields.push(F(`png:chunk:${t}`, "other", "PNG", t, `Private chunk ${t}`,
      `${c.data.length.toLocaleString("en-US")} bytes`, "low", false));
  }
}

function inspectWebp(inv: Inventory, d: Bytes) {
  const chunks = C.parseWebp(d);
  inv.webp = chunks;
  [inv.width, inv.height] = C.webpSize(chunks);
  for (const c of chunks) {
    if (C.WEBP_IMAGE.has(c.fourcc)) continue;
    if (c.fourcc === "EXIF") {
      try { readExifInto(inv, readExif(c.data)); } catch (e) { inv.errors.push(`EXIF parse error: ${e}`); }
    } else if (c.fourcc === "XMP ") readXmpInto(inv, utf8Decode(c.data));
    else if (c.fourcc === "ICCP") readIccInto(inv, c.data);
    else if (c.fourcc === "C2PA") readC2paInto(inv, c.data);
    else {
      const n = c.fourcc.trim();
      inv.fields.push(F(`webp:chunk:${n}`, "other", "WebP", n, `Chunk ${n}`, `${c.data.length.toLocaleString("en-US")} bytes`, "low", false));
    }
  }
}

function heifExif(inv: Inventory, d: Bytes): boolean {
  const { items, conflict } = heifItemTable(d);
  if (conflict) inv.errors.push(ITEM_TABLE_CONFLICT);   // an ID listed twice: never call this photo clean
  if (!items.length) return conflict;
  for (const it of items) {
    if (it.type === "Exif" && it.extents.length) {
      const b = itemBytes(d, it);
      const start = 4 + u32be(b, 0);
      const tiff = start < b.length ? b.slice(start) : b;
      if (tiff.some(x => x !== 0)) {
        try { readExifInto(inv, readExif(tiff)); } catch (e) { inv.errors.push(`EXIF parse error: ${e}`); }
      }
    } else if (it.type === "mime" && /xml/.test(it.contentType) && it.extents.length) {
      readXmpInto(inv, utf8Decode(itemBytes(d, it)));
    }
  }
  let p = 0, area = 0;
  while ((p = indexOf(d, "ispe", p + 1, Math.min(d.length, 1 << 20))) > 0) {
    const w = u32be(d, p + 8), h = u32be(d, p + 12);
    if (w * h > area) { area = w * h; inv.width = w; inv.height = h; }
  }
  return true;
}

/** HEIF/AVIF/TIFF/RAW: no full decoder on-device, so locate the metadata blocks directly. */
function inspectGeneric(inv: Inventory, d: Bytes) {
  if (inv.fmt === "tiff" || (inv.fmt === "raw" && /^(II\*\0|MM\0\*|IIRO|IIRS|IIU\0)/.test(latin1(d, 0, 4)))) {
    const tiff = /^(IIRO|IIRS|IIU\0)/.test(latin1(d, 0, 4)) ? concat([ascii("II*\0"), d.slice(4)]) : d;
    try {
      const ex = readExif(tiff);
      readExifInto(inv, ex, inv.fmt === "tiff" ? "TIFF" : "RAW/EXIF");
      readPreviewsInto(inv, tiff, ex);
      inv.width = Number(ex.ifd0.get(256)?.value ?? 0); inv.height = Number(ex.ifd0.get(257)?.value ?? 0);
      const xmp = ex.ifd0.get(700)?.raw;
      if (xmp && xmp.some(b => b !== 0 && b !== 32)) readXmpInto(inv, utf8Decode(xmp));
      const iptc = ex.ifd0.get(33723)?.raw;
      if (iptc && iptc.some(b => b !== 0)) readIptcInto(inv, iptc);
    } catch (e) { inv.errors.push(`TIFF parse error: ${e}`); }
  } else if (heifExif(inv, d)) {
    // read via item table
  } else {
    let i = indexOf(d, "Exif\0\0");
    if (i < 0) for (const h of ["MM\0*\0\0\0\x08", "II*\0\x08\0\0\0"]) { i = indexOf(d, h, 12); if (i >= 0) break; }
    if (i >= 0) { try { readExifInto(inv, readExif(d, i)); } catch (e) { inv.errors.push(`EXIF parse error: ${e}`); } }
    // image size from the largest 'ispe' box
    let p = 0, area = 0;
    while ((p = indexOf(d, "ispe", p + 1, Math.min(d.length, 1 << 20))) > 0) {
      const w = u32be(d, p + 8), h = u32be(d, p + 12);
      if (w * h > area) { area = w * h; inv.width = w; inv.height = h; }
    }
  }
  if (!inv.xmp.length) {
    const s = indexOf(d, "<x:xmpmeta");
    if (s >= 0) {
      const e = indexOf(d, "</x:xmpmeta>", s);
      if (e > 0) readXmpInto(inv, utf8Decode(d, s, e + 12));
    }
  }
  const blob = C.findBmffC2pa(d);
  if (blob) readC2paInto(inv, blob);
}

export function aiSignals(inv: Inventory): AiSignal[] {
  const out: AiSignal[] = [];
  for (const s of inv.c2pa) {
    let verdict = "Content Credentials present";
    for (const d of s.digital_source_type ?? []) if (AI_SOURCE_TYPES[d]) verdict = AI_SOURCE_TYPES[d][0];
    out.push({ signal: "C2PA / Content Credentials", verdict, detail: s.claim_generator || (s.generator_info ?? []).join(", ") || "signed manifest",
      risk: "high", read_by: "LinkedIn, TikTok, Google, Adobe, Meta" });
  }
  for (const f of inv.fields) {
    if (f.id === "xmp:Iptc4xmpExt:DigitalSourceType") {
      const key = f.value.replace(/\/+$/, "").split("/").pop()!;
      const [v, r] = AI_SOURCE_TYPES[key] ?? ["Unknown source type", "medium"];
      out.push({ signal: "IPTC DigitalSourceType", verdict: v, detail: key, risk: r, read_by: "Meta (Facebook/Instagram/Threads), Google" });
    } else if (f.category === "ai" && f.risk === "high" && f.id !== "c2pa:manifest") {
      out.push({ signal: `${f.source} ${f.name}`, verdict: "Mentions an AI tool or generation settings", detail: f.value.slice(0, 120),
        risk: "high", read_by: "Platform heuristics, people" });
    }
  }
  return out;
}

export function inspect(d: Bytes, filename = "image"): Inventory {
  const fmt = C.detectFormat(d, filename);
  const inv: Inventory = { filename, fmt, size: d.length, width: 0, height: 0, orientation: 1, fields: [], aiSignals: [], gps: null,
    errors: [], exif: null, xmp: [], iptc: [], icc: null, c2pa: [] };
  try {
    if (fmt === "jpeg") inspectJpeg(inv, d);
    else if (fmt === "png") inspectPng(inv, d);
    else if (fmt === "webp") inspectWebp(inv, d);
    else if (fmt === "unknown") inv.errors.push("Unsupported or unrecognised file type");
    else inspectGeneric(inv, d);
  } catch (e) { inv.errors.push(`Parse error: ${e}`); }
  const head = d.length > 4_000_000 ? d.slice(0, 4_000_000) : d;
  if (!inv.c2pa.length && indexOf(head, "c2pa") >= 0 && indexOf(head, "jumb") >= 0) {
    const i = indexOf(head, "jumb");
    readC2paInto(inv, d.slice(Math.max(0, i - 8), i + 200_000));
  }
  inv.aiSignals = aiSignals(inv);
  return inv;
}

export function toReport(inv: Inventory): Report {
  const groups = {} as Report["groups"];
  for (const [k, title] of Object.entries(CATEGORIES) as [Category, string][]) {
    const fs = inv.fields.filter(f => f.category === k);
    groups[k] = { title, risk: maxRisk(fs.map(f => f.risk)), count: fs.length, fields: fs };
  }
  const overall = maxRisk(Object.values(groups).filter(g => g.count).map(g => g.risk));
  return { filename: inv.filename, format: inv.fmt, kind: inv.kind ?? "photo", size_bytes: inv.size, width: inv.width, height: inv.height,
    orientation: inv.orientation, gps: inv.gps, overall_risk: overall, field_count: inv.fields.length, groups,
    ai_signals: inv.aiSignals, errors: inv.errors,
    notes: [inv.kind && inv.kind !== "photo"
      ? "Metadata cleaning does not remove invisible watermarks (e.g. Google SynthID) or anything you can see or hear in the recording."
      : "Metadata cleaning does not remove invisible pixel watermarks (e.g. Google SynthID); those are part of the image itself."] };
}
