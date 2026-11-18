// Videos and audio: MP4/MOV/M4A (ISO-BMFF), MP3 (ID3) and WAV (RIFF).
// Media files can be gigabytes, so nothing here loads the whole file. The engine reads only the small metadata
// regions through a Source, and a clean is described as a list of Parts: untouched ranges of the original file
// plus patched or rebuilt metadata bytes. Video frames and audio samples are never read, decoded or changed.
import { type Bytes, ascii, concat, indexOf, latin1, le32, u16be, u32be, u32le, utf8Decode, utf8Encode } from "./bytes.ts";
import * as C from "./containers.ts";
import { type Options, type Payloads, payloads, wants } from "./clean.ts";
import { F, type Field, type Inventory, type Kind, aiSignals, readC2paInto, readXmpInto } from "./inspect.ts";
import { type Category, type Risk, isAiText } from "./taxonomy.ts";

export interface Source { size: number; read(off: number, len: number): Promise<Bytes> }
export type Part = { from: number; to: number } | { bytes: Bytes };

export const bytesSource = (b: Bytes): Source => ({ size: b.length, read: async (o, n) => b.subarray(o, Math.min(b.length, o + n)) });

/** A Source that reads the output of a clean (original ranges + new bytes) without assembling it. */
export function partsSource(src: Source, parts: Part[]): Source {
  const spans: [number, Part][] = [];
  let size = 0;
  for (const p of parts) { spans.push([size, p]); size += "bytes" in p ? p.bytes.length : p.to - p.from; }
  return {
    size,
    async read(off, len) {
      const end = Math.min(size, off + len), out = new Uint8Array(Math.max(0, end - off));
      for (const [at, p] of spans) {
        const plen = "bytes" in p ? p.bytes.length : p.to - p.from;
        const a = Math.max(off, at), b = Math.min(end, at + plen);
        if (a >= b) continue;
        const chunk = "bytes" in p ? p.bytes.subarray(a - at, b - at) : await src.read(p.from + (a - at), b - a);
        out.set(chunk, a - off);
      }
      return out;
    },
  };
}

export type MediaFormat = "mp4" | "mp3" | "wav";
const MEDIA_EXT = /\.(mp4|m4v|mov|qt|m4a|m4b|3gp|3g2|mp3|wav|wave)$/i;
export const isMediaName = (name: string) => MEDIA_EXT.test(name);

export function detectMedia(head: Bytes, name = ""): MediaFormat | null {
  const t = latin1(head, 4, 8);
  if (t === "ftyp") {
    const brands = latin1(head, 8, Math.min(head.length, 64));
    if (/heic|heix|mif1|msf1|heim|heis|hevc|avif|avis|crx /.test(brands)) return null; // still pictures
    return "mp4";
  }
  if (["moov", "mdat", "wide", "free", "skip", "pnot"].includes(t) && /\.(mov|qt|mp4|m4v|m4a)$/i.test(name)) return "mp4";
  if (latin1(head, 0, 4) === "RIFF" && latin1(head, 8, 12) === "WAVE") return "wav";
  if (latin1(head, 0, 3) === "ID3") return "mp3";
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && /\.mp3$/i.test(name)) return "mp3";
  return null;
}

// ---------------------------------------------------------------- shared plumbing
interface Region { start: number; data: Bytes }
/** A change to make when a field is removed: zero a range, or turn a whole box/chunk into padding. */
interface Patch { region: number; off: number; len: number; mode: "zero" | "free"; hdr?: number }

export interface MediaPlan {
  kind: MediaFormat;
  regions: Region[];
  patches: Map<string, Patch[]>;
  xmp: { region: number; off: number; len: number; box: Patch }[];   // XMP packets that can be rewritten in place
  metas: { box: Patch; ids: string[] }[];   // metadata boxes that become padding when nothing in them is kept
  c2pa: Patch[];
  // MP3
  id3?: { end: number; header: Bytes; frames: { fieldId: string; raw: Bytes }[] };
  id3v1?: { start: number; ids: string[] };
  audio?: { start: number; end: number };   // MP3: where the audio frames are, after every tag block is set aside
  // WAV
  chunks?: WavChunk[];
}
interface WavChunk { id: string; start: number; end: number; region?: number; listType?: string; subs?: { fieldId: string; raw: Bytes }[]; ids: string[]; drop?: boolean }

export interface MediaInventory extends Inventory { media: MediaPlan }

function newInventory(name: string, fmt: MediaFormat, size: number): MediaInventory {
  return { filename: name, fmt, kind: fmt === "mp4" ? "video" : "audio", size, width: 0, height: 0, orientation: 1, fields: [], aiSignals: [],
    gps: null, errors: [], exif: null, xmp: [], iptc: [], icc: null, c2pa: [],
    media: { kind: fmt, regions: [], patches: new Map(), xmp: [], c2pa: [], metas: [] } };
}

function addPatch(inv: MediaInventory, id: string, p: Patch) {
  const list = inv.media.patches.get(id) ?? [];
  list.push(p);
  inv.media.patches.set(id, list);
}

/** Add a field once; later sightings of the same id only add patches (e.g. a date stored in three headers). */
function field(inv: MediaInventory, f: Field, p?: Patch) {
  if (!inv.fields.some(x => x.id === f.id)) inv.fields.push(f);
  if (p) addPatch(inv, f.id, p);
}

const allZero = (b: Bytes, s = 0, e = b.length) => { for (let i = s; i < e; i++) if (b[i] !== 0) return false; return true; };
const iso6709 = (s: string): [number, number] | null => {
  const m = s.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  return m ? [+(+m[1]).toFixed(6), +(+m[2]).toFixed(6)] : null;
};
const textOrAi = (inv: MediaInventory, text: string, cat: Category, risk: Risk): [Category, Risk] =>
  isAiText(text) ? ["ai", "high"] : [cat, risk];

// ---------------------------------------------------------------- MP4 / MOV / M4A
interface Box { type: string; start: number; hdr: number; body: number; end: number }

function* kids(d: Bytes, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32be(d, pos), hdr = 8;
    const type = latin1(d, pos + 4, pos + 8);
    if (size === 1) { size = u32be(d, pos + 8) * 2 ** 32 + u32be(d, pos + 12); hdr = 16; }
    else if (size === 0) size = end - pos;
    if (size < hdr || pos + size > end) return;
    yield { type, start: pos, hdr, body: pos + hdr, end: pos + size };
    pos += size;
  }
}

const XMP_UUID = [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac];
const isUuid = (d: Bytes, at: number, u: ArrayLike<number>) => { for (let i = 0; i < 16; i++) if (d[at + i] !== u[i]) return false; return true; };

/** Names of QuickTime/iTunes atoms and Apple/Android metadata keys, in plain words. */
const QT: Record<string, [string, Category, Risk]> = {
  "©xyz": ["Location", "location", "high"], "©mak": ["Make", "device", "medium"], "©mod": ["Model", "device", "medium"],
  "©swr": ["Software", "device", "low"], "©too": ["Encoder", "device", "low"], "©enc": ["Encoded by", "device", "low"],
  "©day": ["Date", "personal", "medium"], "©ART": ["Artist", "personal", "high"], "©aut": ["Author", "personal", "high"],
  "©wrt": ["Composer", "personal", "high"], "©nam": ["Title", "personal", "medium"], "©cmt": ["Comment", "personal", "medium"],
  "©des": ["Description", "personal", "medium"], "©inf": ["Information", "personal", "medium"], "aART": ["Album artist", "personal", "high"],
  "desc": ["Description", "personal", "medium"], "cprt": ["Copyright", "personal", "low"], "©cpy": ["Copyright", "personal", "low"],
  "covr": ["Embedded picture", "personal", "medium"],
};
function keyInfo(key: string): [string, Category, Risk] {
  const k = key.toLowerCase();
  if (/^itun(smpb|norm)$|encoding params/.test(k)) return ["Playback data", "technical", "none"];
  if (k.endsWith("location.iso6709")) return ["Location", "location", "high"];
  if (k.includes("location")) return ["Location detail", "location", "medium"];
  if (k.endsWith(".make")) return ["Make", "device", "medium"];
  if (k.endsWith(".model")) return ["Model", "device", "medium"];
  if (k.endsWith(".software")) return ["Software", "device", "low"];
  if (k.includes(".camera.") || k.startsWith("com.android")) return [key.split(".").pop()!, "device", "low"];
  if (k.endsWith("creationdate")) return ["Date recorded", "personal", "medium"];
  if (/\.(author|artist|displayname)$/.test(k)) return ["Author", "personal", "high"];
  if (/\.(title|description|comment|keywords|information)$/.test(k)) return [key.split(".").pop()!, "personal", "medium"];
  if (k.endsWith("content.identifier")) return ["Live Photo link", "personal", "low"];
  return [key, "other", "low"];
}

function dataValue(d: Bytes, data: Box): { text: string; picture: boolean; at: number } {
  const type = u32be(d, data.body) & 0xffffff, at = data.body + 8;
  if (type === 13 || type === 14 || type === 27) return { text: `${(data.end - at).toLocaleString("en-US")} bytes`, picture: true, at };
  if (type === 1 || type === 0) return { text: utf8Decode(d, at, data.end).replace(/\0+$/, ""), picture: false, at };
  if (type === 2) { let s = ""; for (let i = at; i + 1 < data.end; i += 2) s += String.fromCharCode(u16be(d, i)); return { text: s, picture: false, at }; }
  if (type === 21 || type === 22) { let v = 0; for (let i = at; i < data.end; i++) v = v * 256 + d[i]; return { text: String(v), picture: false, at }; }
  return { text: `${data.end - at} bytes`, picture: false, at };
}

function mp4Meta(inv: MediaInventory, r: number, d: Bytes, meta: Box, scope: string) {
  markHandled(d, meta);
  const before = new Set(inv.fields.map(f => f.id));
  mp4MetaItems(inv, r, d, meta, scope);
  const ids = inv.fields.map(f => f.id).filter(id => !before.has(id));
  if (ids.length) inv.media.metas.push({ box: { region: r, off: meta.start, len: meta.end - meta.start, mode: "free", hdr: meta.hdr }, ids });
}

function mp4MetaItems(inv: MediaInventory, r: number, d: Bytes, meta: Box, scope: string) {
  const full = latin1(d, meta.body + 4, meta.body + 8) !== "hdlr";
  const start = full ? meta.body + 4 : meta.body;
  const keys: string[] = [];
  for (const b of kids(d, start, meta.end)) {
    if (b.type === "keys") {
      let p = b.body + 8;
      const n = u32be(d, b.body + 4);
      for (let i = 0; i < n && p + 8 <= b.end; i++) { const sz = u32be(d, p); keys.push(latin1(d, p + 8, p + sz)); p += Math.max(8, sz); }
    }
  }
  for (const b of kids(d, start, meta.end)) {
    if (b.type !== "ilst") continue;
    for (const item of kids(d, b.body, b.end)) {
      const idx = u32be(d, item.start + 4);
      let key = keys.length && idx >= 1 && idx <= keys.length ? keys[idx - 1] : item.type;
      if (item.type === "----") {
        const nm = [...kids(d, item.body, item.end)].find(c => c.type === "name");
        if (nm) key = latin1(d, nm.body + 4, nm.end);
      }
      for (const data of kids(d, item.body, item.end)) {
        if (data.type !== "data") continue;
        const v = dataValue(d, data);
        if (allZero(d, v.at, data.end)) continue;
        let [label, cat, risk] = QT[key] ?? keyInfo(key);
        if (!v.picture) [cat, risk] = textOrAi(inv, v.text, cat, risk);
        const id = `mp4:${scope}:${key}`;
        if (label === "Location") inv.gps ??= iso6709(v.text);
        field(inv, F(id, cat, "MP4", key, label, v.text, risk), { region: r, off: v.at, len: data.end - v.at, mode: "zero" });
      }
    }
  }
}

function mp4Udta(inv: MediaInventory, r: number, d: Bytes, udta: Box, scope: string) {
  markHandled(d, udta);
  for (const c of kids(d, udta.body, udta.end)) {
    const free: Patch = { region: r, off: c.start, len: c.end - c.start, mode: "free", hdr: c.hdr };
    if (c.type === "meta") { mp4Meta(inv, r, d, c, `${scope}.meta`); continue; }
    if (c.type === "free" || c.type === "skip") continue;
    if (c.type === "XMP_") {
      readXmpInto(inv, utf8Decode(d, c.body, c.end));
      inv.media.xmp.push({ region: r, off: c.body, len: c.end - c.body, box: free });
      continue;
    }
    if (c.type === "loci") {
      let p = c.body + 6;
      const z = d.indexOf(0, p);
      const place = latin1(d, p, z < 0 ? c.end : z);
      p = (z < 0 ? c.end : z) + 2;
      const lon = (u32be(d, p) | 0) / 65536, lat = (u32be(d, p + 4) | 0) / 65536;
      inv.gps ??= [+lat.toFixed(6), +lon.toFixed(6)];
      field(inv, F(`mp4:${scope}:loci`, "location", "3GPP", "loci", "Location", [place, `${lat.toFixed(4)}, ${lon.toFixed(4)}`].filter(Boolean).join(" · "), "high"), free);
      continue;
    }
    if (["auth", "titl", "dscp", "perf", "cprt", "albm", "kywd", "gnre"].includes(c.type)) {
      const text = utf8Decode(d, c.body + 6, c.end).replace(/\0+$/, "");
      const [cat, risk] = textOrAi(inv, text, "personal", c.type === "auth" || c.type === "perf" ? "high" : "medium");
      field(inv, F(`mp4:${scope}:${c.type}`, cat, "3GPP", c.type, { auth: "Author", titl: "Title", dscp: "Description", perf: "Performer", cprt: "Copyright" }[c.type] ?? c.type, text, risk), free);
      continue;
    }
    if (c.type.charCodeAt(0) === 0xa9) {
      let text = "";
      if (latin1(d, c.body + 4, c.body + 8) === "data") {
        const data = [...kids(d, c.body, c.end)].find(x => x.type === "data");
        if (data) text = dataValue(d, data).text;
      } else {
        for (let p = c.body; p + 4 <= c.end;) {
          const n = u16be(d, p);
          if (!n || p + 4 + n > c.end) break;
          text += (text ? " / " : "") + utf8Decode(d, p + 4, p + 4 + n).replace(/\0+$/, "");
          p += 4 + n;
        }
      }
      if (!text) continue;
      let [label, cat, risk] = QT[c.type] ?? [c.type.slice(1), "other", "low"] as [string, Category, Risk];
      [cat, risk] = textOrAi(inv, text, cat, risk);
      if (c.type === "©xyz") inv.gps ??= iso6709(text);
      field(inv, F(`mp4:${scope}:${c.type}`, cat, "QuickTime", c.type, label, text, risk), free);
      continue;
    }
    // vendor blocks (GoPro, DJI, Samsung…): camera serial numbers, firmware, settings
    const vendor = /^(CAME|FIRM|LENS|MUID|SETT|HMMT|GPMF|SNUM|DJI.|SEC.|Xtra|smta|SDLN)$/.test(c.type);
    field(inv, F(`mp4:${scope}:${c.type}`, vendor ? "device" : "other", "MP4", c.type, `Vendor block ${c.type.trim()}`,
      `${(c.end - c.body).toLocaleString("en-US")} bytes`, vendor && /CAME|SNUM|MUID/.test(c.type) ? "medium" : "low", false), free);
  }
}

function mp4Header(inv: MediaInventory, r: number, d: Bytes, b: Box) {
  const v = d[b.body], n = v === 1 ? 8 : 4;
  const created = v === 1 ? u32be(d, b.body + 4) * 2 ** 32 + u32be(d, b.body + 8) : u32be(d, b.body + 4);
  if (!allZero(d, b.body + 4, b.body + 4 + 2 * n)) {
    const when = created ? new Date((created - 2082844800) * 1000).toISOString().replace("T", " ").slice(0, 19) : "set";
    const existing = inv.fields.find(f => f.id === "mp4:times");
    if (!existing || existing.value === "set") {
      if (existing) existing.value = when;
      else field(inv, F("mp4:times", "personal", "MP4", "CreationTime", "Date recorded", when, "medium"));
    }
    addPatch(inv, "mp4:times", { region: r, off: b.body + 4, len: 2 * n, mode: "zero" });
  }
  if (b.type === "tkhd") {
    const at = b.body + (v === 1 ? 88 : 76);
    const w = u32be(d, at) >>> 16, h = u32be(d, at + 4) >>> 16;
    if (w * h > inv.width * inv.height) { inv.width = w; inv.height = h; }
  }
}

// Boxes that only hold other boxes. 'udta' and 'meta' can sit in any of them (fragments and sample tables included).
const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex", "moof", "traf"]);

function mp4Walk(inv: MediaInventory, r: number, d: Bytes, start: number, end: number, scope: string, video: { yes: boolean }, depth = 0) {
  if (depth > 12) { inv.errors.push("This video's structure is nested too deeply to check."); return; }
  for (const b of kids(d, start, end)) {
    if (b.type === "trak") mp4TimedTrack(inv, d, b);
    if (b.type === "cmov") { inv.errors.push(CMOV_ERROR); continue; }
    if (MP4_CONTAINERS.has(b.type)) mp4Walk(inv, r, d, b.body, b.end, b.type === "trak" ? "track" : b.type === "moof" ? "fragment" : scope, video, depth + 1);
    else if (b.type === "udta") mp4Udta(inv, r, d, b, scope);
    else if (b.type === "meta") mp4Meta(inv, r, d, b, `${scope}.meta`);
    else if (b.type === "mvhd" || b.type === "tkhd" || b.type === "mdhd") mp4Header(inv, r, d, b);
    else if (b.type === "hdlr" && latin1(d, b.body + 8, b.body + 12) === "vide") video.yes = true;
    else if (b.type === "uuid") mp4Uuid(inv, r, d, b);
  }
}

const child = (d: Bytes, b: Box | undefined, type: string, skip = 0) => b && [...kids(d, b.body + skip, b.end)].find(c => c.type === type);
// Apple 'mebx' keys that only describe the picture (Live Photo timing, orientation, light level)
const PLAIN_MEBX_KEYS = new Set(["com.apple.quicktime.still-image-time", "com.apple.quicktime.live-photo-info",
  "com.apple.quicktime.video-orientation", "com.apple.quicktime.scene-illuminance"]);

/**
 * Timed-metadata tracks (GoPro GPMF 'gpmd', Google 'camm', Sony 'rtmd', 'mebx', 'mett'…) store their details in the
 * sample data next to the frames, often a GPS fix every frame. Those samples can't be removed without rewriting the
 * file's sample tables, so they are reported as findings that can't be removed (and the file is never called clean).
 */
function mp4TimedTrack(inv: MediaInventory, d: Bytes, trak: Box) {
  const mdia = child(d, trak, "mdia"), minf = child(d, mdia, "minf");
  // every handler, not just the first: a 'vide' handler followed by a 'meta' one must not hide a metadata track
  const handlers = (b: Box | undefined) => b ? [...kids(d, b.body, b.end)].filter(c => c.type === "hdlr").map(h => latin1(d, h.body + 8, h.body + 12)) : [];
  const mdiaHandlers = handlers(mdia), all = [...mdiaHandlers, ...handlers(minf)];
  const handler = mdiaHandlers.join("/");
  const stsd = child(d, child(d, minf, "stbl"), "stsd");
  const entries = stsd ? [...kids(d, stsd.body + 8, stsd.end)] : [];
  const types = entries.map(e => e.type);
  const timed = mdiaHandlers.length > 1 || all.includes("meta") || types.some(t => /^(gpmd|camm|rtmd|mebx|mett|metx|urim)$/.test(t));
  if (!timed) return;
  const keys: string[] = [];
  for (const e of entries) {
    if (e.type !== "mebx") continue;
    for (const k of kids(d, child(d, e, "keys", 8)?.body ?? e.end, child(d, e, "keys", 8)?.end ?? e.end)) {
      const keyd = child(d, k, "keyd");
      keys.push(keyd ? latin1(d, keyd.body + 4, keyd.end).replace(/\0+$/, "") : "?");
    }
  }
  const located = types.some(t => /^(gpmd|camm|rtmd)$/.test(t)) || keys.some(k => /location|gps|iso6709|coordinat/i.test(k));
  if (!located && types.length && types.every(t => t === "mebx") && keys.length && keys.every(k => PLAIN_MEBX_KEYS.has(k))) return;
  const what = types.join(", ") || handler || "unknown";
  if (located) {
    field(inv, F(`mp4:track:gps:${what}`, "location", "MP4", what, "GPS track", `Timed ${what} track`, "high", false,
      "This video has a GPS track (GoPro and similar cameras) that UnMeta can't remove without re-encoding."));
  } else {
    field(inv, F(`mp4:track:timed:${what}`, "device", "MP4", what, "Timed details track", keys.length ? keys.join(", ") : `Timed ${what} track`, "medium", false,
      "This video has a track of timed details stored with the frames (camera or sensor data). UnMeta can't read or remove it without re-encoding."));
  }
}

/** Every 'udta'/'meta' box the walk handled, by region, so a stray one anywhere else is noticed. */
const handledBoxes = new WeakMap<Bytes, Set<number>>();
const markHandled = (d: Bytes, b: Box) => { let s = handledBoxes.get(d); if (!s) handledBoxes.set(d, s = new Set()); s.add(b.start); };

const CMOV_ERROR = "This video's details are compressed in a way UnMeta can't check.";

/** Backstop: a 'udta' or 'meta' box header in a place the walk doesn't reach (inside a sample entry, say). */
function mp4StrayBoxes(inv: MediaInventory, d: Bytes) {
  const seen = handledBoxes.get(d);
  // a compressed movie header ('cmov', zlib) anywhere: its contents can't be checked
  for (let p = indexOf(d, "cmov", 4); p >= 0; p = indexOf(d, "cmov", p + 1)) {
    const size = u32be(d, p - 4);
    if (size >= 8 && p - 4 + size <= d.length) { if (!inv.errors.includes(CMOV_ERROR)) inv.errors.push(CMOV_ERROR); break; }
  }
  for (const t of ["udta", "meta"]) {
    for (let p = indexOf(d, t, 4); p >= 0; p = indexOf(d, t, p + 1)) {
      const s = p - 4, size = u32be(d, s);
      const plausible = size === 1 ? p + 12 <= d.length : size >= 8 && s + size <= d.length;
      if (plausible && !seen?.has(s)) {
        inv.errors.push("This video has a details block in a place UnMeta doesn't check.");
        return;
      }
    }
  }
}

function mp4Uuid(inv: MediaInventory, r: number, d: Bytes, b: Box) {
  const free: Patch = { region: r, off: b.start, len: b.end - b.start, mode: "free", hdr: b.hdr };
  if (isUuid(d, b.body, XMP_UUID)) {
    readXmpInto(inv, utf8Decode(d, b.body + 16, b.end));
    inv.media.xmp.push({ region: r, off: b.body + 16, len: b.end - b.body - 16, box: free });
  } else if (isUuid(d, b.body, C.C2PA_UUID)) {
    const blob = C.findBmffC2pa(d.subarray(b.start, b.end));
    if (blob) readC2paInto(inv, blob);
    inv.media.c2pa.push(free);
  }
}

// Memory budget for metadata boxes read into memory: no single box over MAX_META, and no more than MAX_KEPT held for
// the clean (a box with nothing to change is let go after it is checked). Each held byte is copied once more by the
// clean and read once more by the re-check, so peak memory stays a small multiple of these.
const MAX_META = 64 * 1024 * 1024;
const MAX_MOOV = 256 * 1024 * 1024;   // the main header of a long video (sample tables) can legitimately be large
const MAX_KEPT = 384 * 1024 * 1024;

/** How many changes the plan holds; used to tell whether a region turned out to need any. */
const planRefs = (inv: MediaInventory) =>
  [...inv.media.patches.values()].reduce((n, l) => n + l.length, 0) + inv.media.xmp.length + inv.media.metas.length + inv.media.c2pa.length;

async function inspectMp4(inv: MediaInventory, src: Source) {
  const video = { yes: false };
  let kept = 0;
  for (let pos = 0; pos + 8 <= src.size;) {
    const h = await src.read(pos, 16);
    let size = u32be(h, 0), hdr = 8;
    const type = latin1(h, 4, 8);
    if (size === 1) { size = u32be(h, 8) * 2 ** 32 + u32be(h, 12); hdr = 16; }
    else if (size === 0) size = src.size - pos;
    if (size < hdr || pos + size > src.size) {
      // anything after a broken box can't be checked, so the file can't be reported clean
      if (src.size - pos >= 8) inv.errors.push(pos === 0 ? "Damaged video file" : "Part of this video is damaged and couldn't be checked.");
      break;
    }
    if (["moov", "moof", "uuid", "udta", "meta"].includes(type)) {
      // too big to check: record it and move on without reading it into memory
      if (size > (type === "moov" ? MAX_MOOV : MAX_META) || kept + size > MAX_KEPT) {
        const msg = "A details block in this video is too large to check.";
        if (!inv.errors.includes(msg)) inv.errors.push(msg);
        pos += size;
        continue;
      }
      const refs = planRefs(inv);
      const r = inv.media.regions.push({ start: pos, data: (await src.read(pos, size)).slice() }) - 1;
      const d = inv.media.regions[r].data;
      if (type === "moov" || type === "moof") mp4Walk(inv, r, d, hdr, size, type === "moov" ? "movie" : "fragment", video);
      else if (type === "uuid") mp4Uuid(inv, r, d, { type, start: 0, hdr, body: hdr, end: size });
      else if (type === "udta") mp4Udta(inv, r, d, { type, start: 0, hdr, body: hdr, end: size }, "file");
      else mp4Meta(inv, r, d, { type, start: 0, hdr, body: hdr, end: size }, "file.meta");
      mp4StrayBoxes(inv, d);
      // a box with nothing to change is copied from the original instead of held in memory
      if (planRefs(inv) === refs) inv.media.regions.pop();
      else kept += size;
    }
    pos += size;
  }
  inv.kind = video.yes ? "video" : "audio";
}

// ---------------------------------------------------------------- MP3 (ID3v2 + ID3v1)
const syncsafe = (b: Bytes, o: number) => ((b[o] & 127) << 21) | ((b[o + 1] & 127) << 14) | ((b[o + 2] & 127) << 7) | (b[o + 3] & 127);

function id3Text(b: Bytes, s: number, e: number): string {
  const enc = b[s];
  let out = "";
  if (enc === 1 || enc === 2) {
    let le = enc === 1 && b[s + 1] === 0xff && b[s + 2] === 0xfe, p = s + 1;
    if (enc === 1 && ((b[s + 1] === 0xff && b[s + 2] === 0xfe) || (b[s + 1] === 0xfe && b[s + 2] === 0xff))) p += 2;
    for (; p + 1 < e; p += 2) {
      const c = le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1];
      if (c === 0xfeff || c === 0xfffe) { le = c === 0xfffe ? !le : le; continue; }
      out += c ? String.fromCharCode(c) : "\0";
    }
  } else out = enc === 3 ? utf8Decode(b, s + 1, e) : latin1(b, s + 1, e);
  return out.split("\0").map(x => x.trim()).filter(Boolean).join(" / ");
}

const ID3: Record<string, [string, Category, Risk]> = {
  TIT2: ["Title", "personal", "medium"], TT2: ["Title", "personal", "medium"], TIT3: ["Subtitle", "personal", "medium"],
  TPE1: ["Artist", "personal", "high"], TP1: ["Artist", "personal", "high"], TPE2: ["Album artist", "personal", "high"],
  TCOM: ["Composer", "personal", "high"], TEXT: ["Lyricist", "personal", "high"], TOPE: ["Original artist", "personal", "high"],
  TYER: ["Year", "personal", "medium"], TYE: ["Year", "personal", "medium"], TDRC: ["Date recorded", "personal", "medium"],
  TDAT: ["Date", "personal", "medium"], TIME: ["Time", "personal", "low"], TDEN: ["Date encoded", "personal", "low"],
  TSSE: ["Encoder settings", "device", "low"], TSS: ["Encoder settings", "device", "low"], TENC: ["Encoded by", "device", "low"],
  TCOP: ["Copyright", "personal", "low"], TALB: ["Album", "other", "low"], TCON: ["Genre", "other", "low"],
  COMM: ["Comment", "personal", "medium"], COM: ["Comment", "personal", "medium"],
  APIC: ["Embedded picture", "personal", "medium"], PIC: ["Embedded picture", "personal", "medium"],
  PRIV: ["Private data", "other", "low"], GEOB: ["Embedded object", "other", "low"], UFID: ["File identifier", "other", "low"],
};

function readId3Frames(inv: MediaInventory, b: Bytes, ver: number, from: number, to: number, prefix: string, keepable = true) {
  const frames: { fieldId: string; raw: Bytes }[] = [];
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  for (let p = from, n = 0; p + hdr <= to; n++) {
    const id = latin1(b, p, p + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const size = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5] : ver === 4 ? syncsafe(b, p + 4) : u32be(b, p + 4);
    const s = p + hdr, e = Math.min(to, s + size);
    const fid = `${prefix}:${id}:${n}`;
    let [label, cat, risk] = ID3[id] ?? (id[0] === "T" ? [id, "other", "low"] : id[0] === "W" ? ["Web link", "other", "low"] : [id, "other", "low"]) as [string, Category, Risk];
    let value: string;
    if (id === "TXXX" || id === "TXX" || id === "COMM" || id === "COM") {
      const skip = id.startsWith("C") ? 4 : 1;   // COMM has a 3-byte language after the encoding byte
      const parts = id3Text(concat([b.subarray(s, s + 1), b.subarray(s + skip, e)]), 0, e - s - skip + 1);
      value = parts;
      if (id.startsWith("TX")) {
        if (/location|gps|latitude|longitude|place/i.test(parts)) [label, cat, risk] = ["Location", "location", "high"];
        else label = `Custom: ${parts.split(" / ")[0]}`;
      }
    } else if (id === "APIC" || id === "PIC") value = `${(e - s).toLocaleString("en-US")} bytes`;
    else if (id[0] === "T") value = id3Text(b, s, e);
    else value = `${(e - s).toLocaleString("en-US")} bytes`;
    if (cat !== "location") [cat, risk] = textOrAi(inv, value, cat, risk);
    if (value) {
      field(inv, F(fid, cat, "ID3", id, label, value, risk, keepable));
      frames.push({ fieldId: fid, raw: b.slice(p, s + size) });
    }
    p = s + size;
  }
  return frames;
}

/** Printable runs of text inside a tag block, so a removed block's contents can be shown and searched for afterwards. */
const printable = (b: Bytes) => (latin1(b).match(/[\x20-\x7e]{4,}/g) ?? []).join(" ").slice(0, 160);

async function readId3At(inv: MediaInventory, src: Source, pos: number, prefix: string, keepable: boolean) {
  const head = await src.read(pos, 10);
  const ver = head[3], flags = head[5];
  const end = Math.min(src.size, pos + 10 + syncsafe(head, 6) + (flags & 0x10 ? 10 : 0));
  const tag = (await src.read(pos, end - pos)).slice();
  let from = 10;
  if (flags & 0x40) from += ver === 4 ? syncsafe(tag, 10) : u32be(tag, 10) + 4;
  if (flags & 0x80 || ver < 2 || ver > 4) {
    field(inv, F(`${prefix}:tag`, "personal", "ID3", "ID3v2", "Tag details", printable(tag) || `${tag.length} bytes`, "medium", false));
    return { end, header: tag.slice(0, 10), frames: [] as { fieldId: string; raw: Bytes }[] };
  }
  return { end, header: tag.slice(0, 10), frames: readId3Frames(inv, tag, ver, from, tag.length, prefix, keepable) };
}

async function inspectMp3(inv: MediaInventory, src: Source) {
  // tags at the start: the first one may be kept field by field; any further ones are always removed
  let start = 0;
  for (let n = 0; n < 8 && start + 10 <= src.size && latin1(await src.read(start, 3)) === "ID3"; n++) {
    const t = await readId3At(inv, src, start, n === 0 ? "id3" : `id3x${n}`, n === 0);
    if (n === 0) inv.media.id3 = t;
    if (t.end <= start) break;
    start = t.end;
  }
  // tags at the end, in any order: ID3v1 (last 128 bytes), APEv2, an appended ID3v2.4 with a "3DI" footer, Lyrics3
  let end = src.size;
  if (src.size >= 128) {
    const t = await src.read(src.size - 128, 128);
    if (latin1(t, 0, 3) === "TAG") {
      const s = (a: number, b: number) => latin1(t, a, b).replace(/\0.*$/s, "").trim();
      const ids: string[] = [];
      for (const [k, label, a, b, cat, risk] of [["title", "Title", 3, 33, "personal", "medium"], ["artist", "Artist", 33, 63, "personal", "high"],
        ["album", "Album", 63, 93, "other", "low"], ["year", "Year", 93, 97, "personal", "medium"], ["comment", "Comment", 97, 125, "personal", "medium"]] as const) {
        const v = s(a, b);
        if (!v) continue;
        const [c, r] = textOrAi(inv, v, cat, risk);
        field(inv, F(`id3v1:${k}`, c, "ID3v1", k, label, v, r, false));
        ids.push(`id3v1:${k}`);
      }
      inv.media.id3v1 = { start: src.size - 128, ids };
      end = src.size - 128;
    }
  }
  for (let n = 0; n < 8 && end > start; n++) {
    if (end - start >= 32 && latin1(await src.read(end - 32, 8)) === "APETAGEX") {
      const f = await src.read(end - 32, 32);
      const total = u32le(f, 12) + (u32le(f, 20) & 0x80000000 ? 32 : 0);
      const from = end - total;
      if (total < 32 || from < start) { inv.errors.push("The tag at the end of this file is damaged."); break; }
      field(inv, F(`mp3:ape:${n}`, "personal", "APE", "APEv2", "Tag at the end of the file", printable(await src.read(from, Math.min(total, 1 << 20))) || `${total} bytes`, "medium", false));
      end = from;
    } else if (end - start >= 10 && latin1(await src.read(end - 10, 3)) === "3DI") {
      const f = await src.read(end - 10, 10);
      const from = end - syncsafe(f, 6) - 20;
      if (from < start) { inv.errors.push("The tag at the end of this file is damaged."); break; }
      await readId3At(inv, src, from, `id3t${n}`, false);
      end = from;
    } else if (end - start >= 15 && latin1(await src.read(end - 9, 9)) === "LYRICS200") {
      const len = parseInt(latin1(await src.read(end - 15, 6)), 10);
      const from = end - 15 - len;
      if (!Number.isFinite(len) || from < start) { inv.errors.push("The tag at the end of this file is damaged."); break; }
      field(inv, F(`mp3:lyrics3:${n}`, "personal", "Lyrics3", "Lyrics3", "Lyrics block", printable(await src.read(from, Math.min(len + 15, 1 << 20))) || `${len} bytes`, "medium", false));
      end = from;
    } else break;
  }
  inv.media.audio = { start, end };
}

// ---------------------------------------------------------------- WAV (RIFF)
const INFO: Record<string, [string, Category, Risk]> = {
  INAM: ["Title", "personal", "medium"], IART: ["Artist", "personal", "high"], ICMT: ["Comment", "personal", "medium"],
  ICRD: ["Date recorded", "personal", "medium"], ISFT: ["Software", "device", "low"], IENG: ["Engineer", "personal", "high"],
  ITCH: ["Technician", "personal", "high"], ICOP: ["Copyright", "personal", "low"], ISBJ: ["Subject", "personal", "medium"],
  IKEY: ["Keywords", "personal", "medium"], IPRD: ["Product", "other", "low"], IGNR: ["Genre", "other", "low"],
  IARL: ["Archive location", "other", "low"], ISRC: ["Source", "other", "low"],
};
const META_CHUNKS = new Set(["LIST", "bext", "iXML", "_PMX", "id3 ", "ID3 ", "axml", "cart"]);

async function inspectWav(inv: MediaInventory, src: Source) {
  const chunks: WavChunk[] = [];
  for (let pos = 12; pos + 8 <= src.size;) {
    const h = await src.read(pos, 12);
    const id = latin1(h, 0, 4), size = u32le(h, 4), end = Math.min(src.size, pos + 8 + size + (size & 1));
    const c: WavChunk = { id, start: pos, end, ids: [] };
    const listType = id === "LIST" ? latin1(h, 8, 12) : "";
    if (id === "LIST" && !/^(INFO|info|wavl)$/.test(listType)) {
      // other lists (adtl: marker labels and notes, or anything unknown) can carry names and places: read the text, then remove
      if (size > 64 * 1024 * 1024) { inv.errors.push("A block in this recording is too large to check."); chunks.push(c); pos = end; continue; }
      const d = (await src.read(pos, end - pos)).slice();
      const texts: string[] = [];
      for (let p = 12; p + 8 <= Math.min(d.length, 8 + size);) {
        const n = u32le(d, p + 4), skip = /^(labl|note)$/.test(latin1(d, p, p + 4)) ? 4 : latin1(d, p, p + 4) === "ltxt" ? 20 : 0;
        const t = latin1(d, p + 8 + skip, Math.min(d.length, p + 8 + n)).replace(/\0+$/, "").replace(/[^\x20-\x7e\u00a0-\u00ff]+/g, " ").trim();
        if (t) texts.push(t);
        p += 8 + n + (n & 1);
      }
      const fid = `wav:list:${listType.trim() || "?"}:${chunks.length}`;
      const value = texts.join(" · ").slice(0, 300) || `${size.toLocaleString("en-US")} bytes`;
      const [cat, risk] = textOrAi(inv, value, "personal", "medium");
      field(inv, F(fid, cat, "WAV", `LIST ${listType}`, listType === "adtl" ? "Marker labels and notes" : `List block ${listType.trim()}`, value, risk, false));
      c.ids.push(fid);
      c.drop = true;
      chunks.push(c);
      pos = end;
      continue;
    }
    if (META_CHUNKS.has(id) && size <= 64 * 1024 * 1024 && (id !== "LIST" || listType === "INFO" || listType === "info")) {
      const r = inv.media.regions.push({ start: pos, data: (await src.read(pos, end - pos)).slice() }) - 1;
      const d = inv.media.regions[r].data;
      c.region = r;
      const body = 8, bodyEnd = Math.min(d.length, 8 + size);
      if (id === "LIST") {
        c.listType = "INFO";
        c.subs = [];
        for (let p = body + 4; p + 8 <= bodyEnd;) {
          const sid = latin1(d, p, p + 4), n = u32le(d, p + 4), e = Math.min(bodyEnd, p + 8 + n);
          const text = utf8Decode(d, p + 8, e).replace(/\0+$/, "").trim();
          if (text) {
            let [label, cat, risk] = INFO[sid] ?? [sid, "other", "low"] as [string, Category, Risk];
            [cat, risk] = textOrAi(inv, text, cat, risk);
            const fid = `wav:info:${sid}`;
            field(inv, F(fid, cat, "RIFF INFO", sid, label, text, risk));
            c.subs.push({ fieldId: fid, raw: d.slice(p, p + 8 + n + (n & 1)) });
            c.ids.push(fid);
          }
          p += 8 + n + (n & 1);
        }
      } else if (id === "bext") {
        for (const [k, label, a, len, cat, risk] of [["description", "Description", 0, 256, "personal", "medium"],
          ["originator", "Recorder", 256, 32, "device", "medium"], ["reference", "Recorder reference", 288, 32, "device", "medium"],
          ["date", "Date recorded", 320, 10, "personal", "medium"], ["time", "Time recorded", 330, 8, "personal", "low"]] as const) {
          const v = latin1(d, body + a, body + a + len).replace(/\0.*$/s, "").trim();
          if (!v) continue;
          const [cc, rr] = textOrAi(inv, v, cat, risk);
          const fid = `wav:bext:${k}`;
          field(inv, F(fid, cc, "BWF", k, label, v, rr), { region: r, off: body + a, len, mode: "zero" });
          c.ids.push(fid);
        }
        if (bodyEnd > body + 602) {
          const hist = latin1(d, body + 602, bodyEnd).replace(/\0.*$/s, "").trim();
          if (hist) {
            field(inv, F("wav:bext:history", "device", "BWF", "CodingHistory", "Recording chain", hist, "low"),
              { region: r, off: body + 602, len: bodyEnd - body - 602, mode: "zero" });
            c.ids.push("wav:bext:history");
          }
        }
      } else if (id === "_PMX") {
        readXmpInto(inv, utf8Decode(d, body, bodyEnd));
        c.ids.push(...inv.fields.filter(f => f.id.startsWith("xmp:")).map(f => f.id));
      } else {
        const text = utf8Decode(d, body, bodyEnd);
        const located = /<LOCATION|GPS|LATITUDE/i.test(text);
        const [label, cat, risk]: [string, Category, Risk] = id === "iXML" ? ["Recorder notes (iXML)", located ? "location" : "personal", located ? "high" : "medium"]
          : id === "axml" ? ["Broadcast details (XML)", "personal", "medium"] : id === "cart" ? ["Broadcast cart", "personal", "medium"]
            : ["ID3 tag", "personal", "medium"];
        const fid = `wav:${id.trim()}`;
        field(inv, F(fid, cat, "WAV", id.trim(), label, `${(bodyEnd - body).toLocaleString("en-US")} bytes`, risk, false));
        c.ids.push(fid);
      }
    }
    chunks.push(c);
    pos = end;
  }
  inv.media.chunks = chunks;
}

// ---------------------------------------------------------------- public API
export async function inspectMedia(src: Source, name: string, known?: MediaFormat): Promise<MediaInventory> {
  const head = await src.read(0, 64);
  const fmt = known ?? detectMedia(head, name);
  if (!fmt) throw new Error("Not a supported video or audio file.");
  const inv = newInventory(name, fmt, src.size);
  try {
    if (fmt === "mp4") await inspectMp4(inv, src);
    else if (fmt === "mp3") await inspectMp3(inv, src);
    else await inspectWav(inv, src);
  } catch (e) { inv.errors.push(e instanceof Error ? e.message : String(e)); }
  inv.aiSignals = aiSignals(inv);
  return inv;
}

export interface MediaResult {
  parts: Part[]; size: number; before: MediaInventory; after: MediaInventory;
  removed: Field[]; kept: Field[]; verified: boolean; residual: Field[]; pixelsUntouched: boolean; notes: string[];
}

function apply(regions: Bytes[], p: Patch) {
  const d = regions[p.region];
  if (p.mode === "zero") { d.fill(0, p.off, p.off + p.len); return; }
  d.set(ascii("free"), p.off + 4);
  d.fill(0, p.off + (p.hdr ?? 8), p.off + p.len);
}

function cleanMp4(inv: MediaInventory, P: Payloads, size: number): Part[] {
  const regions = inv.media.regions.map(r => r.data.slice());
  for (const [id, list] of inv.media.patches) if (!P.intended.has(id)) list.forEach(p => apply(regions, p));
  for (const x of inv.media.xmp) {
    const b = P.xmp ? utf8Encode(P.xmp) : null;
    if (b && b.length <= x.len) { regions[x.region].fill(0x20, x.off, x.off + x.len); regions[x.region].set(b, x.off); }
    else apply(regions, x.box);
  }
  if (!P.c2pa) inv.media.c2pa.forEach(p => apply(regions, p));
  // nothing kept from a metadata box: turn the whole box (keys and all) into padding, so no empty entries remain
  for (const m of inv.media.metas) if (!m.ids.some(id => P.intended.has(id) || inv.fields.find(f => f.id === id)?.category === "technical")) apply(regions, m.box);
  const parts: Part[] = [];
  let at = 0;
  inv.media.regions.forEach((r, i) => {
    if (r.start > at) parts.push({ from: at, to: r.start });
    parts.push({ bytes: regions[i] });
    at = r.start + r.data.length;
  });
  if (at < size) parts.push({ from: at, to: size });
  return parts;
}

function syncsafeBytes(n: number): Bytes { return new Uint8Array([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]); }

function cleanMp3(inv: MediaInventory, P: Payloads, size: number): Part[] {
  const parts: Part[] = [];
  const id3 = inv.media.id3;
  if (id3) {
    const frames = id3.frames.filter(f => P.intended.has(f.fieldId)).map(f => f.raw);
    if (frames.length) {
      const body = concat(frames), head = id3.header.slice(0, 10);
      head[5] = 0;
      head.set(syncsafeBytes(body.length), 6);
      parts.push({ bytes: concat([head, body]) });
    }
  }
  const audio = inv.media.audio ?? { start: id3?.end ?? 0, end: inv.media.id3v1 ? inv.media.id3v1.start : size };
  parts.push({ from: audio.start, to: audio.end });
  return parts;
}

function riffChunk(id: string, body: Bytes): Bytes {
  return concat([ascii(id), le32(body.length), body, body.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]);
}

function cleanWav(inv: MediaInventory, P: Payloads): Part[] {
  const parts: Part[] = [];
  for (const c of inv.media.chunks ?? []) {
    if (c.drop) continue;
    if (c.region === undefined) { parts.push({ from: c.start, to: c.end }); continue; }
    const d = inv.media.regions[c.region].data;
    if (c.listType === "INFO") {
      const subs = (c.subs ?? []).filter(s => P.intended.has(s.fieldId)).map(s => s.raw);
      if (subs.length) parts.push({ bytes: riffChunk("LIST", concat([ascii("INFO"), ...subs])) });
    } else if (c.id === "bext") {
      if (c.ids.some(id => P.intended.has(id))) {
        const copy = d.slice();
        for (const id of c.ids) if (!P.intended.has(id)) inv.media.patches.get(id)?.forEach(p => copy.fill(0, p.off, p.off + p.len));
        parts.push({ bytes: copy });
      }
    } else if (c.id === "_PMX") {
      if (P.xmp) parts.push({ bytes: riffChunk("_PMX", utf8Encode(P.xmp)) });
    } else if (c.ids.some(id => P.intended.has(id))) parts.push({ from: c.start, to: c.end });
  }
  const size = parts.reduce((n, p) => n + ("bytes" in p ? p.bytes.length : p.to - p.from), 0);
  return [{ bytes: concat([ascii("RIFF"), le32(size + 4), ascii("WAVE")]) }, ...parts];
}

const SCAN_LIMIT = 16 * 1024 * 1024;   // untouched ranges larger than this are frames or samples, not details

async function stillContains(out: Source, parts: Part[], removed: Field[]): Promise<Field[]> {
  const needles = removed
    .filter(f => (f.risk === "medium" || f.risk === "high") && f.value.length >= 6 && !/^\d[\d,]* bytes$/.test(f.value))
    .flatMap(f => [f.value.slice(0, 40),
      // the same place is often stored several ways (ISO 6709, decimals): look for the coordinates themselves
      ...(f.category === "location" ? f.value.match(/[+-]?\d{1,3}\.\d{3,}/g) ?? [] : [])].map(v => ({ f, b: utf8Encode(v) })));
  if (!needles.length) return [];
  const found = new Set<Field>();
  let at = 0;
  for (const p of parts) {
    const len = "bytes" in p ? p.bytes.length : p.to - p.from;
    if (len <= SCAN_LIMIT) {
      const chunk = "bytes" in p ? p.bytes : await out.read(at, len);
      for (const { f, b } of needles) if (!found.has(f) && indexOf(chunk, b) >= 0) found.add(f);
    }
    at += len;
  }
  return [...found];
}

export async function cleanMedia(src: Source, name: string, o: Options, before?: MediaInventory): Promise<MediaResult> {
  const inv = before ?? await inspectMedia(src, name);
  const P = payloads(inv, o);
  const parts = inv.fmt === "mp4" ? cleanMp4(inv, P, src.size) : inv.fmt === "mp3" ? cleanMp3(inv, P, src.size) : cleanWav(inv, P);
  const out = partsSource(src, parts);
  const after = await inspectMedia(out, name, inv.fmt as MediaFormat);  // re-check as the same format
  const afterIds = new Set(after.fields.map(f => f.id));
  const residual = after.fields.filter(f => !P.intended.has(f.id) && (f.risk === "medium" || f.risk === "high"));
  const notes: string[] = [];
  if (P.c2pa) notes.push("Content Credentials were kept, but they will no longer verify after any change.");
  // Belt and braces: a damaged file can hide a second copy of a detail where the parser can't see it. Search the
  // output for the text of everything removed; if any of it is still there, the file is not reported clean.
  const leftover = await stillContains(out, parts, inv.fields.filter(f => !afterIds.has(f.id)));
  if (leftover.length) notes.push("Part of this file is damaged, and some details may still be inside it.");
  return {
    parts, size: out.size, before: inv, after,
    removed: inv.fields.filter(f => !afterIds.has(f.id)),
    kept: after.fields.filter(f => inv.fields.some(b => b.id === f.id)),
    verified: residual.length === 0 && leftover.length === 0 && inv.errors.length === 0 && after.errors.length === 0
      && (after.aiSignals.length === 0 || o.keepCategories.includes("ai") || P.c2pa),
    residual: [...residual, ...leftover],
    // frames and samples are copied from the original by reference; only metadata regions are ever written
    pixelsUntouched: parts.some(p => !("bytes" in p)) || inv.size === 0,
    notes,
  };
}

export { wants };
export type { Kind };

// Keys come from untrusted files: no prototype, so names like "constructor" or "__proto__" are just unknown.
Object.setPrototypeOf(QT, null);
Object.setPrototypeOf(ID3, null);
Object.setPrototypeOf(INFO, null);
