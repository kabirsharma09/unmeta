// Documents: PDF and Office files (DOCX/XLSX/PPTX and their macro/template variants).
// Only hidden details are removed: who wrote it, the company, dates, the app, a hidden preview picture and the
// details inside pictures placed in the document. Comments, tracked changes, annotations, form data, attachments,
// scripts and earlier saved versions are shown but never removed or changed: they are part of what the person wrote.
//
// Office files are zips. Every part that isn't rewritten is copied with its original compressed bytes (local header
// and all); only the small metadata parts, the package's relationship list and cleaned pictures are written anew.
// PDFs are blanked in place: metadata bytes are overwritten with spaces, so the file keeps its exact length and every
// offset in its cross-reference table stays correct. Anything that can't be edited that way is reported, never hidden.
import { Inflate, deflateRaw } from "pako";
import { type Bytes, ascii, concat, crc32, indexOf, latin1, le32, u16le, u32le, utf8Decode, utf8Encode } from "./bytes.ts";
import type * as C from "./containers.ts";
import { clean, wants, type Options } from "./clean.ts";
import { F, type Field, type Inventory, type Kind, type Report, aiSignals, inspect, readXmpInto, toReport } from "./inspect.ts";
import type { Highlight } from "./highlights.ts";
import { type Part, type Source, partsSource } from "./media.ts";
import { CATEGORIES, type Category, type Risk, isAiText, maxRisk } from "./taxonomy.ts";
import { type XmpProp, buildXmp } from "./xmp.ts";

export type DocFormat = "pdf" | "docx" | "xlsx" | "pptx";

const MAX_DOC = 200 * 1024 * 1024;
const MAX_ENTRY = 50 * 1024 * 1024;     // decompressed size of any one zip part or PDF stream we read
const MAX_ENTRIES = 20000;
const MAX_PICTURES = 400;
const MAX_OBJECTS = 2_000_000;
const MAX_STM_TOTAL = 64 * 1024 * 1024; // all PDF object streams together, decompressed

/** A document we can't read or clean at all. The message is plain words for the person. */
export class DocError extends Error {}
const DAMAGED = "This document is damaged and can't be read safely.";
const ZIP64 = "This document is stored in a way that isn't supported yet (a very large Office file).";

const DOC_EXT = /\.(pdf|docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|potx|potm)$/i;
export const isDocName = (name: string) => DOC_EXT.test(name);

export function detectDoc(head: Bytes, name = ""): "pdf" | "ooxml" | null {
  if (indexOf(head, "%PDF-", 0, Math.min(head.length, 1024)) >= 0) return "pdf";
  const office = isDocName(name) && !/\.pdf$/i.test(name);
  if (u32le(head, 0) === 0x04034b50 && (office || indexOf(head, "[Content_Types].xml", 0, Math.min(head.length, 1024)) >= 0)) return "ooxml";
  // a password-protected Office file is an OLE compound file, not a zip
  if (office && u32le(head, 0) === 0xe011cfd0 && u32le(head, 4) === 0xe11ab1a1) return "ooxml";
  return null;
}

// ---------------------------------------------------------------- inventory
interface Cut { id: string; start: number; end: number }
interface XmlPart { path: string; xml: string; cuts: Cut[] }
interface ZipEntry {
  name: string; flags: number; method: number; crc: number; csize: number; usize: number;
  local: number; dataStart: number; end: number; nameLen: number; central: Bytes;
}
interface OoxmlPlan {
  kind: "ooxml"; encrypted: boolean; entries: ZipEntry[]; xml: XmlPart[]; thumbnails: string[];
  pictures: { path: string; cats: Category[] }[]; blocked: Map<string, string>; metaText: string; rels: string | null; types: string | null; relsName?: string; typesName?: string;
}
interface PdfPatch { off: number; len: number; fill: "space" | "string" }
interface PdfXmp { start: number; len: number; ids: string[]; props: XmpProp[]; cleanable: boolean }
interface PdfPlan {
  kind: "pdf"; encrypted: boolean; patches: Map<string, PdfPatch[]>; xmp: PdfXmp[]; blocked: Map<string, string>;
  raw: Map<string, string[]>;            // the bytes each value was stored as, for the final scan
  scan: [number, number][];              // byte ranges that hold metadata (not content) and must be clean afterwards
}
export interface DocInventory extends Inventory { docFormat: DocFormat; doc: OoxmlPlan | PdfPlan }

function newInventory(name: string, fmt: DocFormat, size: number, doc: OoxmlPlan | PdfPlan): DocInventory {
  return { filename: name, fmt: fmt as unknown as C.Format, kind: "document" as unknown as Kind, size, width: 0, height: 0, orientation: 1,
    fields: [], aiSignals: [], gps: null, errors: [], exif: null, xmp: [], iptc: [], icc: null, c2pa: [], docFormat: fmt, doc };
}

/** Add a field once (by id). */
function add(inv: DocInventory, f: Field): Field {
  const have = inv.fields.find(x => x.id === f.id);
  if (have) return have;
  inv.fields.push(f);
  return f;
}
const info = (id: string, label: string, value: string, risk: Risk = "medium", cat: Category = "personal",
  note = "Kept as it is. Delete it in the app you made the document with if you don't want to share it.") =>
  F(id, cat, "Document", label, label, value, risk, false, note, true);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const names = (a: string[]) => [...new Set(a.map(s => s.trim()).filter(Boolean))];
const USER_PATH = /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\]+|\/(?:Users|home)\/[^/]+/i;

// ---------------------------------------------------------------- safe inflate
/** Inflate with a hard cap on output, fed in small slices so a zip bomb stops early. */
function inflateCapped(data: Bytes, raw: boolean, cap = MAX_ENTRY): Bytes {
  const inf = new Inflate({ raw }) as Inflate & { ended: boolean };
  const chunks: Bytes[] = [];
  let total = 0;
  inf.onData = (c: unknown) => { const b = c as Bytes; total += b.length; if (total <= cap) chunks.push(b); };
  const STEP = 16 * 1024;
  for (let i = 0; i < data.length && !inf.ended && total <= cap; i += STEP) inf.push(data.subarray(i, i + STEP), i + STEP >= data.length);
  if (!data.length) inf.push(data, true);
  if (total > cap) throw new DocError("Part of this document is unusually large.");
  if (inf.err || !inf.ended) throw new DocError(DAMAGED);
  return concat(chunks);
}

// ---------------------------------------------------------------- zip
async function readZip(src: Source): Promise<{ entries: ZipEntry[]; cdStart: number; comment: Bytes }> {
  const tailLen = Math.min(src.size, 22 + 65535);
  const tail = await src.read(src.size - tailLen, tailLen);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32le(tail, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new DocError(DAMAGED);
  const eocd = src.size - tailLen + e;
  const count = u16le(tail, e + 10), cdSize = u32le(tail, e + 12), cdOff = u32le(tail, e + 16), clen = u16le(tail, e + 20);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff || (e >= 20 && u32le(tail, e - 20) === 0x07064b50)) throw new DocError(ZIP64);
  if (cdOff + cdSize > eocd || count > MAX_ENTRIES) throw new DocError(DAMAGED);
  const cd = await src.read(cdOff, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || u32le(cd, p) !== 0x02014b50) throw new DocError(DAMAGED);
    const n = u16le(cd, p + 28), m = u16le(cd, p + 30), k = u16le(cd, p + 32), end = p + 46 + n + m + k;
    if (end > cd.length) throw new DocError(DAMAGED);
    const csize = u32le(cd, p + 20), usize = u32le(cd, p + 24), local = u32le(cd, p + 42);
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new DocError(ZIP64);
    entries.push({ name: utf8Decode(cd, p + 46, p + 46 + n), flags: u16le(cd, p + 8), method: u16le(cd, p + 10), crc: u32le(cd, p + 16),
      csize, usize, local, dataStart: 0, end: 0, nameLen: 0, central: cd.slice(p, end) });
    p = end;
  }
  entries.sort((a, b) => a.local - b.local);
  let prevEnd = 0;
  for (const en of entries) {
    if (en.local < prevEnd || en.local + 30 > cdOff) throw new DocError(DAMAGED);  // overlapping parts: refuse
    const h = await src.read(en.local, 30);
    if (h.length < 30 || u32le(h, 0) !== 0x04034b50) throw new DocError(DAMAGED);
    en.nameLen = u16le(h, 26);
    en.dataStart = en.local + 30 + en.nameLen + u16le(h, 28);
    let end = en.dataStart + en.csize;
    if (end > cdOff) throw new DocError(DAMAGED);
    if (en.flags & 8) {
      const dd = await src.read(end, 16);
      end = Math.min(cdOff, end + (u32le(dd, 0) === 0x08074b50 ? 16 : 12));
    }
    en.end = prevEnd = end;
  }
  return { entries, cdStart: cdOff, comment: (await src.read(eocd + 22, clen)).slice() };
}

/** All the parts read while checking one document, decompressed, together: a small file can't make us inflate gigabytes. */
interface ReadBudget { left: number }
const TOO_MUCH = "This document holds more packed data than can be checked.";
const readBudget = (size: number): ReadBudget => ({ left: Math.min(512 * 1024 * 1024, 64 * 1024 * 1024 + 2 * size) });

async function entryData(src: Source, en: ZipEntry, budget?: ReadBudget): Promise<Bytes> {
  if (en.flags & 1) throw new DocError("Part of this document is locked with a password.");
  if (en.csize > MAX_ENTRY || en.usize > MAX_ENTRY) throw new DocError("Part of this document is unusually large.");
  const cap = budget ? Math.min(MAX_ENTRY, budget.left) : MAX_ENTRY;
  if (budget && en.usize > budget.left) { budget.left = 0; throw new DocError(TOO_MUCH); }
  const raw = await src.read(en.dataStart, en.csize);
  let out: Bytes;
  if (en.method === 0) out = raw.slice();
  else if (en.method === 8) {
    try { out = inflateCapped(raw, true, cap); }
    catch (e) { if (budget && cap < MAX_ENTRY && e instanceof DocError && e.message !== DAMAGED) { budget.left = 0; throw new DocError(TOO_MUCH); } throw e; }
  } else throw new DocError("Part of this document is compressed in a way that isn't supported.");
  if (budget) budget.left = Math.max(0, budget.left - out.length);
  if (crc32(out) !== en.crc) throw new DocError(DAMAGED);
  return out;
}

/** The first bytes of a part, without decompressing the rest. Empty when they can't be read. */
async function entryHead(src: Source, en: ZipEntry, n = 32): Promise<Bytes> {
  if (en.flags & 1 || !en.csize) return new Uint8Array(0);
  const raw = await src.read(en.dataStart, Math.min(en.csize, 2048));
  if (en.method === 0) return raw.slice(0, n);
  if (en.method !== 8) return new Uint8Array(0);
  const inf = new Inflate({ raw: true, chunkSize: 64 }) as Inflate & { ended: boolean };
  const chunks: Bytes[] = [];
  let total = 0;
  inf.onData = (c: unknown) => { if (total < n) { const b = c as Bytes; chunks.push(b); total += b.length; } };
  for (let i = 0; i < raw.length && total < n && !inf.ended; i += 256) inf.push(raw.subarray(i, i + 256), false);
  return concat(chunks).slice(0, n);
}
/** A picture format the photo engine reads, by its first bytes (the name of a part can't be trusted). */
const isPicture = (h: Bytes) => h.length >= 12 && C_PIC.some(sig => sig(h));
const C_PIC: ((h: Bytes) => boolean)[] = [
  h => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  h => h[0] === 0x89 && latin1(h, 1, 4) === "PNG",
  h => latin1(h, 0, 4) === "RIFF" && latin1(h, 8, 12) === "WEBP",
  h => latin1(h, 4, 8) === "ftyp",
  h => ["II*\0", "MM\0*", "II+\0", "MM\0+"].includes(latin1(h, 0, 4)),
];

function xmlText(b: Bytes): string {
  if (b[0] === 0xff && b[1] === 0xfe) { let s = ""; for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8)); return s; }
  if (b[0] === 0xfe && b[1] === 0xff) { let s = ""; for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]); return s; }
  return utf8Decode(b);
}
/** Written back as UTF-8 (Office's own encoding); a UTF-16 declaration is corrected to match. */
const xmlBytes = (s: string) => utf8Encode(s.replace(/^(\uFEFF?<\?xml[^>]*encoding=["'])UTF-16(["'])/i, "$1UTF-8$2"));

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) => s.replace(/&(#x?[0-9a-fA-F]{1,6}|\w{1,8});/g, (m, e: string) => {
  if (e[0] !== "#") return ENT[e] ?? m;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});

interface XmlChild { qname: string; local: string; start: number; end: number; attrs: string; inner: string }
const MAX_CHILDREN = 200_000;
const NAME_END = /[\s/>=<"']/;
/** A start or end tag at `lt`: its name, attributes and where it ends (quotes honoured). null when it isn't well formed. */
function readTag(xml: string, lt: number): { name: string; attrs: string; end: number; selfClose: boolean; close: boolean } | null {
  let i = lt + 1;
  const close = xml[i] === "/";
  if (close) i++;
  const ns = i;
  while (i < xml.length && !NAME_END.test(xml[i])) i++;
  if (i === ns) return null;
  const name = xml.slice(ns, i);
  const as = i;
  let quote = "";
  for (; i < xml.length; i++) {
    const c = xml[i];
    if (quote) { if (c === quote) quote = ""; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === "<") return null;
    else if (c === ">") {
      const selfClose = !close && xml[i - 1] === "/";
      const attrs = xml.slice(as, selfClose ? i - 1 : i);
      if (close && attrs.trim()) return null;
      return { name, attrs, end: i + 1, selfClose, close };
    }
  }
  return null;
}
/** Skips a comment, processing instruction, CDATA section or declaration at `lt`; -1 when unterminated, lt when it is none of these. */
function skipSpecial(xml: string, lt: number): number {
  const closeOf = (open: string, close: string) => { if (!xml.startsWith(open, lt)) return -2; const q = xml.indexOf(close, lt + open.length); return q < 0 ? -1 : q + close.length; };
  for (const [o, c] of [["<!--", "-->"], ["<![CDATA[", "]]>"], ["<?", "?>"], ["<!", ">"]]) { const r = closeOf(o, c); if (r !== -2) return r; }
  return lt;
}
/**
 * The direct children of the root element, with their exact spans. Linear: one pass over the text, every element's
 * end tag checked against its start tag. `complete` is false when any part couldn't be read; the caller must then
 * refuse to vouch for the part, since a detail could be hidden after the point where reading stopped.
 */
function xmlChildren(xml: string): { children: XmlChild[]; complete: boolean } {
  const out: XmlChild[] = [];
  let p = 0, root = "";
  for (;;) {   // the prolog, up to the root start tag
    p = xml.indexOf("<", p);
    if (p < 0) return { children: out, complete: !xml.trim() };
    const q = skipSpecial(xml, p);
    if (q < 0) return { children: out, complete: false };
    if (q > p) { p = q; continue; }
    const t = readTag(xml, p);
    if (!t || t.close) return { children: out, complete: false };
    if (t.selfClose) return { children: out, complete: true };
    root = t.name; p = t.end;
    break;
  }
  const stack: string[] = [];
  let cur: { qname: string; start: number; attrs: string; innerStart: number } | null = null;
  for (;;) {
    const lt = xml.indexOf("<", p);
    if (lt < 0) return { children: out, complete: false };   // the root never closes
    const q = skipSpecial(xml, lt);
    if (q < 0) return { children: out, complete: false };
    if (q > lt) { p = q; continue; }
    const t = readTag(xml, lt);
    if (!t) return { children: out, complete: false };
    p = t.end;
    if (t.close) {
      if (!stack.length) return { children: out, complete: t.name === root };
      if (stack.pop() !== t.name) return { children: out, complete: false };
      if (!stack.length && cur) {
        const local = cur.qname.includes(":") ? cur.qname.slice(cur.qname.indexOf(":") + 1) : cur.qname;
        out.push({ qname: cur.qname, local, start: cur.start, end: t.end, attrs: cur.attrs, inner: xml.slice(cur.innerStart, lt) });
        cur = null;
      }
      continue;
    }
    if (!stack.length) {
      if (out.length >= MAX_CHILDREN) return { children: out, complete: false };
      if (t.selfClose) {
        const local = t.name.includes(":") ? t.name.slice(t.name.indexOf(":") + 1) : t.name;
        out.push({ qname: t.name, local, start: lt, end: t.end, attrs: t.attrs, inner: "" });
        continue;
      }
      cur = { qname: t.name, start: lt, attrs: t.attrs, innerStart: t.end };
    }
    if (!t.selfClose) stack.push(t.name);
  }
}
const innerText = (s: string) => unescapeXml(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const attr = (attrs: string, name: string) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? unescapeXml(m[1] ?? m[2] ?? "") : null;
};

const CORE: Record<string, [string, string, Category, Risk]> = {
  creator: ["dc:creator", "Author", "personal", "high"],
  lastModifiedBy: ["cp:lastModifiedBy", "Last edited by", "personal", "high"],
  created: ["dcterms:created", "Created", "personal", "medium"],
  modified: ["dcterms:modified", "Last modified", "personal", "medium"],
  lastPrinted: ["cp:lastPrinted", "Last printed", "personal", "medium"],
  revision: ["cp:revision", "Times saved", "personal", "low"],
  title: ["dc:title", "Title", "personal", "medium"],
  subject: ["dc:subject", "Subject", "personal", "medium"],
  keywords: ["cp:keywords", "Keywords", "personal", "medium"],
  description: ["dc:description", "Description", "personal", "medium"],
  category: ["cp:category", "Category", "personal", "medium"],
  contentStatus: ["cp:contentStatus", "Status", "personal", "low"],
  identifier: ["dc:identifier", "Identifier", "personal", "medium"],
  version: ["cp:version", "Version", "personal", "low"],
};
const APP: Record<string, [string, Category, Risk]> = {
  Company: ["Company", "personal", "high"], Manager: ["Manager", "personal", "high"], Template: ["Template", "personal", "medium"],
  HyperlinkBase: ["Hyperlink base", "personal", "medium"], TotalTime: ["Total editing time", "personal", "medium"],
  Application: ["App used", "device", "low"], AppVersion: ["App version", "device", "low"],
};
const minutes = (n: number) => n < 60 ? plural(n, "minute") : `${plural(Math.floor(n / 60), "hour")}${n % 60 ? ` ${plural(n % 60, "minute")}` : ""}`;

/** Pictures by name, anywhere in the package; any other part (but XML) is also checked by its first bytes. */
const MEDIA = /\.(jpe?g|jpe|jfif|pjpeg|pjp|png|apng|webp|heic|heif|hif|avif|tiff?)$/i;
const NOT_PICTURE = /\.(xml|rels|vml)$/i;
const PARTIAL = "Part of this document's details couldn't be read completely, so it can't be checked.";

async function inspectOoxml(inv: DocInventory, src: Source) {
  const plan = inv.doc as OoxmlPlan;
  const head = await src.read(0, 8);
  if (u32le(head, 0) === 0xe011cfd0) {
    plan.encrypted = true;
    inv.errors.push("This document is locked with a password, so its details can't be read.");
    add(inv, info("ooxml:encrypted", "Locked with a password", "Its hidden details can't be read or removed until the password is removed",
      "medium", "other", "Open it in Office, remove the password (File › Info › Protect), save, and try again."));
    return;
  }
  const zip = await readZip(src);
  plan.entries = zip.entries;
  // OPC part names are case-insensitive and relationship targets may be written as "/x", "./x" or "a/../x":
  // normalise both sides, and refuse to vouch for a package where two parts normalise to the same name.
  const norm = (p: string) => {
    const out: string[] = [];
    for (const seg of p.replace(/\\/g, "/").split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") out.pop(); else out.push(seg);
    }
    return out.join("/").toLowerCase();
  };
  const byName = new Map<string, ZipEntry>();
  for (const en of zip.entries) {
    const k = norm(en.name);
    if (byName.has(k)) {
      inv.errors.push("This document contains two parts with the same name, so it can't be checked reliably.");
      plan.blocked.set(`ooxml:dup:${k}`, "This document contains duplicate parts.");
    } else byName.set(k, en);
  }
  const real = (p: string) => byName.get(norm(p))?.name ?? p;
  const meta: string[] = [];
  const budget = readBudget(src.size);
  const read = async (path: string, metaPart = false): Promise<string | null> => {
    const en = byName.get(norm(path));
    if (!en) return null;
    try {
      const t = xmlText(await entryData(src, en, budget));
      if (metaPart) meta.push(t);
      return t;
    } catch (e) {
      inv.errors.push(`Couldn't read ${path}: ${e instanceof Error ? e.message : e}`);
      if (metaPart) plan.blocked.set(`ooxml:part:${path}`, "Part of this document's details couldn't be read, so it can't be checked.");
      return null;
    }
  };

  /** The details in a part; when the part can't be read completely, say so and refuse to vouch for it. */
  const children = (path: string, xml: string) => {
    const r = xmlChildren(xml);
    if (!r.complete) {
      inv.errors.push(`Couldn't read all of ${path}.`);
      plan.blocked.set(`ooxml:part:${path}`, PARTIAL);
    }
    return r.children;
  };

  // where the package says its details live
  plan.relsName = real("_rels/.rels");
  plan.typesName = real("[Content_Types].xml");
  plan.rels = await read(plan.relsName, true);
  plan.types = await read(plan.typesName);
  const target = (type: string, fallback: string) => {
    const re = /<Relationship\b[^>]*>/g;
    let m: RegExpExecArray | null;
    while (plan.rels && (m = re.exec(plan.rels))) {
      const t = attr(m[0].slice(13), "Type"), tg = attr(m[0].slice(13), "Target");
      if (t && tg && t.endsWith(type)) return real(tg);
    }
    return fallback;
  };
  const corePath = target("/core-properties", real("docProps/core.xml")), appPath = target("/extended-properties", real("docProps/app.xml"));
  const customPath = target("/custom-properties", real("docProps/custom.xml"));

  const core = await read(corePath, true);
  if (core !== null) {
    const part: XmlPart = { path: corePath, xml: core, cuts: [] };
    for (const c of children(corePath, core)) {
      const value = innerText(c.inner);
      if (!value) continue;
      // a property this list doesn't know is still a detail of the document: it is shown and removed like the rest
      const [qn, label, cat0, risk] = CORE[c.local] ?? [c.qname, c.qname, "personal", "medium"];
      const [cat, r] = isAiText(value) ? ["ai", "high"] as const : [cat0, risk];
      const id = `ooxml:core:${qn}`;
      add(inv, F(id, cat, "Office", qn, label, value, r));
      part.cuts.push({ id, start: c.start, end: c.end });
    }
    plan.xml.push(part);
  }
  const app = await read(appPath, true);
  if (app !== null) {
    const part: XmlPart = { path: appPath, xml: app, cuts: [] };
    for (const c of children(appPath, app)) {
      const def = APP[c.local];
      let value = innerText(c.inner);
      if (!def || !value) continue;
      let [label, cat, risk] = def;
      if (c.local === "TotalTime") { const n = parseInt(value, 10); if (!(n > 0)) continue; value = minutes(n); }
      if (c.local === "Template" || c.local === "HyperlinkBase") risk = USER_PATH.test(value) ? "high" : /[\\/]/.test(value) || c.local === "HyperlinkBase" ? "medium" : "low";
      if (isAiText(value)) [cat, risk] = ["ai", "high"];
      const id = `ooxml:app:${c.local}`;
      add(inv, F(id, cat, "Office", c.local, label, value, risk));
      part.cuts.push({ id, start: c.start, end: c.end });
    }
    plan.xml.push(part);
  }
  const custom = await read(customPath, true);
  if (custom !== null) {
    const part: XmlPart = { path: customPath, xml: custom, cuts: [] };
    for (const c of children(customPath, custom)) {
      if (c.local !== "property") continue;
      const name = attr(c.attrs, "name") ?? "property", value = innerText(c.inner);
      const id = `ooxml:custom:${name}`;
      const high = /author|owner|user|e-?mail|manager|company|editor|creator|by$/i.test(name);
      const [cat, risk] = isAiText(value) ? ["ai", "high"] as const : ["personal", high ? "high" : "medium"] as const;
      add(inv, F(id, cat, "Office", name, `Custom: ${name}`, value || "(empty)", risk));
      part.cuts.push({ id, start: c.start, end: c.end });
    }
    plan.xml.push(part);
  }

  // Apple's Office writer adds its own small details part
  const appleMetaPath = real("docProps/meta.xml");
  const appleMeta = await read(appleMetaPath, true);
  if (appleMeta !== null) {
    const part: XmlPart = { path: appleMetaPath, xml: appleMeta, cuts: [] };
    for (const c of children(appleMetaPath, appleMeta)) {
      const value = innerText(c.inner);
      if (!value) continue;
      const id = `ooxml:meta:${c.local}`;
      add(inv, c.local === "generator" ? F(id, isAiText(value) ? "ai" : "device", "Office", c.local, "App used", value, isAiText(value) ? "high" : "low")
        : F(id, "other", "Office", c.local, c.local, value, "low"));
      part.cuts.push({ id, start: c.start, end: c.end });
    }
    plan.xml.push(part);
  }

  // a small picture of the first page, saved for file browsers
  const thumbs = new Set<string>();
  const tp = target("/thumbnail", "");
  if (tp && byName.has(norm(tp))) thumbs.add(byName.get(norm(tp))!.name);
  for (const en of zip.entries) if (/^docProps\/thumbnail\.\w+$/i.test(en.name)) thumbs.add(en.name);
  plan.thumbnails = [...thumbs];
  if (thumbs.size) {
    const en = byName.get(norm(plan.thumbnails[0]))!;
    add(inv, F("ooxml:thumbnail", "personal", "Office", "thumbnail", "Preview image",
      `${(en.name.split(".").pop() ?? "").toUpperCase()} picture of the first page, ${en.usize.toLocaleString("en-US")} bytes`, "medium", false,
      "A small picture of the first page saved inside the file. It can show an older version of the document."));
  }

  // pictures placed in the document carry their own details
  // (any part named like a picture, or starting like one; a picture that can't be checked is never passed over in silence)
  let unchecked = 0, tooMuch = false, tooMany = false;
  for (const en of zip.entries) {
    if (thumbs.has(en.name) || en.name.endsWith("/") || NOT_PICTURE.test(en.name)) continue;
    if (!MEDIA.test(en.name) && !isPicture(await entryHead(src, en))) continue;
    if (budget.left <= 0 || plan.pictures.length >= MAX_PICTURES) { unchecked++; if (budget.left <= 0) tooMuch = true; else tooMany = true; continue; }
    let pinv: Inventory;
    try { pinv = inspect(await entryData(src, en, budget), en.name.split("/").pop()!); }
    catch (e) { unchecked++; if (e instanceof DocError && e.message === TOO_MUCH) tooMuch = true; continue; }
    if (pinv.fmt === ("unknown" as C.Format) || pinv.errors.length) { unchecked++; continue; }
    const groups = new Map<Category, Field[]>();
    for (const f of pinv.fields) {
      if (f.category === "technical" || f.risk === "none") continue;
      groups.set(f.category, [...groups.get(f.category) ?? [], f]);
    }
    if (!groups.size) continue;
    const base = en.name.split("/").pop()!;
    for (const [cat, fs] of groups) {
      const value = cat === "location" && pinv.gps ? `${pinv.gps[0].toFixed(4)}, ${pinv.gps[1].toFixed(4)}`
        : names(fs.map(f => f.label)).slice(0, 4).join(", ") + (fs.length > 4 ? "…" : "");
      add(inv, F(`ooxml:media:${en.name}:${cat}`, cat, "Picture", base, `Picture ${base}: ${CATEGORIES[cat].toLowerCase()}`, value,
        maxRisk(fs.map(f => f.risk)), true, "Details saved inside a picture placed in the document. The picture itself is not changed."));
    }
    plan.pictures.push({ path: en.name, cats: [...groups.keys()] });
  }
  if (unchecked) {
    inv.errors.push(tooMuch || tooMany ? `${tooMuch ? TOO_MUCH : "This document has too many pictures to check them all."} ${plural(unchecked, "picture")} inside couldn't be checked.`
      : `${plural(unchecked, "picture")} inside couldn't be read, so ${unchecked === 1 ? "its" : "their"} details couldn't be checked.`);
    plan.blocked.set("ooxml:pictures:unchecked", "Some pictures inside couldn't be checked, so details may remain in them.");
  }

  // shown, never changed: comments, tracked changes, embedded files, macros
  let comments = 0, tracked = 0, legacyXl = 0, threadedXl = 0;
  const who: string[] = [];
  for (const en of zip.entries) {
    const n = en.name;
    const isComments = /^word\/comments\.xml$/i.test(n) || /^xl\/comments\d*\.xml$/i.test(n) || /^xl\/threadedComments\/[^/]+\.xml$/i.test(n)
      || /^ppt\/comments\/[^/]+\.xml$/i.test(n);
    const isBody = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(n);
    const isRevs = /^xl\/revisions\/revisionHeaders\.xml$/i.test(n);
    const isPeople = /^(word\/people\.xml|xl\/persons\/person\.xml|ppt\/commentAuthors\.xml|ppt\/authors\.xml)$/i.test(n);
    if (!isComments && !isBody && !isRevs && !isPeople) continue;
    const t = await read(n);
    if (t === null) continue;
    const all = (re: RegExp) => [...t.matchAll(re)].map(m => unescapeXml(m[1] ?? ""));
    if (isComments) {
      const n2 = (t.match(/<w:comment\b|<comment\b|<threadedComment\b|<(?:\w+:)?cm\b/g) ?? []).length;
      if (/^xl\/comments/i.test(n)) legacyXl += n2; else if (/^xl\/threaded/i.test(n)) threadedXl += n2; else comments += n2;
      who.push(...all(/\bw:author="([^"]*)"/g), ...all(/<author>([^<]*)<\/author>/g));
    } else if (isBody) {
      const tags = t.match(/<w:(?:ins|del|moveFrom|moveTo|rPrChange|pPrChange)\b[^>]*>/g) ?? [];
      tracked += tags.length;
      for (const tag of tags) { const a = /w:author="([^"]*)"/.exec(tag); if (a) who.push(unescapeXml(a[1])); }
    } else if (isRevs) {
      tracked += (t.match(/<header\b/g) ?? []).length;
      who.push(...all(/\buserName="([^"]*)"/g));
    } else {
      who.push(...all(/\b(?:w15:author|displayName|name)="([^"]*)"/g));
    }
  }
  comments += Math.max(legacyXl, threadedXl);   // Excel keeps a plain copy of each threaded comment
  const by = names(who);
  const byText = by.length ? ` · by ${by.slice(0, 3).join(", ")}${by.length > 3 ? ` and ${by.length - 3} more` : ""}` : "";
  if (comments) add(inv, info("ooxml:comments", "Comments", `${plural(comments, "comment")}${byText}`));
  if (tracked) add(inv, info("ooxml:tracked", "Tracked changes", `${plural(tracked, "tracked change")}${byText}`));
  const embedded = zip.entries.filter(en => /^(word|xl|ppt)\/embeddings\//i.test(en.name)).length;
  if (embedded) add(inv, info("ooxml:embedded", "Embedded files", `${plural(embedded, "embedded file")} (other documents or objects placed inside)`, "medium", "other"));
  if (zip.entries.some(en => /vbaProject\.bin$/i.test(en.name))) add(inv, info("ooxml:macros", "Macros", "Contains macros (small programs)", "medium", "other"));

  // folder paths and names saved where nobody looks
  const pathRisk = (v: string): Risk => USER_PATH.test(v) ? "high" : /[\\/]/.test(v) ? "medium" : "low";
  const cannot = "It can't be removed safely here. Remove it in the app you made the document with, or use \"Save as\" to a new file.";
  // Excel: the folder the workbook was last saved in (x15ac:absPath)
  const mainPath = target("/officeDocument", "");
  for (const path of new Set([mainPath, real("xl/workbook.xml")])) {
    if (!path || !/\.xml$/i.test(path) || !byName.has(norm(path)) || norm(path) === norm(corePath)) continue;
    const t = await read(path);
    if (t === null || !/absPath\b/.test(t)) continue;
    const tags = [...t.matchAll(/<(?:[\w.\-]+:)?absPath\b[^<>]*>/g)].map(m => m[0]);
    const value = names(tags.map(tag => attr(tag.slice(1), "url") ?? "")).join(" · ") || "(a folder path)";
    const id = "ooxml:absPath", risk = pathRisk(value);
    // Excel writes it alone in its own alternate-content block, which can be dropped whole
    const blocks = [...t.matchAll(/<([\w.\-]+):AlternateContent\b[^<>]*>\s*<\1:Choice\b[^<>]*>\s*<(?:[\w.\-]+:)?absPath\b[^<>]*\/>\s*<\/\1:Choice>\s*<\/\1:AlternateContent>/g)];
    const removable = blocks.length === tags.length && (t.match(/absPath\b/g) ?? []).length === tags.length;
    add(inv, F(id, "personal", "Office", "absPath", "Folder it was saved in", value, risk === "low" ? "medium" : risk, true,
      removable ? "The folder on your computer where the workbook was saved, which can show your user name." : `The folder on your computer where the workbook was saved. ${cannot}`));
    meta.push(tags.join("\n"));
    if (removable) plan.xml.push({ path, xml: t, cuts: blocks.map(b => ({ id, start: b.index!, end: b.index! + b[0].length })) });
    else plan.blocked.set(id, "A folder path saved inside this document couldn't be removed safely.");
  }
  // Word: the template it was made from, as a full path (word/_rels/settings.xml.rels)
  for (const en of zip.entries) {
    if (!/(^|\/)_rels\/[^/]+\.rels$/i.test(en.name) || en.name === plan.relsName) continue;
    const rels = await read(en.name);
    if (rels === null || !/attachedTemplate/.test(rels)) continue;
    const owner = real(en.name.replace(/(^|\/)_rels\/([^/]+)\.rels$/i, "$1$2"));
    const relEls = [...rels.matchAll(/<Relationship\b[^<>]*?(?:\/>|>\s*<\/Relationship>)/g)].filter(m => (attr(m[0].slice(13), "Type") ?? "").endsWith("/attachedTemplate"));
    const value = names(relEls.map(m => attr(m[0].slice(13), "Target") ?? "")).join(" · ") || "(a template path)";
    const id = `ooxml:template:${en.name}`, risk = pathRisk(value);
    // removable when there is exactly one, and exactly one w:attachedTemplate element points at it
    let cuts: { rel: Cut; own: Cut } | null = null;
    const ownerXml = relEls.length === 1 && (rels.match(/attachedTemplate/g) ?? []).length === 1 ? await read(owner) : null;
    if (ownerXml !== null) {
      const rid = attr(relEls[0][0].slice(13), "Id");
      const els = [...ownerXml.matchAll(/<(?:[\w.\-]+:)?attachedTemplate\b([^<>]*?)\/>/g)];
      const refs = [...els[0]?.[1]?.matchAll(/\s[\w.\-]+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/g) ?? []];
      if (rid && els.length === 1 && (ownerXml.match(/attachedTemplate/g) ?? []).length === 1 && refs.length === 1 && (refs[0][1] ?? refs[0][2]) === rid)
        cuts = { rel: { id, start: relEls[0].index!, end: relEls[0].index! + relEls[0][0].length }, own: { id, start: els[0].index!, end: els[0].index! + els[0][0].length } };
    }
    add(inv, F(id, "personal", "Office", "attachedTemplate", "Template it was made from", value, risk, true,
      cuts ? "The full path of the template, which can show your user name." : `The full path of the template. ${cannot}`));
    meta.push(relEls.map(m => m[0]).join("\n"));
    if (cuts) { plan.xml.push({ path: en.name, xml: rels, cuts: [cuts.rel] }); plan.xml.push({ path: owner, xml: ownerXml!, cuts: [cuts.own] }); }
    else if (risk !== "low") plan.blocked.set(id, "A template path saved inside this document couldn't be removed safely.");
  }
  // SharePoint and OneDrive keep people's names (and sometimes e-mail addresses) in customXml: shown, can't be removed safely
  for (const en of zip.entries) {
    if (!/^customXml\/item\d*\.xml$/i.test(en.name)) continue;
    const t = await read(en.name);
    if (t === null) continue;
    const found = names([...[...t.matchAll(/<(?:[\w.\-]+:)?DisplayName\b[^<>]*>([^<]+)</g)].map(m => unescapeXml(m[1])),
      ...(t.match(/[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+/g) ?? []), ...(t.match(new RegExp(USER_PATH.source, "gi")) ?? [])]);
    if (!found.length) continue;
    const id = `ooxml:customXml:${en.name}`;
    add(inv, F(id, "personal", "Office", en.name, "Names saved by SharePoint or OneDrive", found.slice(0, 3).join(", ") + (found.length > 3 ? "…" : ""), "high", true,
      `Saved with the document's online properties. ${cannot}`));
    plan.blocked.set(id, "Names saved by SharePoint or OneDrive couldn't be removed safely.");
  }

  if (zip.comment.length && zip.comment.some(b => b !== 0 && b !== 32)) {
    add(inv, F("ooxml:zip:comment", "other", "Zip", "comment", "Package comment", utf8Decode(zip.comment), "medium"));
  }
  plan.metaText = meta.join("\n");
}

// ---------------------------------------------------------------- PDF parsing
const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;
const isDigit = (c: number) => c >= 48 && c <= 57;
const WINDOW = 8 * 1024 * 1024;   // no single dictionary is read further than this

type PV =
  | { t: "dict"; s: number; e: number; entries: { key: string; ks: number; v: PV }[] }
  | { t: "arr"; s: number; e: number; items: PV[] }
  | { t: "str"; s: number; e: number; bytes: Bytes }
  | { t: "name"; s: number; e: number; v: string }
  | { t: "num"; s: number; e: number; v: number }
  | { t: "ref"; s: number; e: number; n: number }
  | { t: "kw"; s: number; e: number; v: string };
type Dict = Extract<PV, { t: "dict" }>;

const get = (d: PV | null | undefined, key: string): PV | undefined => {
  if (!d || d.t !== "dict") return undefined;
  for (let i = d.entries.length - 1; i >= 0; i--) if (d.entries[i].key === key) return d.entries[i].v;
  return undefined;
};
const nameOf = (v: PV | undefined) => (v?.t === "name" ? v.v : undefined);

function skipWs(d: Bytes, p: number, end: number): number {
  while (p < end) {
    const c = d[p];
    if (WS[c]) p++;
    else if (c === 0x25) { while (p < end && d[p] !== 10 && d[p] !== 13) p++; }
    else break;
  }
  return p;
}

function readLiteral(d: Bytes, p: number, end: number): { e: number; bytes: Bytes } | null {
  let depth = 1, i = p + 1, n = 0;
  const out = new Uint8Array(Math.min(end - p, 1 << 20));
  const put = (c: number) => { if (n < out.length) out[n++] = c; };
  while (i < end) {
    const c = d[i++];
    if (c === 0x5c) {
      if (i >= end) break;
      const x = d[i++];
      if (x >= 48 && x <= 55) {
        let v = x - 48;
        for (let k = 0; k < 2 && i < end && d[i] >= 48 && d[i] <= 55; k++) v = v * 8 + d[i++] - 48;
        put(v & 255);
      } else if (x === 13) { if (d[i] === 10) i++; }
      else if (x !== 10) put(({ 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 } as Record<number, number>)[x] ?? x);
    } else if (c === 0x28) { depth++; put(c); }
    else if (c === 0x29) { if (--depth === 0) return { e: i, bytes: out.slice(0, n) }; put(c); }
    else put(c);
  }
  return null;
}

function readHex(d: Bytes, p: number, end: number): { e: number; bytes: Bytes | null } {
  const out: number[] = [];
  let hi = -1;
  for (let i = p + 1; i < end; i++) {
    const c = d[i];
    if (c === 0x3e) { if (hi >= 0) out.push(hi << 4); return { e: i + 1, bytes: new Uint8Array(out) }; }
    if (WS[c]) continue;
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v < 0) return { e: i, bytes: null };
    if (hi < 0) hi = v; else { if (out.length < 1 << 20) out.push((hi << 4) | v); hi = -1; }
  }
  return { e: end, bytes: null };
}

function readToken(d: Bytes, p: number, end: number): number {
  while (p < end && !WS[d[p]] && !DELIM[d[p]]) p++;
  return p;
}

interface Budget { n: number; far?: number }
const fail = (b: Budget, at: number) => { b.far = Math.max(b.far ?? 0, at); return null; };

function parseValue(d: Bytes, p: number, end: number, depth: number, budget: Budget): PV | null {
  if (depth > 48 || --budget.n < 0) return null;
  p = skipWs(d, p, end);
  if (p >= end) return null;
  const c = d[p];
  if (c === 0x3c && d[p + 1] === 0x3c) {
    const entries: { key: string; ks: number; v: PV }[] = [];
    let q = p + 2;
    for (;;) {
      q = skipWs(d, q, end);
      if (q >= end) return fail(budget, q);
      if (d[q] === 0x3e && d[q + 1] === 0x3e) return { t: "dict", s: p, e: q + 2, entries };
      if (d[q] !== 0x2f) return null;
      const ke = readToken(d, q + 1, end);
      const v = parseValue(d, ke, end, depth + 1, budget);
      if (!v) return null;
      entries.push({ key: nameText(d, q + 1, ke), ks: q, v });
      q = v.e;
    }
  }
  if (c === 0x3c) { const h = readHex(d, p, end); return h.bytes ? { t: "str", s: p, e: h.e, bytes: h.bytes } : fail(budget, h.e); }
  if (c === 0x28) { const l = readLiteral(d, p, end); return l ? { t: "str", s: p, e: l.e, bytes: l.bytes } : fail(budget, end); }
  if (c === 0x5b) {
    const items: PV[] = [];
    let q = p + 1;
    for (;;) {
      q = skipWs(d, q, end);
      if (q >= end) return fail(budget, q);
      if (d[q] === 0x5d) return { t: "arr", s: p, e: q + 1, items };
      const v = parseValue(d, q, end, depth + 1, budget);
      if (!v) return null;
      items.push(v);
      q = v.e;
    }
  }
  if (c === 0x2f) { const e = readToken(d, p + 1, end); return { t: "name", s: p, e, v: nameText(d, p + 1, e) }; }
  if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) {
    const e = readToken(d, p, end);
    const v = parseFloat(latin1(d, p, Math.min(e, p + 32)));
    // "N G R" is a reference
    if (isDigit(c) && e > p && /^\d{1,10}$/.test(latin1(d, p, e))) {
      const g = skipWs(d, e, end), ge = readToken(d, g, end);
      if (ge > g && ge - g <= 5 && /^\d+$/.test(latin1(d, g, ge))) {
        const r = skipWs(d, ge, end);
        if (d[r] === 0x52 && (r + 1 >= end || WS[d[r + 1]] || DELIM[d[r + 1]])) return { t: "ref", s: p, e: r + 1, n: v };
      }
    }
    return { t: "num", s: p, e: Math.max(e, p + 1), v: Number.isFinite(v) ? v : 0 };
  }
  const e = readToken(d, p, end);
  if (e === p) return null;
  return { t: "kw", s: p, e, v: latin1(d, p, Math.min(e, p + 16)) };
}

function nameText(d: Bytes, s: number, e: number): string {
  return latin1(d, s, Math.min(e, s + 128)).replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function pdfText(b: Bytes): string {
  let s = "";
  if (b[0] === 0xfe && b[1] === 0xff) for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  else if (b[0] === 0xff && b[1] === 0xfe) for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8));
  else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) s = utf8Decode(b, 3);
  else s = latin1(b);
  return s.replace(/\0/g, "").trim();
}
function pdfDate(s: string): string {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+\-])?(\d{2})?'?(\d{2})?/.exec(s);
  if (!m) return s;
  const tz = m[7] === "Z" ? " UTC" : m[7] && m[8] ? ` ${m[7]}${m[8]}:${m[9] ?? "00"}` : "";
  return `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}${m[4] ? ` ${m[4]}:${m[5] ?? "00"}:${m[6] ?? "00"}` : ""}${tz}`;
}

interface PObj { n: number; at: number; v: PV; end: number; stream?: { start: number; len: number; exact: boolean }; inStm?: boolean }

/** Every "N G obj" in file order, including objects from earlier saved versions. Stream data is skipped, not searched. */
function scanObjects(d: Bytes): { objs: PObj[]; complete: boolean; overruns: [number, number][]; badEnds: number } {
  const out: PObj[] = [];
  const overruns: [number, number][] = [];   // bytes a stream's stated length claims beyond where it really ends
  let badEnds = 0;                          // streams whose end marker isn't where their length says
  let pos = 0, failed = 0;
  const allowance = 2 * d.length + 16 * 1024 * 1024;   // bytes re-read by objects that turn out to be damaged
  while (pos < d.length) {
    if (out.length >= MAX_OBJECTS || failed > allowance) return { objs: out, complete: false, overruns, badEnds };
    const i = indexOf(d, "obj", pos);
    if (i < 0) break;
    pos = i + 3;
    if (i + 3 < d.length && !WS[d[i + 3]] && !DELIM[d[i + 3]]) continue;
    let q = i - 1;
    if (q < 0 || !WS[d[q]]) continue;
    while (q >= 0 && WS[d[q]]) q--;
    const ge = q + 1;
    while (q >= 0 && isDigit(d[q])) q--;
    if (ge - (q + 1) < 1 || ge - (q + 1) > 5 || q < 0 || !WS[d[q]]) continue;
    while (q >= 0 && WS[d[q]]) q--;
    const ne = q + 1;
    while (q >= 0 && isDigit(d[q])) q--;
    const ns = q + 1;
    if (ne - ns < 1 || ne - ns > 10 || (q >= 0 && !WS[d[q]] && !DELIM[d[q]])) continue;
    const budget = { n: 200000, far: 0 };
    const v = parseValue(d, i + 3, Math.min(d.length, i + 3 + WINDOW), 0, budget);
    if (!v) { failed += Math.max(0, budget.far - i); continue; }
    const obj: PObj = { n: +latin1(d, ns, ne), at: ns, v, end: v.e };
    pos = Math.max(pos, v.e);
    if (v.t === "dict") {
      const k = skipWs(d, v.e, d.length);
      if (latin1(d, k, k + 6) === "stream") {
        let s = k + 6;
        if (d[s] === 13) s++;
        if (d[s] === 10) s++;
        const L = get(v, "Length");
        let len = 0, exact = false;
        if (L?.t === "num" && Number.isInteger(L.v) && L.v >= 0 && s + L.v <= d.length) {
          len = L.v;
          const after = skipWs(d, s + L.v, d.length);
          exact = latin1(d, after, after + 9) === "endstream";
          // an end marker inside the stated length: the length may be too long and swallow the objects after it
          // (their details would then go unseen). Read on from the first end marker, and say the file is damaged.
          const inner = indexOf(d, "endstream", s, s + L.v);
          if (inner >= 0) {
            let e = inner;
            if (e > s && d[e - 1] === 10) e--;
            if (e > s && d[e - 1] === 13) e--;
            overruns.push([inner, s + L.v]);
            len = e - s;
            exact = true;
            badEnds++;
          } else if (!exact) badEnds++;   // a damaged end marker doesn't move the data, but the file isn't what it says
        } else {
          const e = indexOf(d, "endstream", s, Math.min(d.length, s + 4 * WINDOW + 9));
          if (e >= 0) {
            len = e - s;
            if (len > 0 && d[s + len - 1] === 10) len--;
            if (len > 0 && d[s + len - 1] === 13) len--;
            exact = true;
          } else badEnds++;
        }
        obj.stream = { start: s, len, exact };
        pos = Math.max(pos, s + len);
        obj.end = s + len;
      }
    }
    out.push(obj);
  }
  return { objs: out, complete: true, overruns, badEnds };
}

/** Decoded stream data when it is plain or Flate-only; null when the filters can't be undone here. */
function streamData(d: Bytes, o: PObj): { data: Bytes; plain: boolean } | null {
  if (!o.stream || o.stream.len > MAX_ENTRY * 2) return null;
  const raw = d.subarray(o.stream.start, o.stream.start + o.stream.len);
  const f = get(o.v, "Filter");
  const filters = f === undefined ? [] : f.t === "name" ? [f.v] : f.t === "arr" ? f.items.map(nameOf) : [undefined];
  if (!filters.length) return { data: raw, plain: true };
  if (filters.length === 1 && filters[0] === "FlateDecode" && !get(o.v, "DecodeParms")) {
    try { return { data: inflateCapped(raw, false), plain: false }; } catch { return null; }
  }
  return null;
}

/** Objects packed inside compressed object streams (PDF 1.5+). They can be read but not edited in place. */
function objStmObjects(d: Bytes, objs: PObj[], inv: DocInventory): PObj[] {
  const out: PObj[] = [];
  let total = 0;
  for (const o of objs) {
    if (nameOf(get(o.v, "Type")) !== "ObjStm" || !o.stream) continue;
    const s = streamData(d, o);
    if (!s) { inv.errors.push("Part of this PDF is compressed in a way that can't be read."); continue; }
    total += s.data.length;
    if (total > MAX_STM_TOTAL) { inv.errors.push("This PDF has too many compressed sections to read them all."); break; }
    const nObj = get(o.v, "N"), first = get(o.v, "First");
    if (nObj?.t !== "num" || first?.t !== "num") continue;
    const sd = s.data;
    let p = 0;
    const pairs: [number, number][] = [];
    for (let k = 0; k < Math.min(nObj.v, 100000); k++) {
      const a = parseValue(sd, p, first.v, 0, { n: 4 }), b = a && parseValue(sd, a.e, first.v, 0, { n: 4 });
      if (!a || !b || a.t !== "num" || b.t !== "num") break;
      pairs.push([a.v, b.v]);
      p = b.e;
    }
    for (const [num, off] of pairs) {
      const at = first.v + off;
      if (at < 0 || at >= sd.length) continue;
      const v = parseValue(sd, at, sd.length, 0, { n: 50000 });
      if (v) out.push({ n: num, at: -1, v, end: -1, inStm: true });
    }
  }
  return out;
}

const INFO: Record<string, [string, Category, Risk]> = {
  Author: ["Author", "personal", "high"], Creator: ["App used to make it", "device", "low"], Producer: ["PDF made by", "device", "low"],
  Title: ["Title", "personal", "medium"], Subject: ["Subject", "personal", "medium"], Keywords: ["Keywords", "personal", "medium"],
  CreationDate: ["Created", "personal", "medium"], ModDate: ["Last modified", "personal", "medium"],
  Company: ["Company", "personal", "high"], Manager: ["Manager", "personal", "high"], SourceModified: ["Source last modified", "personal", "medium"],
};
const INFO_SIGNS = ["Author", "Creator", "Producer", "CreationDate", "ModDate"];
const COMMENT_TYPES = new Set(["Text", "FreeText", "Highlight", "Underline", "StrikeOut", "Squiggly", "Ink", "Caret", "Stamp", "Line",
  "Square", "Circle", "Polygon", "PolyLine", "FileAttachment", "Sound", "Redact"]);
const XMP_NS: Record<string, string> = { "http://ns.adobe.com/pdf/1.3/": "pdf", "http://ns.adobe.com/pdfx/1.3/": "pdfx",
  "http://www.aiim.org/pdfa/ns/id/": "pdfaid", "http://www.aiim.org/pdfua/ns/id/": "pdfuaid" };

async function inspectPdf(inv: DocInventory, src: Source) {
  const plan = inv.doc as PdfPlan;
  const d = await src.read(0, src.size);
  const { objs, complete, overruns, badEnds } = scanObjects(d);
  if (badEnds) {
    inv.errors.push("Part of this PDF is damaged: a section's stated length doesn't match where it ends.");
    plan.blocked.set("pdf:length", "Part of this PDF is damaged, and some details may still be inside it.");
  }
  // objects inside the bytes a stream claims as its own can't be changed: a reader that trusts the length sees them as content
  const swallowed = (o: PObj) => !o.inStm && overruns.some(([s, e]) => o.at < e && o.end > s);
  if (!complete) {
    inv.errors.push("This PDF is too damaged or complex to check completely.");
    plan.blocked.set("pdf:incomplete", "This PDF is too damaged or complex to check completely, so some details may remain.");
  }
  if (!objs.length) inv.errors.push("No readable objects were found in this PDF.");

  // trailers (classic and cross-reference streams)
  const trailers: Dict[] = [];
  for (let p = 0, k = 0; k < 10000; k++) {
    const i = indexOf(d, "trailer", p);
    if (i < 0) break;
    p = i + 7;
    const v = parseValue(d, p, Math.min(d.length, p + WINDOW), 0, { n: 20000 });
    if (v?.t === "dict") trailers.push(v);
  }
  for (const o of objs) if (nameOf(get(o.v, "Type")) === "XRef" && o.v.t === "dict") trailers.push(o.v);
  plan.encrypted = trailers.some(t => get(t, "Encrypt") !== undefined);
  const linearized = objs.slice(0, 3).some(o => get(o.v, "Linearized") !== undefined);

  // earlier saved versions: each incremental update adds a %%EOF
  let eofs = 0;
  for (let p = 0; eofs < 100000;) { const i = indexOf(d, "%%EOF", p); if (i < 0) break; eofs++; p = i + 5; }
  const earlier = eofs - 1 - (linearized ? 1 : 0);
  if (earlier > 0) add(inv, info("pdf:revisions", "Earlier saved versions", `${plural(earlier, "earlier version")} saved inside this PDF`, "medium", "personal",
    "Kept as they are. Their hidden details are cleaned too, but their content stays: use \"Save as\" or \"Print to PDF\" to drop them."));

  if (plan.encrypted) {
    inv.errors.push("This PDF is encrypted, so its details can't be read or removed safely.");
    add(inv, info("pdf:encrypted", "Locked (encrypted) PDF", "Its hidden details are scrambled and can't be read or removed here", "medium", "other",
      "Remove the password or encryption in your PDF app, save, and try again."));
    return;
  }

  const packed = objStmObjects(d, objs, inv);
  const all = [...objs, ...packed];
  const latest = new Map<number, PObj>();
  for (const o of all) latest.set(o.n, o);

  // the Info dictionaries: everything any trailer points to, plus orphaned ones from earlier versions
  const infoRefs = new Set<number>();
  const infoDicts: { o: PObj; dict: Dict }[] = [];
  for (const t of trailers) {
    const v = get(t, "Info");
    if (v?.t === "ref") infoRefs.add(v.n);
    else if (v?.t === "dict") infoDicts.push({ o: { n: -1, at: v.s, v, end: v.e }, dict: v });
  }
  for (const o of all) {
    if (o.v.t !== "dict" || o.stream) continue;
    const type = nameOf(get(o.v, "Type"));
    if (type && type !== "Info") continue;
    const looks = INFO_SIGNS.some(k => get(o.v, k)?.t === "str") && !get(o.v, "Subtype") && !get(o.v, "Parent") && !get(o.v, "S");
    if (infoRefs.has(o.n) || looks) infoDicts.push({ o, dict: o.v });
  }
  for (const n of infoRefs) if (!all.some(o => o.n === n)) inv.errors.push("This PDF's details block couldn't be found.");

  // newest first, so the main field shows the current value; older, different values become their own fields
  const seen = new Map<string, string>();   // key + value -> field id
  const count = new Map<string, number>();
  for (const { o, dict } of [...infoDicts].reverse()) {
    if (!o.inStm && o.at >= 0) plan.scan.push([o.at, o.end]);
    for (const en of dict.entries) {
      if (en.key === "Trapped") continue;
      let v = en.v, target: PObj | undefined;
      if (v.t === "ref") { target = latest.get(v.n); if (!target) continue; v = target.v; }
      const text = v.t === "str" ? pdfText(v.bytes) : v.t === "name" ? v.v : v.t === "num" ? String(v.v)
        : v.t === "arr" ? v.items.map(x => (x.t === "str" ? pdfText(x.bytes) : x.t === "name" ? x.v : "")).filter(Boolean).join(", ") : "";
      if (!text) continue;
      const value = /Date$/.test(en.key) || en.key === "SourceModified" ? pdfDate(text) : text;
      let [label, cat, risk] = INFO[en.key] ?? [en.key, "personal", "medium"] as [string, Category, Risk];
      if (isAiText(value)) [cat, risk] = ["ai", "high"];
      const sig = `${en.key}\0${value}`;
      let id = seen.get(sig);
      if (!id) {
        const k = (count.get(en.key) ?? 0) + 1;
        count.set(en.key, k);
        id = k === 1 ? `pdf:info:${en.key}` : `pdf:info:${en.key}:${k}`;
        seen.set(sig, id);
        add(inv, F(id, cat, "PDF", en.key, k === 1 ? label : `${label} (earlier version)`, value, risk));
      }
      if (o.inStm || target?.inStm) {
        plan.blocked.set(id, "Some details are stored in a compressed part of this PDF that can't be changed safely.");
        continue;
      }
      if (swallowed(o) || (target && swallowed(target))) {
        plan.blocked.set(id, "Some details are stored in a damaged part of this PDF that can't be changed safely.");
        continue;
      }
      const list = plan.patches.get(id) ?? [];
      list.push({ off: en.ks, len: en.v.e - en.ks, fill: "space" });
      if (target && target.v.t === "str") {
        list.push({ off: target.v.s, len: target.v.e - target.v.s, fill: "string" });
        plan.scan.push([target.at, target.end]);
      }
      plan.patches.set(id, list);
      const raws = plan.raw.get(id) ?? [];
      raws.push(latin1(d, v.s, Math.min(v.e, v.s + 200)));
      plan.raw.set(id, raws);
    }
  }

  // XMP metadata streams (document level, and any attached to pages or pictures)
  // A details block is found three ways: marked as one, pointed to by a /Metadata entry, or plainly holding an XMP packet.
  const metaRefs = new Set<number>();
  for (const o of all) for (const dict of dictsIn(o.v)) { const m = get(dict, "Metadata"); if (m?.t === "ref") metaRefs.add(m.n); }
  for (const o of objs) {
    if (!o.stream) continue;
    const marked = nameOf(get(o.v, "Type")) === "Metadata", pointed = metaRefs.has(o.n);
    const plainXmp = get(o.v, "Filter") === undefined && o.stream.len > 0 &&
      (indexOf(d, "<x:xmpmeta", o.stream.start, o.stream.start + o.stream.len) >= 0 || indexOf(d, "<?xpacket", o.stream.start, o.stream.start + o.stream.len) >= 0);
    if (!marked && !pointed && !plainXmp) continue;
    const st = nameOf(get(o.v, "Subtype"));
    if (st && st !== "XML" && !pointed && !plainXmp) continue;
    const s = o.stream.exact ? streamData(d, o) : null;
    plan.scan.push([o.at, o.end]);
    if (!s) {
      const id = `pdf:xmp:${o.n}`;
      add(inv, F(id, "personal", "PDF", "XMP", "Details block (XMP)", "Stored in a way that can't be read here", "medium", false));
      plan.blocked.set(id, "A details block in this PDF is compressed in a way that can't be read or changed.");
      continue;
    }
    const tmp = { fields: [] as Field[], xmp: [] as XmpProp[] } as unknown as Inventory;
    const text = utf8Decode(s.data);
    readXmpInto(tmp, text);
    if (!tmp.fields.length && XMP_PROPERTY.test(text)) {
      // there are properties in it, but too damaged to list: the whole block is replaced
      tmp.fields.push(F(`pdf:xmp:${o.n}`, "personal", "XMP", "XMP", "Details block (XMP)", "Damaged; its details couldn't be listed", "medium", false));
    }
    const ids: string[] = [];
    const props: XmpProp[] = [];
    for (const p of tmp.xmp) {
      const prefix = XMP_NS[p.ns];
      if (prefix) p.qname = `${prefix}:${p.qname.split(":").slice(1).join(":")}`;
      props.push(p);
    }
    tmp.fields.forEach((f, i) => {
      const p = tmp.xmp[i];
      if (p) { f.id = `xmp:${p.qname}`; f.name = p.qname; }
      if (/^(xmp:CreatorTool|pdf:Producer)$/.test(f.name) && !isAiText(f.value)) { f.category = "device"; f.risk = "low"; f.label = f.name.endsWith("Tool") ? "App used to make it" : "PDF made by"; }
      if (f.name === "dc:creator" && f.category === "personal") { f.risk = "high"; f.label = "Author"; }
      if (/^pdfu?aid:/.test(f.name)) { f.category = "technical"; f.risk = "none"; }
      add(inv, f);
      ids.push(f.id);
    });
    if (!ids.length) continue;
    if (swallowed(o)) {
      for (const id of ids) plan.blocked.set(id, "A details block is stored in a damaged part of this PDF that can't be changed safely.");
      continue;
    }
    plan.xmp.push({ start: o.stream.start, len: o.stream.len, ids, props, cleanable: s.plain });
    if (!s.plain) for (const id of ids) if (inv.fields.find(f => f.id === id)?.category !== "technical")
      plan.blocked.set(id, "A details block in this PDF is compressed, so it couldn't be cleaned without changing the file's layout.");
  }

  // shown, never changed
  let comments = 0, forms = 0, attachments = 0, scripts = 0;
  const who: string[] = [];
  for (const o of all) {
    for (const dict of dictsIn(o.v)) {
      const sub = nameOf(get(dict, "Subtype")), type = nameOf(get(dict, "Type"));
      if (sub && COMMENT_TYPES.has(sub) && (!type || type === "Annot")) {
        comments++;
        const t = get(dict, "T");
        if (t?.t === "str") who.push(pdfText(t.bytes));
      }
      const v = get(dict, "V");
      if (get(dict, "FT") && v && !(v.t === "str" && !v.bytes.length) && !(v.t === "name" && v.v === "Off")) forms++;
      if (type === "Filespec" && get(dict, "EF")) attachments++;
      if (get(dict, "JS") !== undefined || nameOf(get(dict, "S")) === "JavaScript") scripts++;
    }
  }
  if (!attachments) attachments = objs.filter(o => nameOf(get(o.v, "Type")) === "EmbeddedFile").length;
  const by = names(who);
  if (comments) add(inv, info("pdf:annotations", "Comments", `${plural(comments, "comment")}${by.length ? ` · by ${by.slice(0, 3).join(", ")}${by.length > 3 ? ` and ${by.length - 3} more` : ""}` : ""}`));
  if (forms) add(inv, info("pdf:forms", "Filled-in form", `${plural(forms, "filled form field")}`, "medium", "other"));
  if (attachments) add(inv, info("pdf:attachments", "Attached files", `${plural(attachments, "attached file")}`, "medium", "other"));
  if (scripts) add(inv, info("pdf:javascript", "Scripts", "Contains JavaScript", "medium", "other"));

  // the final scan also covers bytes outside every object we could read (damage can hide details there)
  const spans = objs.filter(o => o.at >= 0).map(o => [o.at, o.end] as [number, number]).sort((a, b) => a[0] - b[0]);
  let at = 0;
  const gaps: [number, number][] = [];
  for (const [s, e] of spans) { if (s > at) gaps.push([at, s]); at = Math.max(at, e); }
  if (at < d.length) gaps.push([at, d.length]);
  plan.scan.push(...gaps);
  // a damaged object can't be read, so its details can't be listed or removed: if one looks like it holds some, say so
  if (gaps.some(([s, e]) => DAMAGE_SIGNS.some(k => indexOf(d, k, s, e) >= 0) || brokenObject(d, s, e))) {
    inv.errors.push("Part of this PDF is damaged and couldn't be read.");
    plan.blocked.set("pdf:damaged", "Part of this PDF is damaged, and some details may still be inside it.");
  }
}
/** An XMP property element or attribute (anything namespaced other than the rdf/x scaffolding). */
const XMP_PROPERTY = /<(?!\/|rdf:|x:|\?)[A-Za-z][\w.\-]*:[A-Za-z]|\s(?!rdf:|xmlns|x:)[A-Za-z][\w.\-]*:[A-Za-z][\w.\-]*\s*=/;
const DAMAGE_SIGNS = ["/Author", "/Creator", "/Producer", "/CreationDate", "/ModDate", "/Company", "xmpmeta"].map(ascii);

/** An "N G obj" header between the objects that could be read: an object too damaged to parse. */
function brokenObject(d: Bytes, s: number, e: number): boolean {
  for (let i = indexOf(d, "obj", s, e); i >= 0; i = indexOf(d, "obj", i + 3, e)) {
    let q = i - 1;
    if (!WS[d[q]]) continue;
    while (q > s && WS[d[q]]) q--;
    if (isDigit(d[q])) return true;
  }
  return false;
}

/** A dictionary and the dictionaries nested directly inside it (annotations are often inline in /Annots arrays). */
function dictsIn(v: PV, out: Dict[] = [], depth = 0): Dict[] {
  if (depth > 6 || out.length > 5000) return out;
  if (v.t === "dict") { out.push(v); for (const e of v.entries) if (e.v.t === "dict" || e.v.t === "arr") dictsIn(e.v, out, depth + 1); }
  else if (v.t === "arr") for (const x of v.items) if (x.t === "dict" || x.t === "arr") dictsIn(x, out, depth + 1);
  return out;
}

// ---------------------------------------------------------------- public: inspect
export async function inspectDocument(src: Source, name: string): Promise<DocInventory> {
  if (src.size > MAX_DOC) throw new DocError("This document is too large (over 200 MB).");
  const head = await src.read(0, 1024);
  const kind = detectDoc(head, name);
  if (!kind) throw new DocError("Not a supported document.");
  let fmt: DocFormat = "pdf";
  if (kind === "ooxml") {
    const ext = (/\.(\w+)$/.exec(name)?.[1] ?? "").toLowerCase();
    fmt = ext.startsWith("x") ? "xlsx" : ext.startsWith("p") ? "pptx" : "docx";
  }
  const plan: OoxmlPlan | PdfPlan = kind === "pdf"
    ? { kind: "pdf", encrypted: false, patches: new Map(), xmp: [], blocked: new Map(), raw: new Map(), scan: [] }
    : { kind: "ooxml", encrypted: false, entries: [], xml: [], thumbnails: [], pictures: [], blocked: new Map(), metaText: "", rels: null, types: null };
  const inv = newInventory(name, fmt, src.size, plan);
  if (kind === "pdf") {
    try { await inspectPdf(inv, src); } catch (e) {
      if (e instanceof DocError) throw e;
      inv.errors.push(`PDF read error: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    // a zip we can't read is a DocError: there is nothing safe to do with it
    try { await inspectOoxml(inv, src); } catch (e) { throw e instanceof DocError ? e : new DocError(DAMAGED); }
    if (plan.kind === "ooxml" && !plan.encrypted && fmt === "docx" && !/\.(docx|docm|dotx|dotm)$/i.test(name)) {
      const has = (p: string) => plan.entries.some(e => e.name.toLowerCase().startsWith(p.toLowerCase()));
      inv.docFormat = has("xl/") ? "xlsx" : has("ppt/") ? "pptx" : "docx";
      inv.fmt = inv.docFormat as unknown as C.Format;
    }
  }
  inv.aiSignals = aiSignals(inv);
  return inv;
}

// ---------------------------------------------------------------- public: clean
export interface DocResult {
  parts: Part[]; size: number; before: DocInventory; after: DocInventory;
  removed: Field[]; kept: Field[]; verified: boolean; residual: Field[];
  /** true when everything people can see (text, pictures' pixels, layout) is byte-for-byte the original */
  pixelsUntouched: boolean; notes: string[];
}

function setU16(b: Bytes, o: number, v: number) { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; }
function setU32(b: Bytes, o: number, v: number) { b.set(le32(v), o); }

async function cleanOoxml(inv: DocInventory, src: Source, intended: Set<string>, notes: string[]): Promise<{ parts: Part[]; content: boolean }> {
  const plan = inv.doc as OoxmlPlan;
  if (plan.encrypted) return { parts: [{ from: 0, to: src.size }], content: true };
  const replace = new Map<string, Bytes>();
  const drop = new Set<string>();
  for (const part of plan.xml) {
    const cuts = part.cuts.filter(c => !intended.has(c.id)).sort((a, b) => b.start - a.start);
    if (!cuts.length) continue;
    let xml = part.xml;
    for (const c of cuts) xml = xml.slice(0, c.start) + xml.slice(c.end);
    replace.set(part.path, xmlBytes(xml));
  }
  if (plan.thumbnails.length && !intended.has("ooxml:thumbnail")) {
    plan.thumbnails.forEach(t => drop.add(t));
    const isThumb = (target: string | null) => !!target && plan.thumbnails.includes(target.replace(/^\/+/, ""));
    if (plan.rels !== null) {
      const rels = plan.rels.replace(/<Relationship\b[^>]*?(?:\/>|>\s*<\/Relationship>)/g, m => (isThumb(attr(m.slice(13), "Target")) ? "" : m));
      if (rels !== plan.rels) replace.set(plan.relsName ?? "_rels/.rels", xmlBytes(rels));
    }
    if (plan.types !== null) {
      const types = plan.types.replace(/<Override\b[^>]*?(?:\/>|>\s*<\/Override>)/g, m => (isThumb(attr(m.slice(9), "PartName")) ? "" : m));
      if (types !== plan.types) replace.set(plan.typesName ?? "[Content_Types].xml", xmlBytes(types));
    }
  }
  let content = true;
  const byName = new Map(plan.entries.map(e => [e.name, e] as const));
  for (const pic of plan.pictures) {
    const keep = pic.cats.filter(c => intended.has(`ooxml:media:${pic.path}:${c}`));
    if (keep.length === pic.cats.length) continue;
    const en = byName.get(pic.path);
    if (!en) continue;
    try {
      const data = await entryData(src, en);
      const r = clean(data, pic.path.split("/").pop()!, { keepCategories: [...keep, "technical"], keepIcc: true });
      if (!r.pixelsUntouched) { notes.push("A picture inside couldn't be cleaned without changing it, so it was left as it is."); continue; }
      if (r.removed.some(f => f.category !== "technical")) replace.set(pic.path, r.data);
    } catch {
      notes.push("A picture inside couldn't be cleaned, so it was left as it is.");
    }
  }

  const parts: Part[] = [];
  const central: Bytes[] = [];
  let at = 0;
  for (const en of plan.entries) {
    if (drop.has(en.name)) continue;
    const nb = replace.get(en.name);
    const cen = en.central.slice();
    setU32(cen, 42, at);
    if (!nb) {
      parts.push({ from: en.local, to: en.end });   // the original bytes, header and all
      central.push(cen);
      at += en.end - en.local;
      continue;
    }
    const method = en.method === 0 ? 0 : 8;
    const comp = method === 0 ? nb : deflateRaw(nb, { level: 9 });
    const crc = crc32(nb);
    const lh = new Uint8Array(30 + en.nameLen);
    lh.set((await src.read(en.local, 30 + en.nameLen)).subarray(0, 30 + en.nameLen));
    const flags = en.flags & ~0x0008;
    for (const [b, o] of [[lh, 6], [cen, 8]] as const) setU16(b, o, flags);
    for (const [b, o] of [[lh, 8], [cen, 10]] as const) setU16(b, o, method);
    for (const [b, o] of [[lh, 14], [cen, 16]] as const) { setU32(b, o, crc); setU32(b, o + 4, comp.length); setU32(b, o + 8, nb.length); }
    setU16(lh, 28, 0);   // no extra field on rewritten parts
    parts.push({ bytes: concat([lh, comp]) });
    central.push(cen);
    at += lh.length + comp.length;
  }
  const cd = concat(central);
  const eocd = new Uint8Array(22);
  setU32(eocd, 0, 0x06054b50);
  setU16(eocd, 8, central.length); setU16(eocd, 10, central.length);
  setU32(eocd, 12, cd.length); setU32(eocd, 16, at);
  parts.push({ bytes: concat([cd, eocd]) });
  return { parts, content };
}

const EMPTY_XMP = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta><?xpacket end="w"?>';

async function cleanPdf(inv: DocInventory, src: Source, intended: Set<string>, notes: string[]): Promise<Part[]> {
  const plan = inv.doc as PdfPlan;
  if (plan.encrypted) return [{ from: 0, to: src.size }];
  const edits: { off: number; bytes: Bytes }[] = [];
  for (const [id, list] of plan.patches) {
    if (intended.has(id)) continue;
    for (const p of list) {
      const b = new Uint8Array(p.len).fill(0x20);
      if (p.fill === "string" && p.len >= 2) b.set(ascii("()"));
      edits.push({ off: p.off, bytes: b });
    }
  }
  for (const x of plan.xmp) {
    if (!x.cleanable || x.ids.every(id => intended.has(id) || inv.fields.find(f => f.id === id)?.category === "technical")) continue;
    const keep = x.props.filter(p => intended.has(`xmp:${p.qname}`));
    let packet = utf8Encode(keep.length ? buildXmp(keep) : EMPTY_XMP);
    if (packet.length > x.len) {
      if (keep.length) notes.push("Some details you chose to keep didn't fit and were removed.");
      packet = utf8Encode(EMPTY_XMP);
      if (packet.length > x.len) packet = new Uint8Array(0);
    }
    const b = new Uint8Array(x.len).fill(0x20);
    b.set(packet);
    edits.push({ off: x.start, bytes: b });
  }
  edits.sort((a, b) => a.off - b.off);
  // merge overlapping edits into runs, and stitch them between untouched ranges of the original
  const parts: Part[] = [];
  let at = 0;
  for (let i = 0; i < edits.length;) {
    const s = Math.max(edits[i].off, at);
    let e = edits[i].off + edits[i].bytes.length, j = i + 1;
    while (j < edits.length && edits[j].off < e) { e = Math.max(e, edits[j].off + edits[j].bytes.length); j++; }
    e = Math.min(e, src.size);
    if (e > s) {
      const run = (await src.read(s, e - s)).slice();
      for (let k = i; k < j; k++) {
        const ed = edits[k];
        for (let q = 0; q < ed.bytes.length; q++) { const pos = ed.off + q - s; if (pos >= 0 && pos < run.length) run[pos] = ed.bytes[q]; }
      }
      if (s > at) parts.push({ from: at, to: s });
      parts.push({ bytes: run });
      at = e;
    }
    i = j;
  }
  if (at < src.size) parts.push({ from: at, to: src.size });
  return parts;
}

/** The text of a removed detail must not be found where details live. Content (and kept details) can't count. */
async function stillContains(inv: DocInventory, after: DocInventory, out: Source, removed: Field[], kept: Field[]): Promise<Field[]> {
  const keptText = kept.map(f => f.value).join("\n");
  const needles = removed
    .filter(f => (f.risk === "medium" || f.risk === "high") && !f.informational && f.source !== "Picture")
    .flatMap(f => {
      const vs = [f.value.slice(0, 40)];
      if (inv.doc.kind === "pdf") vs.push(...(inv.doc.raw.get(f.id) ?? []).map(r => r.slice(0, 60)));
      return vs.filter(v => v.length >= 6 && !keptText.includes(v)).map(v => ({ f, v }));
    });
  if (!needles.length) return [];
  const found = new Set<Field>();
  if (after.doc.kind === "ooxml") {
    for (const { f, v } of needles) if (after.doc.metaText.includes(v) || after.doc.metaText.includes(v.replace(/&/g, "&amp;"))) found.add(f);
  } else if (inv.doc.kind === "pdf") {
    for (const [s, e] of inv.doc.scan) {
      if (e - s > 64 * 1024 * 1024) continue;
      const chunk = await out.read(s, e - s);
      for (const { f, v } of needles) {
        if (found.has(f)) continue;
        const b = /[^\x00-\xff]/.test(v) ? utf8Encode(v) : ascii(v);
        if (indexOf(chunk, b) >= 0) found.add(f);
      }
    }
  }
  return [...found];
}

export async function cleanDocument(src: Source, name: string, o: Options, before?: DocInventory): Promise<DocResult> {
  const inv = before ?? await inspectDocument(src, name);
  const intended = new Set(inv.fields.filter(f => wants(f, o)).map(f => f.id));
  const notes: string[] = [];
  let parts: Part[], content = true;
  if (inv.doc.kind === "ooxml") ({ parts, content } = await cleanOoxml(inv, src, intended, notes));
  else parts = await cleanPdf(inv, src, intended, notes);
  const out = partsSource(src, parts);
  let after: DocInventory;
  try { after = await inspectDocument(out, name); }
  catch { throw new DocError("This document couldn't be cleaned safely."); }
  const afterIds = new Set(after.fields.map(f => f.id));
  const removed = inv.fields.filter(f => !afterIds.has(f.id));
  const kept = after.fields.filter(f => inv.fields.some(b => b.id === f.id));
  const residual = after.fields.filter(f => !intended.has(f.id) && !f.informational && (f.risk === "medium" || f.risk === "high"));
  const leftover = await stillContains(inv, after, out, removed, kept);
  if (leftover.length) notes.push("Part of this document is damaged, and some details may still be inside it.");
  const blocked = [...inv.doc.blocked].filter(([id]) => !intended.has(id));
  for (const reason of new Set(blocked.map(([, r]) => r))) notes.push(reason);
  if (inv.doc.encrypted) notes.push(inv.doc.kind === "pdf"
    ? "This PDF is encrypted, so its hidden details couldn't be removed. Remove the encryption in your PDF app and try again."
    : "This document is locked with a password, so its hidden details couldn't be removed. Remove the password in Office and try again.");
  const shown = inv.fields.filter(f => f.informational && !f.id.endsWith("encrypted"));
  if (shown.length) notes.push("Comments, tracked changes and other things you can see in the document were kept exactly as they are.");
  const sameLength = inv.doc.kind !== "pdf" || out.size === src.size;
  return {
    parts, size: out.size, before: inv, after, removed, kept,
    verified: residual.length === 0 && leftover.length === 0 && blocked.length === 0 && !inv.doc.encrypted && sameLength
      && inv.errors.length === 0 && after.errors.length === 0
      && (after.aiSignals.length === 0 || o.keepCategories.includes("ai")),
    residual: [...residual, ...leftover.filter(f => !residual.includes(f))],
    pixelsUntouched: content && sameLength,
    notes,
  };
}

// ---------------------------------------------------------------- report and highlights
/** toReport with a note that fits documents. */
export function toDocReport(inv: DocInventory): Report {
  const r = toReport(inv);
  r.notes = ["Only hidden details are removed. Comments, tracked changes and everything you can see in the document stay exactly as they are."];
  return r;
}

export type DocHighlight = Omit<Highlight, "key"> & { key: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function day(s?: string) {
  const m = s?.match(/(\d{4})[:\-](\d{2})[:\-](\d{2})/);
  return m && +m[2] >= 1 && +m[2] <= 12 ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : undefined;
}

export function docHighlights(rep: Report): DocHighlight[] {
  const all: Field[] = Object.values(rep.groups).flatMap(g => g.fields);
  const by = (re: RegExp) => all.filter(f => re.test(f.id));
  const val = (re: RegExp) => by(re).map(f => f.value).find(Boolean);
  const out: { p: number; h: DocHighlight }[] = [];
  const push = (p: number, key: string, title: string, value: string, why: string, ids: string[]) =>
    out.push({ p, h: { key, title, value, why, ids } });

  if (rep.ai_signals.length) push(1, "ai", "AI label", "Names an AI app", "Some platforms read this and can label what you share as made with AI.",
    all.filter(f => f.category === "ai" && !f.informational).map(f => f.id));

  const authors = by(/^(ooxml:core:dc:creator|pdf:info:Author(:\d+)?|xmp:dc:creator|ooxml:custom:.*(author|owner|creator).*)$/i);
  const editors = by(/^ooxml:core:cp:lastModifiedBy$/);
  const managers = by(/^(ooxml:app:Manager|pdf:info:Manager)$/);
  const authorNames = names(authors.map(f => f.value));
  if (authors.length || editors.length || managers.length) {
    const bits = [authorNames.slice(0, 2).join(", ")];
    const ed = editors[0]?.value;
    if (ed && !authorNames.includes(ed)) bits.push(`last edited by ${ed}`);
    if (managers[0]) bits.push(`manager ${managers[0].value}`);
    push(2, "personal", "Who wrote it", bits.filter(Boolean).join(" · "), "Shows your name, and the names of anyone who edited the document.",
      [...authors, ...editors, ...managers].map(f => f.id));
  }

  const company = by(/^(ooxml:app:(Company|Template|HyperlinkBase)|pdf:info:Company)$/);
  if (company.length) {
    const tpl = company.find(f => f.name === "Template")?.value;
    const user = tpl && USER_PATH.exec(tpl)?.[0].split(/[\\/]/).pop();
    const bits = [company.find(f => f.name === "Company")?.value, user ? `template from user “${user}”` : tpl && /[\\/]/.test(tpl) ? `template ${tpl}` : "",
      company.find(f => f.name === "HyperlinkBase")?.value];
    push(5, "company", "Company and template", bits.filter(Boolean).join(" · ") || (tpl ?? "Template name"),
      "Your company name and a template path like C:\\Users\\jane\\… can reveal where you work and your computer's username.", company.map(f => f.id));
  }

  const dates = by(/^(ooxml:core:(dcterms:created|dcterms:modified|cp:lastPrinted)|ooxml:app:TotalTime|pdf:info:(CreationDate|ModDate)(:\d+)?|xmp:xmp:(CreateDate|ModifyDate|MetadataDate))$/);
  if (dates.length) {
    const created = day(val(/^(ooxml:core:dcterms:created|pdf:info:CreationDate|xmp:xmp:CreateDate)$/));
    const modified = day(val(/^(ooxml:core:dcterms:modified|pdf:info:ModDate|xmp:xmp:ModifyDate)$/));
    const total = val(/^ooxml:app:TotalTime$/), printed = day(val(/^ooxml:core:cp:lastPrinted$/));
    const bits = [created && `created ${created}`, modified && modified !== created && `edited ${modified}`, total && `${total} of editing`, printed && `printed ${printed}`]
      .filter(Boolean) as string[];
    const value = bits.join(" · ");
    push(8, "dates", "When it was written", value ? value[0].toUpperCase() + value.slice(1) : "Dates saved inside",
      "Shows when the document was created, edited and printed, and how long was spent on it.", dates.map(f => f.id));
  }

  const apps = by(/^(ooxml:meta:generator|ooxml:app:(Application|AppVersion)|pdf:info:(Creator|Producer)(:\d+)?|xmp:(xmp:CreatorTool|pdf:Producer))$/).filter(f => f.category !== "ai");
  if (apps.length) {
    const appName = val(/^ooxml:app:Application$/), ver = val(/^ooxml:app:AppVersion$/);
    const value = appName ? [appName, ver].filter(Boolean).join(" ") : names(apps.map(f => f.value)).slice(0, 2).join(" · ");
    push(9, "device", "App used", value, "Names the app (and version) used to make the file.", apps.map(f => f.id));
  }

  const thumb = by(/^ooxml:thumbnail$/);
  if (thumb.length) push(7, "hidden", "Hidden preview", "Picture of the first page",
    "A small picture of the first page is saved inside the file, and it can show an older version.", thumb.map(f => f.id));

  const pics = all.filter(f => f.source === "Picture");
  if (pics.length) {
    const n = new Set(pics.map(f => f.id.replace(/:[a-z]+$/, ""))).size;
    const what = names(pics.map(f => ({ location: "location", device: "camera details", personal: "names and dates", ai: "AI labels" } as Record<string, string>)[f.category] ?? "other details"));
    push(3, pics.some(f => f.category === "location") ? "location" : "pictures", "Pictures inside",
      `${plural(n, "picture")} with ${what.slice(0, 3).join(", ")}`,
      "Photos placed in the document still carry their own details, like where they were taken. These are removed; the pictures look the same.",
      pics.map(f => f.id));
  }

  const keptWhy = "Kept as they are. Delete them in Word if you don't want to share them.";
  const cm = all.find(f => f.id === "ooxml:comments"), tc = all.find(f => f.id === "ooxml:tracked");
  if (cm || tc) {
    const count = (f?: Field) => f?.value.split(" · ")[0];
    const who = (cm ?? tc)!.value.split(" · ")[1];
    const app = rep.format === ("xlsx" as C.Format) ? "Excel" : rep.format === ("pptx" as C.Format) ? "PowerPoint" : "Word";
    push(4, "comments", "Comments and tracked changes", [count(cm), count(tc), who].filter(Boolean).join(" · "),
      keptWhy.replace("Word", app), [cm, tc].filter(Boolean).map(f => f!.id));
  }
  const pdfShown = by(/^pdf:(annotations|forms|attachments|javascript)$/);
  if (pdfShown.length) {
    const ann = all.find(f => f.id === "pdf:annotations");
    const rest = pdfShown.filter(f => f !== ann).map(f => f.value.toLowerCase());
    push(4, "comments", ann ? "Comments" : "Forms and attachments", [ann?.value, ...rest].filter(Boolean).join(" · "),
      "Kept as they are. Remove them in your PDF app if you don't want to share them.", pdfShown.map(f => f.id));
  }
  const rev = all.find(f => f.id === "pdf:revisions");
  if (rev) push(6, "revisions", "Earlier versions inside", rev.value,
    "This PDF still holds earlier saved versions. Their hidden details are cleaned, but their content stays: \"Save as\" or \"Print to PDF\" drops them.", [rev.id]);

  const keep = new Set(out.sort((a, b) => a.p - b.p).slice(0, 6).map(x => x.h));
  // shown in reading order: people, places and pictures first, then what's kept
  const ORDER = ["ai", "personal", "company", "dates", "device", "hidden", "location", "pictures", "comments", "revisions"];
  return [...keep].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
}

// Keys come from untrusted files: no prototype, so names like "constructor" or "__proto__" are just unknown.
Object.setPrototypeOf(ENT, null);
Object.setPrototypeOf(CORE, null);
Object.setPrototypeOf(APP, null);
Object.setPrototypeOf(INFO, null);
Object.setPrototypeOf(XMP_NS, null);
