// Hostile documents, round 2 of the independent review of the document cleaner. Never report a file clean while the
// secret is still in it; never change what people see (and say so honestly); no false alarms on ordinary files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { PRESETS } from "../src/presets.ts";
import type { Part } from "../src/media.ts";
import { cleanDocument } from "../src/docs.ts";

const ALL = PRESETS.everything.options;
const cat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p.map(x => Buffer.from(x))));
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, "utf8"));
const join = (src: Uint8Array, parts: Part[]) => cat(...parts.map(p => "bytes" in p ? p.bytes : src.subarray(p.from, p.to)));
const src = (b: Uint8Array) => ({ size: b.length, read: async (o: number, n: number) => b.slice(o, Math.min(b.length, o + n)) });
const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url)));

async function run(file: Uint8Array, name: string) {
  const r = await cleanDocument(src(file), name, ALL);
  return { r, out: join(file, r.parts) };
}

/** A one-revision PDF from object bodies (numbered from 1), with a correct xref. */
function pdf(objs: string[], trailer: string): Uint8Array {
  let s = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  s += `trailer\n${trailer}\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(s, "latin1"));
}
const PAGE = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>"];
const stream = (data: string, len: string | number = data.length) => `<< /Length ${len} >>\nstream\n${data}\nendstream`;

function zip(files: [string, string][]): Uint8Array {
  const locals: Buffer[] = [], cds: Buffer[] = [];
  let off = 0;
  for (const [name, s] of files) {
    const d = Buffer.from(s, "utf8"), nb = Buffer.from(name), crc = crc32(d) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, d); cds.push(ch, nb); off += 30 + nb.length + d.length;
  }
  const cd = Buffer.concat(cds), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, e]));
}

test("1: the dictionary a trailer names as /Info is cleaned whatever /Type it claims", async () => {
  for (const type of ["/Foo", "/Metadata"]) {
    const f = pdf([...PAGE, stream("BT (Hi) Tj ET"), `<< /Type ${type} /Author (Jane Doe) >>`], "<< /Size 6 /Root 1 0 R /Info 5 0 R >>");
    const { r, out } = await run(f, "a.pdf");
    assert.ok(r.before.fields.some(x => x.id === "pdf:info:Author"), type);
    assert.ok(!has(out, "Jane Doe"), `${type}: author left`);
    assert.equal(r.verified, true);
  }
});

test("2: an indirect /Length is resolved; look-alike objects inside the stream's data are never edited", async () => {
  // a normal file with an indirect length verifies clean
  const c = "BT (Hello) Tj ET";
  const ok = pdf([...PAGE, stream(c, "6 0 R"), "<< /Author (Jane Doe) >>", String(c.length)], "<< /Size 7 /Root 1 0 R /Info 5 0 R >>");
  const a = await run(ok, "a.pdf");
  assert.equal(a.r.verified, true);
  assert.ok(!has(a.out, "Jane Doe"));
  // an uncompressed stream holding PDF-like text (an embedded file): its bytes must come out unchanged
  const data = "BT (x) Tj ET\nendstream\nendobj\n9 0 obj\n<< /Author (Jane Doe) /Producer (Y) >>\nendobj\n% tail";
  const f = pdf([...PAGE, stream(data, "6 0 R"), "<< /Producer (X) >>", String(data.length)], "<< /Size 7 /Root 1 0 R /Info 5 0 R >>");
  const { r, out } = await run(f, "a.pdf");
  const at = Buffer.from(f).indexOf("BT (x) Tj ET");
  const same = Buffer.from(out).subarray(at, at + data.length).equals(Buffer.from(data));
  assert.ok(same || !r.pixelsUntouched, "stream content changed while claiming it wasn't");
  assert.ok(same, "stream content changed");
  // a length that can't be resolved: fail closed and change nothing after the stream starts
  const g = pdf([...PAGE, stream(data, "8 0 R"), "<< /Producer (X) >>"], "<< /Size 6 /Root 1 0 R /Info 5 0 R >>");
  const b = await run(g, "a.pdf");
  assert.equal(b.r.verified, false);
  const s0 = Buffer.from(g).indexOf("BT (x) Tj ET");
  assert.ok(Buffer.from(b.out).subarray(s0).equals(Buffer.from(g).subarray(s0)), "bytes after an unknown-length stream changed");
});

test("3: a stream whose text mentions 'endstream' is fine when its length is right; an overlong length still fails closed", async () => {
  const c = "BT (endstream) Tj ET";
  const f = pdf([...PAGE, stream(c), "<< /Author (Jane Doe) >>"], "<< /Size 6 /Root 1 0 R /Info 5 0 R >>");
  const { r, out } = await run(f, "a.pdf");
  assert.deepEqual(r.before.errors, []);
  assert.equal(r.verified, true);
  assert.ok(!has(out, "Jane Doe"));
  const g = pdf([...PAGE, stream("BT (Hi) Tj ET", 13 + 120), "<< /Author (Jane Doe) >>"], "<< /Size 6 /Root 1 0 R /Info 5 0 R >>");
  const b = await run(g, "a.pdf");
  assert.ok(!(b.r.verified && has(b.out, "Jane Doe")));
  assert.equal(b.r.verified, false);
});

test("4: two edits to one part (workbook.xml: saved-in folder and template link) both happen", async () => {
  const CT = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;
  const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const CORE = `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"></cp:coreProperties>`;
  const WB = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac"><mc:AlternateContent><mc:Choice Requires="x15"><x15ac:absPath url="C:\\Users\\JaneDoe\\Documents\\"/></mc:Choice></mc:AlternateContent><attachedTemplate r:id="rId9"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const WBR = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:\\Users\\JaneDoe\\T.xltx" TargetMode="External"/></Relationships>`;
  const z = zip([["[Content_Types].xml", CT], ["_rels/.rels", RELS], ["docProps/core.xml", CORE], ["xl/workbook.xml", WB], ["xl/_rels/workbook.xml.rels", WBR]]);
  const { r, out } = await run(z, "a.xlsx");
  assert.ok(!has(out, "JaneDoe"), "a path was left");
  assert.equal(r.verified, true);
  assert.ok(has(out, `<sheet name="S"`));
});

test("real fixtures still verify clean", async () => {
  for (const n of ["doc_textutil.docx", "doc_quartz.pdf"]) {
    const { r } = await run(fixture(n), n);
    assert.equal(r.verified, true, n);
    assert.deepEqual(r.before.errors, [], n);
  }
});
