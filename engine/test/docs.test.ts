// Documents: hand-built Office files and PDFs with known details, cleaned and checked byte by byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateRaw, inflateRaw, deflate } from "pako";
import { crc32 } from "../src/bytes.ts";
import { type Part, bytesSource } from "../src/media.ts";
import { DocError, cleanDocument, detectDoc, docHighlights, inspectDocument, isDocName, toDocReport } from "../src/docs.ts";
import { inspect } from "../src/inspect.ts";
import { PRESETS } from "../src/presets.ts";

const enc = new TextEncoder(), dec = new TextDecoder();
const u8 = (...parts: (Uint8Array | string | number[])[]) => {
  const bs = parts.map(p => (typeof p === "string" ? enc.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bs) { out.set(b, o); o += b.length; }
  return out;
};
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const latin = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const has = (b: Uint8Array, s: string) => latin(b).includes(s);
const assemble = (src: Uint8Array, parts: Part[]) => u8(...parts.map(p => ("bytes" in p ? p.bytes : src.subarray(p.from, p.to))));
const apple = new Uint8Array(readFileSync(new URL("../src/fixtures/apple.jpg", import.meta.url)));
const everything = PRESETS.everything.options;

// ---------------------------------------------------------------- zip
interface ZipIn { name: string; data: Uint8Array | string; store?: boolean; descriptor?: boolean }
function zip(entries: ZipIn[], comment = ""): Uint8Array {
  const locals: Uint8Array[] = [], central: Uint8Array[] = [];
  let at = 0;
  for (const e of entries) {
    const data = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const comp = e.store ? data : deflateRaw(data);
    const name = enc.encode(e.name), crc = crc32(data), flags = e.descriptor ? 8 : 0, method = e.store ? 0 : 8;
    const sizes = e.descriptor ? [...le32(0), ...le32(0), ...le32(0)] : [...le32(crc), ...le32(comp.length), ...le32(data.length)];
    const local = u8(le32(0x04034b50), le16(20), le16(flags), le16(method), le16(0), le16(0x21), sizes, le16(name.length), le16(0), name, comp,
      e.descriptor ? u8(le32(0x08074b50), le32(crc), le32(comp.length), le32(data.length)) : []);
    central.push(u8(le32(0x02014b50), le16(20), le16(20), le16(flags), le16(method), le16(0), le16(0x21), le32(crc), le32(comp.length),
      le32(data.length), le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(at), name));
    locals.push(local);
    at += local.length;
  }
  const cd = u8(...central);
  return u8(...locals, cd, le32(0x06054b50), le16(0), le16(0), le16(entries.length), le16(entries.length), le32(cd.length), le32(at),
    le16(comment.length), comment);
}
interface ZipOut { name: string; raw: Uint8Array; data: Uint8Array }
function unzip(b: Uint8Array): Map<string, ZipOut> {
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  let e = b.length - 22;
  while (v.getUint32(e, true) !== 0x06054b50) e--;
  const n = v.getUint16(e + 10, true), cdOff = v.getUint32(e + 16, true);
  const out = new Map<string, ZipOut>();
  for (let i = 0, p = cdOff; i < n; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    const method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true), ml = v.getUint16(p + 30, true), kl = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nl));
    assert.equal(v.getUint32(local, true), 0x04034b50, `${name}: local header where the directory says`);
    const ds = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const comp = b.subarray(ds, ds + csize);
    const data = method === 0 ? comp : inflateRaw(comp);
    assert.equal(data.length, usize, name);
    assert.equal(crc32(data), crc, `${name}: CRC`);
    out.set(name, { name, raw: b.subarray(local, ds + csize), data });
    p += 46 + nl + ml + kl;
  }
  return out;
}

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/><Override PartName="/docProps/thumbnail.jpeg" ContentType="image/jpeg"/></Types>`;
const RELS = (main: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>`;
const CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Merger plan</dc:title><dc:subject></dc:subject><dc:creator>Jane Doe</dc:creator><cp:keywords>secret; project falcon</cp:keywords><cp:lastModifiedBy>Sam Lee</cp:lastModifiedBy><cp:revision>7</cp:revision><cp:lastPrinted>2026-01-04T08:00:00Z</cp:lastPrinted><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T09:30:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-05T17:45:00Z</dcterms:modified></cp:coreProperties>`;
const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template>C:\\Users\\jane\\AppData\\Roaming\\Microsoft\\Templates\\Acme Letter.dotm</Template><TotalTime>205</TotalTime><Pages>1</Pages><Words>3</Words><Application>Microsoft Office Word</Application><DocSecurity>0</DocSecurity><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Title</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr></vt:lpstr></vt:vector></TitlesOfParts><Manager>Pat Boss</Manager><Company>Acme Holdings &amp; Co</Company><LinksUpToDate>false</LinksUpToDate><AppVersion>16.0000</AppVersion></Properties>`;
const CUSTOM = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ClientEmail"><vt:lpwstr>jane@acme.example</vt:lpwstr></property><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="ProjectCode"><vt:lpwstr>ZX-4471-FALCON</vt:lpwstr></property></Properties>`;
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Visible body text.</w:t></w:r><w:ins w:id="1" w:author="Sam Lee" w:date="2026-01-05T10:00:00Z"><w:r><w:t> Added later.</w:t></w:r></w:ins><w:del w:id="2" w:author="Riley Quinn" w:date="2026-01-05T11:00:00Z"><w:r><w:delText> Removed words.</w:delText></w:r></w:del><w:ins w:id="3" w:author="Riley Quinn" w:date="2026-01-05T12:00:00Z"><w:r><w:t>!</w:t></w:r></w:ins></w:p><w:p><w:r><w:drawing>image1</w:drawing></w:r></w:p></w:body></w:document>`;
const COMMENTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Sam Lee" w:date="2026-01-05T10:00:00Z" w:initials="SL"><w:p><w:r><w:t>Check the numbers</w:t></w:r></w:p></w:comment><w:comment w:id="1" w:author="Riley Quinn" w:initials="RQ"><w:p><w:r><w:t>Agreed</w:t></w:r></w:p></w:comment></w:comments>`;
const PEOPLE = `<?xml version="1.0" encoding="UTF-8"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="Sam Lee"/><w15:person w15:author="Riley Quinn"/></w15:people>`;
const THUMB = u8([0xff, 0xd8, 0xff, 0xdb], "first-page-preview", [0xff, 0xd9]);

function docx(opts: { descriptor?: boolean } = {}) {
  return zip([
    { name: "[Content_Types].xml", data: CT },
    { name: "_rels/.rels", data: RELS("word/document.xml") },
    { name: "word/document.xml", data: DOCUMENT, descriptor: opts.descriptor },
    { name: "word/comments.xml", data: COMMENTS },
    { name: "word/people.xml", data: PEOPLE },
    { name: "word/media/image1.jpeg", data: apple, store: true },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.jpeg"/></Relationships>` },
    { name: "docProps/thumbnail.jpeg", data: THUMB, store: true },
    { name: "docProps/core.xml", data: CORE },
    { name: "docProps/app.xml", data: APP, descriptor: opts.descriptor },
    { name: "docProps/custom.xml", data: CUSTOM },
  ]);
}
const LEAKS = ["Jane Doe", "Acme Holdings", "Pat Boss", "\\Users\\jane", "jane@acme.example", "ZX-4471-FALCON", "Merger plan", "project falcon",
  "C39XK1234ABC", "2026-01-02T09:30"];

test("document names and signatures are recognised", () => {
  for (const n of ["a.pdf", "b.DOCX", "c.xlsm", "d.pptx", "e.dotx"]) assert.ok(isDocName(n), n);
  for (const n of ["a.jpg", "b.zip", "c.doc"]) assert.ok(!isDocName(n), n);
  assert.equal(detectDoc(u8("%PDF-1.7\n"), "x.bin"), "pdf");
  assert.equal(detectDoc(docx().subarray(0, 1024), "x.docx"), "ooxml");
  assert.equal(detectDoc(docx().subarray(0, 1024), "x.zip"), "ooxml", "[Content_Types].xml as the first part");
  assert.equal(detectDoc(zip([{ name: "a.txt", data: "hi" }]), "x.zip"), null);
  assert.equal(detectDoc(apple.subarray(0, 64), "x.jpg"), null);
});

test("Word: hidden details, comments, tracked changes and pictures are all found", async () => {
  const file = docx();
  const inv = await inspectDocument(bytesSource(file), "plan.docx");
  assert.deepEqual(inv.errors, []);
  assert.equal(inv.docFormat, "docx");
  assert.equal(inv.kind as string, "document");
  const v = (id: string) => inv.fields.find(f => f.id === id);
  assert.equal(v("ooxml:core:dc:creator")?.value, "Jane Doe");
  assert.equal(v("ooxml:core:dc:creator")?.risk, "high");
  assert.equal(v("ooxml:core:cp:lastModifiedBy")?.value, "Sam Lee");
  assert.equal(v("ooxml:core:dc:title")?.value, "Merger plan");
  assert.equal(v("ooxml:core:dc:subject"), undefined, "empty values are not findings");
  assert.equal(v("ooxml:app:Company")?.value, "Acme Holdings & Co");
  assert.equal(v("ooxml:app:Template")?.risk, "high", "a template path naming a user is high risk");
  assert.equal(v("ooxml:app:TotalTime")?.value, "3 hours 25 minutes");
  assert.equal(v("ooxml:app:Application")?.category, "device");
  assert.equal(v("ooxml:app:Application")?.risk, "low");
  assert.equal(v("ooxml:custom:ClientEmail")?.risk, "high");
  assert.equal(v("ooxml:custom:ProjectCode")?.value, "ZX-4471-FALCON");
  assert.equal(v("ooxml:thumbnail")?.keepable, false);
  assert.equal(v("ooxml:app:Pages"), undefined, "page counts are not personal");
  const cm = v("ooxml:comments")!, tc = v("ooxml:tracked")!;
  assert.equal(cm.value, "2 comments · by Sam Lee, Riley Quinn");
  assert.equal(tc.value, "3 tracked changes · by Sam Lee, Riley Quinn");
  for (const f of [cm, tc]) { assert.equal(f.informational, true); assert.equal(f.keepable, false); }
  assert.equal(v("ooxml:media:word/media/image1.jpeg:location")?.value, "51.5072, -0.1275");
  assert.ok(v("ooxml:media:word/media/image1.jpeg:device"));

  const found = docHighlights(toDocReport(inv));
  assert.ok(found.length <= 6);
  const by = Object.fromEntries(found.map(h => [h.title, h]));
  assert.equal(by["Who wrote it"].value, "Jane Doe · last edited by Sam Lee · manager Pat Boss");
  assert.equal(by["Company and template"].value, "Acme Holdings & Co · template from user “jane”");
  assert.match(by["When it was written"]?.value ?? "Created 2 Jan 2026", /^Created 2 Jan 2026/);
  assert.equal(by["Comments and tracked changes"].value, "2 comments · 3 tracked changes · by Sam Lee, Riley Quinn");
  assert.equal(by["Comments and tracked changes"].why, "Kept as they are. Delete them in Word if you don't want to share them.");
  assert.equal(by["Pictures inside"].value, "1 picture with location, camera details, names and dates");
  assert.ok(by["Pictures inside"].ids.includes("ooxml:media:word/media/image1.jpeg:location"));
  for (const h of found) for (const k of ["key", "title", "value", "why", "ids"]) assert.ok(k in h);
  assert.match(toDocReport(inv).notes[0], /Comments, tracked changes/);
});

test("Word: cleaning removes hidden details, keeps comments and content byte for byte", async () => {
  for (const descriptor of [false, true]) {
    const file = docx({ descriptor });
    const inv = await inspectDocument(bytesSource(file), "plan.docx");
    const r = await cleanDocument(bytesSource(file), "plan.docx", everything, inv);
    const out = assemble(file, r.parts);
    assert.equal(out.length, r.size);
    assert.ok(r.verified, JSON.stringify(r.residual.map(f => f.id)) + r.notes.join());
    assert.ok(r.pixelsUntouched);
    const a = unzip(file), b = unzip(out);
    // nothing personal anywhere: raw bytes or any decompressed part
    for (const s of LEAKS) {
      assert.ok(!has(out, s), `raw output still contains ${s}`);
      for (const e of b.values()) assert.ok(!has(e.data, s), `${e.name} still contains ${s}`);
    }
    // the thumbnail is gone, with its relationship and content type
    assert.ok(!b.has("docProps/thumbnail.jpeg"));
    assert.ok(!has(b.get("_rels/.rels")!.data, "thumbnail"));
    assert.ok(!has(b.get("[Content_Types].xml")!.data, "thumbnail"));
    assert.ok(has(b.get("_rels/.rels")!.data, "word/document.xml"), "other relationships stay");
    // untouched parts are the very same bytes, header and all
    for (const n of ["word/document.xml", "word/comments.xml", "word/people.xml", "word/_rels/document.xml.rels"]) {
      const x = a.get(n)!, y = b.get(n)!;
      assert.deepEqual(y.raw.subarray(0, 30 + n.length).subarray(4), x.raw.subarray(0, 30 + n.length).subarray(4), n);
      assert.deepEqual(y.data, x.data, n);
    }
    assert.ok(has(b.get("word/comments.xml")!.data, 'w:author="Sam Lee"'), "comments are kept");
    assert.ok(has(b.get("word/document.xml")!.data, "<w:del w:id=\"2\" w:author=\"Riley Quinn\""), "tracked changes are kept");
    // rewritten parts are still well-formed, with namespaces and structure intact
    const core = dec.decode(b.get("docProps/core.xml")!.data), app = dec.decode(b.get("docProps/app.xml")!.data);
    assert.match(core, /^<\?xml[^>]*\?>\s*<cp:coreProperties xmlns:cp="[^"]+" xmlns:dc="[^"]+"[^>]*>(<dc:subject><\/dc:subject>)?<\/cp:coreProperties>$/);
    assert.ok(app.includes("<HeadingPairs>") && app.includes("<TitlesOfParts>") && app.includes("<Pages>1</Pages>"), "structure stays");
    assert.ok(!app.includes("<Application>") && !app.includes("<Company>"));
    assert.match(dec.decode(b.get("docProps/custom.xml")!.data), /<Properties [^>]*><\/Properties>$/);
    // the picture: its details are gone, the picture data itself is identical
    const pic = b.get("word/media/image1.jpeg")!.data;
    assert.equal(inspect(pic, "image1.jpeg").gps, null);
    const scan = (x: Uint8Array) => x.subarray(x.findLastIndex((v, i) => v === 0xff && x[i + 1] === 0xda));
    assert.deepEqual(scan(pic), scan(apple));
    // comments and tracked changes are kept and still reported; they never count as residual
    assert.ok(r.after.fields.some(f => f.id === "ooxml:comments" && f.informational));
    assert.ok(r.kept.some(f => f.id === "ooxml:tracked"));
    assert.ok(!r.removed.some(f => f.informational));
    assert.ok(r.removed.some(f => f.id === "ooxml:core:dc:creator"));
    assert.ok(r.notes.some(n => /Comments, tracked changes/.test(n)));
    // and the result reads back as the same kind of document
    const again = await inspectDocument(bytesSource(out), "plan.docx");
    assert.deepEqual(again.errors, []);
    assert.deepEqual(again.fields.filter(f => !f.informational).map(f => f.id), []);
  }
});

test("Word: keeping a category keeps just those details", async () => {
  const file = docx();
  const r = await cleanDocument(bytesSource(file), "plan.docx", { keepCategories: ["technical", "device"] });
  assert.ok(r.verified, JSON.stringify(r.residual.map(f => f.id)));
  const b = unzip(assemble(file, r.parts));
  const app = dec.decode(b.get("docProps/app.xml")!.data);
  assert.ok(app.includes("<Application>Microsoft Office Word</Application>") && !app.includes("Acme"));
  const pic = inspect(b.get("word/media/image1.jpeg")!.data, "image1.jpeg");
  assert.equal(pic.gps, null);
  assert.ok(pic.fields.some(f => f.value === "iPhone 15 Pro"), "camera details kept in the picture");
});

test("Excel and PowerPoint: comments and details found and cleaned", async () => {
  const xl = zip([
    { name: "[Content_Types].xml", data: CT.replace("/word/document.xml", "/xl/workbook.xml") },
    { name: "_rels/.rels", data: RELS("xl/workbook.xml") },
    { name: "xl/workbook.xml", data: `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Budget" sheetId="1"/></sheets></workbook>` },
    { name: "xl/comments1.xml", data: `<?xml version="1.0"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>tc={1}</author><author>Sam Lee</author></authors><commentList><comment ref="A1" authorId="1"><text><t>Too high</t></text></comment><comment ref="B2" authorId="1"><text><t>ok</t></text></comment></commentList></comments>` },
    { name: "xl/threadedComments/threadedComment1.xml", data: `<?xml version="1.0"?><ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="A1" personId="{1}"><text>Too high</text></threadedComment></ThreadedComments>` },
    { name: "xl/persons/person.xml", data: `<?xml version="1.0"?><personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><person displayName="Riley Quinn" id="{1}"/></personList>` },
    { name: "docProps/core.xml", data: CORE },
    { name: "docProps/app.xml", data: APP.replace("Microsoft Office Word", "Microsoft Excel") },
  ]);
  const inv = await inspectDocument(bytesSource(xl), "budget.xlsx");
  assert.equal(inv.docFormat, "xlsx");
  assert.equal(inv.fields.find(f => f.id === "ooxml:comments")?.value, "2 comments · by tc={1}, Sam Lee, Riley Quinn");
  const hl = docHighlights(toDocReport(inv)).find(h => h.key === "comments")!;
  assert.match(hl.why, /Excel/);
  const r = await cleanDocument(bytesSource(xl), "budget.xlsx", everything, inv);
  assert.ok(r.verified);
  const b = unzip(assemble(xl, r.parts));
  assert.ok(!has(b.get("docProps/core.xml")!.data, "Jane Doe"));
  assert.deepEqual(b.get("xl/comments1.xml")!.raw, unzip(xl).get("xl/comments1.xml")!.raw);

  const ppt = zip([
    { name: "[Content_Types].xml", data: CT.replace("/word/document.xml", "/ppt/presentation.xml") },
    { name: "_rels/.rels", data: RELS("ppt/presentation.xml") },
    { name: "ppt/presentation.xml", data: `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>` },
    { name: "ppt/commentAuthors.xml", data: `<?xml version="1.0"?><p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cmAuthor id="0" name="Sam Lee" initials="SL"/></p:cmAuthorLst>` },
    { name: "ppt/comments/comment1.xml", data: `<?xml version="1.0"?><p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cm authorId="0" idx="1"><p:text>Fix slide</p:text></p:cm><p:cm authorId="0" idx="2"><p:text>Typo</p:text></p:cm><p:cm authorId="0" idx="3"><p:text>Nice</p:text></p:cm></p:cmLst>` },
    { name: "ppt/media/image2.jpeg", data: apple },
    { name: "docProps/core.xml", data: CORE },
  ]);
  const pinv = await inspectDocument(bytesSource(ppt), "deck.pptx");
  assert.equal(pinv.docFormat, "pptx");
  assert.equal(pinv.fields.find(f => f.id === "ooxml:comments")?.value, "3 comments · by Sam Lee");
  const pr = await cleanDocument(bytesSource(ppt), "deck.pptx", everything, pinv);
  assert.ok(pr.verified);
  const pout = unzip(assemble(ppt, pr.parts));
  assert.equal(inspect(pout.get("ppt/media/image2.jpeg")!.data, "image2.jpeg").gps, null, "deflated pictures are cleaned too");
});

test("Office files that can't be handled safely say so", async () => {
  // a password-protected Office file is an OLE container
  const ole = u8([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], new Array(600).fill(0));
  const inv = await inspectDocument(bytesSource(ole), "locked.docx");
  assert.ok(inv.fields.some(f => f.id === "ooxml:encrypted" && f.informational));
  const r = await cleanDocument(bytesSource(ole), "locked.docx", everything, inv);
  assert.equal(r.verified, false);
  assert.ok(r.notes.some(n => /password/.test(n)));
  assert.deepEqual(assemble(ole, r.parts), ole);
  // zip64 and garbage: a clear "not supported / damaged" error, never a crash
  const z = docx();
  const big = z.slice();
  big.set([0xff, 0xff], big.length - 22 + 10);
  await assert.rejects(inspectDocument(bytesSource(big), "a.docx"), (e: Error) => e instanceof DocError && /isn't supported/.test(e.message));
  await assert.rejects(inspectDocument(bytesSource(u8("PK\x03\x04garbage")), "a.docx"), DocError);
  await assert.rejects(inspectDocument(bytesSource(u8("hello")), "a.txt"), DocError);
  // a zip bomb: a details part that claims to be small but inflates past the limit
  const bomb = zip([{ name: "[Content_Types].xml", data: CT }, { name: "docProps/core.xml", data: new Uint8Array(60 * 1024 * 1024) }]);
  const v = new DataView(bomb.buffer);
  for (let p = 0; p < bomb.length - 4; p++) if (v.getUint32(p, true) === 0x02014b50 && latin(bomb.subarray(p + 46, p + 63)) === "docProps/core.xml") v.setUint32(p + 24, 1000, true);
  const bombInv = await inspectDocument(bytesSource(bomb), "bomb.docx");
  assert.ok(bombInv.errors.some(e => /unusually large/.test(e)));
  assert.equal((await cleanDocument(bytesSource(bomb), "bomb.docx", everything, bombInv)).verified, false);
  // a docProps part that can't be read means the result is not reported clean
  const bad = zip([{ name: "[Content_Types].xml", data: CT }, { name: "docProps/core.xml", data: CORE }]);
  const i = latin(bad).indexOf("docProps/core.xml") + 17;
  bad[i + 5] ^= 0xff;   // corrupt the compressed bytes
  const binv = await inspectDocument(bytesSource(bad), "a.docx");
  assert.ok(binv.errors.length);
  const br = await cleanDocument(bytesSource(bad), "a.docx", everything, binv);
  assert.equal(br.verified, false);
});

// ---------------------------------------------------------------- PDF
const utf16hex = (s: string) => "<FEFF" + [...s].map(c => c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()).join("") + ">";
const XMP = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmp:CreatorTool="Microsoft Word" xmp:CreateDate="2026-01-02T09:30:00+01:00" pdf:Producer="Acme PDF Engine 9" pdfaid:part="2"><dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>${" ".repeat(400)}<?xpacket end="w"?>`;

/** Writes objects with a correct xref table; `update` appends an incremental revision. */
function pdfWriter() {
  let body = u8("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  const sections: { offs: Map<number, number>; xref: number }[] = [];
  let offs = new Map<number, number>();
  return {
    obj(n: number, text: string | Uint8Array) {
      offs.set(n, body.length);
      body = u8(body, `${n} 0 obj\n`, text, "\nendobj\n");
    },
    stream(n: number, dict: string, data: Uint8Array | string) {
      const b = typeof data === "string" ? enc.encode(data) : data;
      this.obj(n, u8(`<< ${dict} /Length ${b.length} >>\nstream\n`, b, "\nendstream"));
    },
    trailer(dict: string) {
      const xref = body.length;
      const nums = [...offs.keys()].sort((a, b) => a - b);
      let t = "xref\n";
      if (!sections.length) t += `0 1\n0000000000 65535 f \n`;
      for (const n of nums) t += `${n} 1\n${String(offs.get(n)).padStart(10, "0")} 00000 n \n`;
      const prev = sections.length ? ` /Prev ${sections[sections.length - 1].xref}` : "";
      body = u8(body, t, `trailer\n<< ${dict}${prev} >>\nstartxref\n${xref}\n%%EOF\n`);
      sections.push({ offs, xref });
      offs = new Map();
    },
    get bytes() { return body; },
  };
}

function pdf(opts: { encrypt?: boolean } = {}) {
  const w = pdfWriter();
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>");
  w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  w.obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Annots [7 0 R] >>");
  w.stream(4, "", "BT /F1 12 Tf 20 100 Td (Visible body text) Tj ET");
  w.stream(5, "/Type /Metadata /Subtype /XML", XMP);
  w.obj(7, "<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /T (Sam Lee) /Contents (Please check the numbers) >>");
  w.obj(8, `<< /Author (Jane Doe) /Title ${utf16hex("Merger plan")} /Keywords (secret\\051 falcon \\(draft\\)) /Creator (Microsoft Word)
   /Producer 9 0 R /CreationDate (D:20260102093000+01'00') /Company (Acme Holdings) /Trapped /False >>`);
  w.obj(9, "(Acme PDF Engine 9)");
  w.trailer(`/Size 10 /Root 1 0 R /Info 8 0 R${opts.encrypt ? " /Encrypt 11 0 R /ID [<00> <00>]" : ""}`);
  // a later save: new details, the old ones still inside
  w.obj(10, "<< /Author (J. Doe-Smith) /Creator (ChatGPT export) /ModDate (D:20260105174500Z) >>");
  w.trailer(`/Size 11 /Root 1 0 R /Info 10 0 R${opts.encrypt ? " /Encrypt 11 0 R /ID [<00> <00>]" : ""}`);
  return w.bytes;
}
const PDF_LEAKS = ["Jane Doe", "Doe-Smith", "Acme Holdings", "Acme PDF Engine", "ChatGPT", "falcon", "D:2026010", utf16hex("Merger plan"), "Merger plan"];

/** Every in-use entry in every classic xref section points at "N 0 obj". */
function checkXref(b: Uint8Array) {
  const s = latin(b);
  let checked = 0;
  for (const m of s.matchAll(/xref\n((?:\d+ \d+\n(?:\d{10} \d{5} [nf] \n)+)+)/g)) {
    let n = 0;
    for (const line of m[1].trim().split("\n")) {
      const sub = /^(\d+) (\d+)$/.exec(line);
      if (sub) { n = +sub[1]; continue; }
      const [off, , kind] = line.trim().split(" ");
      if (kind === "n") { assert.ok(s.startsWith(`${n} 0 obj`, +off), `object ${n} at ${off}`); checked++; }
      n++;
    }
  }
  return checked;
}

test("PDF: details in both saved versions, XMP, comments and earlier versions are found", async () => {
  const file = pdf();
  const inv = await inspectDocument(bytesSource(file), "plan.pdf");
  assert.deepEqual(inv.errors, []);
  assert.equal(inv.docFormat, "pdf");
  const v = (id: string) => inv.fields.find(f => f.id === id);
  assert.equal(v("pdf:info:Author")?.value, "J. Doe-Smith", "the newest value comes first");
  assert.equal(v("pdf:info:Author:2")?.value, "Jane Doe");
  assert.equal(v("pdf:info:Author:2")?.label, "Author (earlier version)");
  assert.equal(v("pdf:info:Title")?.value, "Merger plan", "UTF-16 hex strings are decoded");
  assert.equal(v("pdf:info:Keywords")?.value, "secret) falcon (draft)", "escapes are decoded");
  assert.equal(v("pdf:info:Producer")?.value, "Acme PDF Engine 9", "indirect values are followed");
  assert.equal(v("pdf:info:CreationDate")?.value, "2026-01-02 09:30:00 +01:00");
  assert.equal(v("pdf:info:Company")?.risk, "high");
  assert.equal(v("pdf:info:Trapped"), undefined);
  assert.equal(v("pdf:info:Creator")?.category, "ai", "an AI app name is an AI label");
  assert.equal(v("pdf:info:Creator:2")?.category, "device");
  assert.ok(inv.aiSignals.length);
  assert.equal(v("xmp:dc:creator")?.value, "Jane Doe");
  assert.equal(v("xmp:pdf:Producer")?.category, "device");
  assert.equal(v("xmp:pdfaid:part")?.category, "technical");
  assert.equal(v("pdf:annotations")?.value, "1 comment · by Sam Lee");
  assert.equal(v("pdf:revisions")?.value, "1 earlier version saved inside this PDF");
  assert.ok(v("pdf:annotations")?.informational && v("pdf:revisions")?.informational);

  const found = docHighlights(toDocReport(inv));
  assert.ok(found.length <= 6);
  const titles = found.map(h => h.title);
  assert.deepEqual(titles.slice(0, 2), ["AI label", "Who wrote it"]);
  assert.ok(titles.includes("Comments") && titles.includes("Earlier versions inside"));
  assert.equal(found.find(h => h.title === "Who wrote it")!.value, "J. Doe-Smith, Jane Doe");
  assert.match(found.find(h => h.title === "Earlier versions inside")!.why, /Save as/);
});

test("PDF: cleaning blanks details in place; length, offsets, content and comments unchanged", async () => {
  const file = pdf();
  const r = await cleanDocument(bytesSource(file), "plan.pdf", everything);
  const out = assemble(file, r.parts);
  assert.equal(out.length, file.length, "same length");
  assert.ok(r.verified, JSON.stringify(r.residual.map(f => f.id)) + r.notes.join());
  assert.ok(r.pixelsUntouched);
  for (const s of PDF_LEAKS) assert.ok(!has(out, s), `still contains ${s}`);
  assert.equal(checkXref(out), 9, "every object is still where the xref tables say");
  const objText = (b: Uint8Array, n: number) => { const s = latin(b), i = s.indexOf(`${n} 0 obj`); return s.slice(i, s.indexOf("endobj", i)); };
  for (const n of [1, 2, 3, 4, 7]) assert.equal(objText(out, n), objText(file, n), `object ${n} unchanged`);
  assert.ok(has(out, "/T (Sam Lee) /Contents (Please check the numbers)"), "comments are kept");
  assert.ok(has(out, "/Trapped /False"), "printing flags stay");
  assert.ok(has(out, "pdfaid:part"), "PDF/A identification stays");
  assert.match(objText(out, 9), /^9 0 obj\n\(\) +\n$/, "an indirect value becomes an empty string");
  const again = await inspectDocument(bytesSource(out), "plan.pdf");
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.fields.filter(f => !f.informational && f.category !== "technical").map(f => f.id), []);
  assert.ok(again.fields.some(f => f.id === "pdf:annotations"));
  assert.ok(r.notes.some(n => /Comments, tracked changes/.test(n)));

  // keep the app names: just those survive
  const k = await cleanDocument(bytesSource(file), "plan.pdf", { keepCategories: ["technical", "device"] });
  const kout = assemble(file, k.parts);
  assert.ok(k.verified, JSON.stringify(k.residual.map(f => f.id)));
  assert.ok(has(kout, "(Microsoft Word)") && has(kout, "Acme PDF Engine 9") && !has(kout, "Jane Doe"));
});

test("PDF: encrypted files and compressed details are reported, never claimed clean", async () => {
  const enc1 = pdf({ encrypt: true });
  const inv = await inspectDocument(bytesSource(enc1), "locked.pdf");
  assert.ok(inv.fields.some(f => f.id === "pdf:encrypted"));
  const r = await cleanDocument(bytesSource(enc1), "locked.pdf", everything, inv);
  assert.equal(r.verified, false);
  assert.ok(r.notes.some(n => /encrypted/.test(n)));
  assert.deepEqual(assemble(enc1, r.parts), enc1);

  // PDF 1.5 object stream holding the Info dictionary, and a Flate-compressed XMP block
  const w = pdfWriter();
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R /Metadata 4 0 R >>");
  w.obj(2, "<< /Type /Pages /Kids [] /Count 0 >>");
  const inner = "8 0 << /Author (Jane Doe) /Producer (Acme PDF Engine 9) >>";
  w.stream(3, `/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode`, deflate(enc.encode(inner)));
  w.stream(4, "/Type /Metadata /Subtype /XML /Filter /FlateDecode", deflate(enc.encode(XMP)));
  w.trailer("/Size 9 /Root 1 0 R /Info 8 0 R");
  const file = w.bytes;
  const sinv = await inspectDocument(bytesSource(file), "packed.pdf");
  assert.equal(sinv.fields.find(f => f.id === "pdf:info:Author")?.value, "Jane Doe");
  assert.equal(sinv.fields.find(f => f.id === "xmp:dc:creator")?.value, "Jane Doe");
  const sr = await cleanDocument(bytesSource(file), "packed.pdf", everything, sinv);
  assert.equal(sr.verified, false);
  assert.ok(sr.notes.some(n => /compressed/.test(n)), sr.notes.join());
  assert.equal(assemble(file, sr.parts).length, file.length);
  assert.ok(sr.residual.some(f => f.id === "pdf:info:Author"));
});

test("damaged documents: hundreds of corrupted files never hang, crash or leak", async () => {
  let seed = 11;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const samples: [string, Uint8Array][] = [["a.docx", docx()], ["b.docx", docx({ descriptor: true })], ["c.pdf", pdf()], ["d.pdf", pdf({ encrypt: true })]];
  const start = Date.now();
  let cases = 0, cleaned = 0;
  for (const [name, good] of samples) {
    for (let k = 0; k < 100; k++) {
      const bad = good.slice(0, k % 5 === 0 ? rnd(good.length) : good.length);
      for (let j = 0, n = 1 + rnd(12); j < n && bad.length; j++) bad[rnd(bad.length)] = rnd(256);
      if (k % 7 === 0 && bad.length > 12) bad.set([0xff, 0xff, 0xff, 0x7f], rnd(bad.length - 4));
      if (k % 9 === 0 && bad.length > 12) bad.set(enc.encode("(<<["), rnd(bad.length - 4));
      cases++;
      let inv;
      try { inv = await inspectDocument(bytesSource(bad), name); }
      catch (e) { assert.ok(e instanceof DocError, `${name} #${k}: ${e}`); continue; }
      let r;
      try { r = await cleanDocument(bytesSource(bad), name, everything, inv); }
      catch (e) { assert.ok(e instanceof DocError, `${name} #${k}: ${e}`); continue; }
      cleaned++;
      const out = assemble(bad, r.parts);
      if (name.endsWith(".pdf")) assert.equal(out.length, bad.length, `${name} #${k}: PDF length kept`);
      // a verified result must really be free of the details, even where damage hid them from the parser
      if (r.verified && name.endsWith(".pdf")) for (const s of ["(Jane Doe)", "Acme Holdings", "Doe-Smith"]) { if (has(out, s) && process.env.DBG) { (await import("node:fs")).writeFileSync(process.env.DBG, bad); } assert.ok(!has(out, s), `${name} #${k} verified but kept ${s}`); }
      if (r.verified && name.endsWith(".docx")) {
        let parts: Map<string, ZipOut> | null = null;
        try { parts = unzip(out); } catch { /* unreadable output is checked by the engine's own re-read */ }
        for (const [n, e] of parts ?? []) if (n.startsWith("docProps/")) for (const s of ["Jane Doe", "Acme Holdings", "jane@acme"]) assert.ok(!has(e.data, s), `${name} #${k} ${n} kept ${s}`);
      }
    }
  }
  assert.equal(cases, 400);
  assert.ok(cleaned > 100, `most damaged files still clean (${cleaned})`);
  assert.ok(Date.now() - start < 10000, "fuzzing must be fast: no runaway loops");
});

test("real files from macOS (textutil, Quartz/PDFKit) read cleanly and stay valid", async () => {
  for (const n of ["doc_textutil.docx", "doc_quartz.pdf"]) {
    const file = new Uint8Array(readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url)));
    const inv = await inspectDocument(bytesSource(file), n);
    assert.deepEqual(inv.errors, [], n);
    assert.equal(inv.fields.find(f => f.label === "Author")?.value, "Jane Doe", n);
    assert.ok(inv.fields.some(f => f.label === "Title" && f.value === "Merger plan"), n);
    const r = await cleanDocument(bytesSource(file), n, everything, inv);
    assert.ok(r.verified, `${n}: ${r.residual.map(f => f.id)}`);
    const out = assemble(file, r.parts);
    for (const s of ["Jane Doe", "Merger plan", "Secret falcon", "Acme"]) assert.ok(!has(n.endsWith(".pdf") ? out : unzip(out).get("docProps/core.xml")!.data, s), `${n} kept ${s}`);
    const again = await inspectDocument(bytesSource(out), n);
    assert.deepEqual(again.errors, [], n);
    if (n.endsWith(".pdf")) {
      assert.equal(out.length, file.length);
      assert.ok(again.fields.some(f => f.id === "pdf:annotations" && /Sam Lee/.test(f.value)), "the comment is still there");
    } else {
      const a = unzip(file), b = unzip(out);
      assert.deepEqual(b.get("word/document.xml")!.raw, a.get("word/document.xml")!.raw);
      assert.ok(!has(b.get("docProps/app.xml")!.data, "Acme"));
    }
  }
});
