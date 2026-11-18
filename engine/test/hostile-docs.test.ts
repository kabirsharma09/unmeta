// Hostile documents from the independent review of the document cleaner. Each one once let a private detail survive a
// clean that said "verified", or made the engine burn seconds of CPU. The rule every case checks: never report a file
// clean while the secret is still in it. Where removal is simple and safe the secret is also gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import { inspect } from "../src/inspect.ts";
import { PRESETS } from "../src/presets.ts";
import type { Part } from "../src/media.ts";
import { cleanDocument, inspectDocument } from "../src/docs.ts";

const ALL = PRESETS.everything.options;
const cat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p.map(x => Buffer.from(x))));
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, "utf8"));
const join = (src: Uint8Array, parts: Part[]) => cat(...parts.map(p => "bytes" in p ? p.bytes : src.subarray(p.from, p.to)));
const src = (b: Uint8Array) => ({ size: b.length, read: async (o: number, n: number) => b.slice(o, Math.min(b.length, o + n)) });
const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url)));
const safe = (verified: boolean, left: boolean, what: string) => assert.ok(!(verified && left), `${what}: reported clean but the secret is still there`);

async function run(file: Uint8Array, name: string) {
  const r = await cleanDocument(src(file), name, ALL);
  return { r, out: join(file, r.parts) };
}

// ---------------------------------------------------------------- builders
/** A stored zip (no compression), or with `deflate` the listed parts compressed. */
function zip(files: [string, Uint8Array | string][], deflate = new Set<string>()): Uint8Array {
  const locals: Buffer[] = [], cds: Buffer[] = [];
  const packed = new Map<unknown, [Buffer, number]>();   // the same data, compressed once
  let off = 0;
  for (const [name, d0] of files) {
    const d = typeof d0 === "string" ? Buffer.from(d0, "utf8") : Buffer.from(d0.buffer, d0.byteOffset, d0.byteLength);
    const method = deflate.has(name) ? 8 : 0;
    if (!packed.has(d0)) packed.set(d0, [method ? deflateRawSync(d) : d, crc32(d) >>> 0]);
    const [body, crc] = method ? packed.get(d0)! : [d, crc32(d) >>> 0];
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, body); cds.push(ch, nb); off += 30 + nb.length + body.length;
  }
  const cd = Buffer.concat(cds), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, e]));
}
const CT = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/></Types>`;
const RELS = (main = "word/document.xml") => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
const DOC = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`;
const core = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${inner}</cp:coreProperties>`;
const docx = (coreInner: string, ...more: [string, Uint8Array | string][]): [string, Uint8Array | string][] =>
  [["[Content_Types].xml", CT], ["_rels/.rels", RELS()], ["word/document.xml", DOC], ["docProps/core.xml", core(coreInner)], ...more];

/** A PDF of numbered objects in revisions (incremental updates), each with its own xref and trailer. */
function pdf(revs: { objs: [number, string][]; trailer: string }[]): Uint8Array {
  let s = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", prev = -1;
  for (const rev of revs) {
    const offs: [number, number][] = [];
    for (const [n, body] of rev.objs) { offs.push([n, s.length]); s += `${n} 0 obj\n${body}\nendobj\n`; }
    const x = s.length;
    s += "xref\n" + offs.map(([n, o]) => `${n} 1\n${String(o).padStart(10, "0")} 00000 n \n`).join("");
    s += `trailer\n${rev.trailer.replace(">>", (prev >= 0 ? ` /Prev ${prev}` : "") + " >>")}\nstartxref\n${x}\n%%EOF\n`;
    prev = x;
  }
  return new Uint8Array(Buffer.from(s, "latin1"));
}
const CONTENT = "BT /F1 12 Tf 10 50 Td (Hello) Tj ET";
const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`;
const stream = (extra: number) => `<< /Length ${CONTENT.length + extra} >>\nstream\n${CONTENT}\nendstream`;
const PAGES: [number, string][] = [[2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"], [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>"]];

// ---------------------------------------------------------------- 1. PDF stream /Length longer than the stream
test("PDF: a stream /Length that runs past its end marker can't hide the XMP or the newest Info after it", async () => {
  const hidesXmp = pdf([{ objs: [[1, "<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>"], ...PAGES, [4, stream(XMP.length + 90)],
    [5, `<< /Type /Metadata /Subtype /XML /Length ${XMP.length} >>\nstream\n${XMP}\nendstream`]], trailer: "<< /Size 6 /Root 1 0 R >>" }]);
  const hidesInfo = pdf([
    { objs: [[1, "<< /Type /Catalog /Pages 2 0 R >>"], ...PAGES, [4, stream(0)], [5, "<< /Producer (X) >>"]], trailer: "<< /Size 7 /Root 1 0 R /Info 5 0 R >>" },
    { objs: [[6, stream(60)], [5, "<< /Author (Jane Doe) /Producer (X) >>"]], trailer: "<< /Size 7 /Root 1 0 R /Info 5 0 R >>" },
  ]);
  for (const [what, file] of [["XMP", hidesXmp], ["Info", hidesInfo]] as const) {
    const { r, out } = await run(file, "a.pdf");
    safe(r.verified, has(out, "Jane Doe"), what);
    assert.equal(r.verified, false, what);
    assert.ok(r.before.fields.some(f => f.value.includes("Jane Doe")), `${what}: the hidden detail is at least listed`);
  }
});

// ---------------------------------------------------------------- 2. XMP stream without /Type /Metadata
test("PDF: an XMP stream without /Type /Metadata, pointed to by the catalog, is found and cleaned", async () => {
  const file = pdf([{ objs: [[1, "<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>"], ...PAGES, [4, stream(0)],
    [5, `<< /Subtype /XML /Length ${XMP.length} >>\nstream\n${XMP}\nendstream`]], trailer: "<< /Size 6 /Root 1 0 R >>" }]);
  const { r, out } = await run(file, "a.pdf");
  safe(r.verified, has(out, "Jane Doe"), "untyped XMP");
  assert.equal(has(out, "Jane Doe"), false);
  assert.equal(out.length, file.length);
  // not even pointed to, just an XMP packet in a plain stream
  const loose = pdf([{ objs: [[1, "<< /Type /Catalog /Pages 2 0 R >>"], ...PAGES, [4, stream(0)],
    [5, `<< /Length ${XMP.length} >>\nstream\n${XMP}\nendstream`]], trailer: "<< /Size 6 /Root 1 0 R >>" }]);
  const l = await run(loose, "a.pdf");
  safe(l.r.verified, has(l.out, "Jane Doe"), "loose XMP");
});

// ---------------------------------------------------------------- 3. OOXML children the old reader stopped at
test("OOXML: a long start tag, a non-ASCII name or 10,001 children don't hide dc:creator; a broken part isn't vouched for", async () => {
  for (const [what, inner] of [
    ["long start tag", `<dc:title${" ".repeat(5000)}>Report</dc:title><dc:creator>Jane Doe</dc:creator>`],
    ["non-ASCII name", `<dc:título>x</dc:título><dc:creator>Jane Doe</dc:creator>`],
    ["10,001 children", `<dc:subject/>`.repeat(10001) + `<dc:creator>Jane Doe</dc:creator>`],
    ["quoted > in an attribute", `<dc:title a="1>2">T</dc:title><dc:creator>Jane Doe</dc:creator>`],
  ]) {
    const file = zip(docx(inner));
    const { r, out } = await run(file, "a.docx");
    safe(r.verified, has(out, "Jane Doe"), what);
    assert.equal(has(out, "Jane Doe"), false, what);
  }
  const broken = zip(docx(`<dc:title>T</dc:titel><dc:creator>Jane Doe</dc:creator>`));
  const b = await run(broken, "a.docx");
  safe(b.r.verified, has(b.out, "Jane Doe"), "mismatched end tag");
  assert.equal(b.r.verified, false);
});

// ---------------------------------------------------------------- 4. pictures outside */media/, or that can't be read
test("OOXML: pictures anywhere in the package are checked, and one that can't be read is never passed over", async () => {
  const jpg = fixture("photo_iphone.jpg");
  assert.ok(inspect(jpg, "a.jpg").gps);
  const gpsOf = (out: Uint8Array, name: string) => {
    const b = Buffer.from(out), i = b.indexOf(name);
    return inspect(new Uint8Array(b.subarray(i + name.length, i + name.length + jpg.length)), "x.jpg").gps;
  };
  for (const name of ["word/images/photo.jpg", "word/media/photo.jfif", "word/media/photo.bin"]) {
    const file = zip(docx("", [name, jpg]));
    const { r, out } = await run(file, "a.docx");
    const left = gpsOf(out, name);
    safe(r.verified, !!left, name);
    assert.equal(left, null, name);
  }
  // the zip says the picture is over 50 MB: it can't be read, so the file isn't vouched for
  const file = Buffer.from(zip(docx("", ["word/media/image1.jpg", jpg])));
  const cd = file.lastIndexOf("PK\x01\x02");
  file.writeUInt32LE(60 * 1024 * 1024, cd + 24);
  const { r, out } = await run(new Uint8Array(file), "a.docx");
  safe(r.verified, !!gpsOf(out, "word/media/image1.jpg"), "oversize picture");
  assert.equal(r.verified, false);
});

// ---------------------------------------------------------------- 5. hidden folder paths and names
test("OOXML: Excel's saved folder, Word's template path and SharePoint names are never reported clean", async () => {
  const WB = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:AlternateContent><mc:Choice Requires="x15"><x15ac:absPath url="C:\\Users\\JaneDoe\\Documents\\Payroll\\" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac"/></mc:Choice></mc:AlternateContent><sheets/></workbook>`;
  const xlsx = zip([["[Content_Types].xml", CT], ["_rels/.rels", RELS("xl/workbook.xml")], ["xl/workbook.xml", WB], ["docProps/core.xml", core("")]]);
  const x = await run(xlsx, "a.xlsx");
  safe(x.r.verified, has(x.out, "JaneDoe"), "absPath");
  assert.equal(has(x.out, "JaneDoe"), false);
  assert.ok(has(x.out, "<sheets/>"));

  const TPL = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:\\Users\\JaneDoe\\AppData\\Roaming\\Microsoft\\Templates\\Memo.dotm" TargetMode="External"/></Relationships>`;
  const SETTINGS = `<?xml version="1.0" encoding="UTF-8"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:zoom w:percent="100"/><w:attachedTemplate r:id="rId1"/></w:settings>`;
  // without the settings part the link can't be removed safely: shown, and not verified
  const lone = await run(zip(docx("", ["word/_rels/settings.xml.rels", TPL])), "a.docx");
  safe(lone.r.verified, has(lone.out, "JaneDoe"), "template path");
  assert.equal(lone.r.verified, false);
  // with it, both the link and the element pointing at it go
  const full = await run(zip(docx("", ["word/settings.xml", SETTINGS], ["word/_rels/settings.xml.rels", TPL])), "a.docx");
  safe(full.r.verified, has(full.out, "JaneDoe"), "template path");
  assert.equal(has(full.out, "JaneDoe"), false);
  assert.equal(has(full.out, "attachedTemplate"), false);
  assert.ok(has(full.out, `<w:zoom w:percent="100"/>`));

  const SP = `<p:properties xmlns:p="http://schemas.microsoft.com/office/2006/metadata/properties"><documentManagement><Owner><UserInfo><DisplayName>Jane Doe</DisplayName><AccountId>12</AccountId></UserInfo></Owner></documentManagement></p:properties>`;
  const sp = await run(zip(docx("", ["customXml/item1.xml", SP])), "a.docx");
  safe(sp.r.verified, has(sp.out, "Jane Doe"), "customXml");
  assert.ok(sp.r.before.fields.some(f => f.value.includes("Jane Doe")));
});

// ---------------------------------------------------------------- 6. many small parts that each inflate to ~49 MB
test("OOXML: picture-named parts that inflate to gigabytes are stopped by a budget, quickly", async () => {
  const big = Buffer.alloc(49 * 1024 * 1024);
  const files: [string, Uint8Array | string][] = [["[Content_Types].xml", CT]];
  for (let i = 0; i < 40; i++) files.push([`word/media/image${i}.png`, big]);
  const file = zip(files, new Set(files.slice(1).map(f => f[0])));
  assert.ok(file.length < 4 * 1024 * 1024);
  const t = Date.now();
  const inv = await inspectDocument(src(file), "a.docx");
  const ms = Date.now() - t;
  assert.ok(ms < 1500, `took ${ms} ms`);
  assert.ok(inv.errors.length > 0);
});

// ---------------------------------------------------------------- real documents are still verified
test("real documents are still verified clean", async () => {
  for (const n of ["doc_textutil.docx", "doc_quartz.pdf"]) {
    const { r } = await run(fixture(n), n);
    assert.equal(r.verified, true, `${n}: ${r.before.errors.join("; ")} ${r.notes.join("; ")}`);
  }
});
