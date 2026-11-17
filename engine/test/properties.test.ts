// Property tests: invariants that must hold for every file and every choice of what to keep.
// Inputs come from the fixtures crossed with every preset and random keep-sets, so the checks aren't shaped by
// what we expected a particular file to contain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { inspect } from "../src/inspect.ts";
import { clean, type Options } from "../src/clean.ts";
import { PRESETS } from "../src/presets.ts";
import { type Part, bytesSource, cleanMedia, inspectMedia, isMediaName } from "../src/media.ts";
import { cleanDocument, inspectDocument, isDocName } from "../src/docs.ts";

const dir = new URL("../src/fixtures/", import.meta.url);
const files = readdirSync(dir).filter(n => !n.endsWith(".json")).map(n => ({ n, d: new Uint8Array(readFileSync(new URL(n, dir))) }));
const join = (src: Uint8Array, parts: Part[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + ("bytes" in p ? p.bytes.length : p.to - p.from), 0));
  let o = 0;
  for (const p of parts) { const b = "bytes" in p ? p.bytes : src.subarray(p.from, p.to); out.set(b, o); o += b.length; }
  return out;
};
let seed = 20261117;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

type Left = { id: string; category: string; risky: boolean };
type Run = { out: Uint8Array; verified: boolean; untouched: boolean; afterIds: string[]; left: Left[] };
const leftOf = (fs: { id: string; category: string; risk: string; informational?: boolean }[]): Left[] =>
  fs.filter(f => !f.informational).map(f => ({ id: f.id, category: f.category, risky: f.risk === "medium" || f.risk === "high" }));

async function run(n: string, d: Uint8Array, o: Options): Promise<Run> {
  if (isDocName(n)) {
    const r = await cleanDocument(bytesSource(d), n, o);
    return { out: join(d, r.parts), verified: r.verified, untouched: r.pixelsUntouched, afterIds: r.after.fields.map(f => f.id),
      left: leftOf(r.after.fields) };
  }
  if (isMediaName(n)) {
    const r = await cleanMedia(bytesSource(d), n, o);
    return { out: join(d, r.parts), verified: r.verified, untouched: r.pixelsUntouched, afterIds: r.after.fields.map(f => f.id), left: leftOf(r.after.fields) };
  }
  const r = clean(d, n, o);
  const keptIds = new Set(r.kept.map(f => f.id));
  return { out: r.data, verified: r.verified, untouched: r.pixelsUntouched, afterIds: r.after.fields.map(f => f.id), left: leftOf(r.after.fields) };
}

async function fieldIds(n: string, d: Uint8Array): Promise<string[]> {
  if (isDocName(n)) return (await inspectDocument(bytesSource(d), n)).fields.filter(f => !f.informational).map(f => f.id);
  if (isMediaName(n)) return (await inspectMedia(bytesSource(d), n)).fields.map(f => f.id);
  return inspect(d, n).fields.map(f => f.id);
}

const presets = Object.values(PRESETS).map(p => p.options as Options);

test("property: cleaning is idempotent (a clean copy cleaned again is byte-identical)", async () => {
  assert.ok(files.length >= 15, `fixtures: ${files.length}`);
  for (const { n, d } of files) for (const o of presets) {
    const a = await run(n, d, o);
    const b = await run(n, a.out, o);
    assert.deepEqual(Buffer.compare(Buffer.from(a.out), Buffer.from(b.out)), 0, `${n}: second clean changed the file`);
  }
});

test("property: 'verified' means re-reading the output finds no private detail you didn't keep", async () => {
  let checked = 0, risky = 0;
  for (const { n, d } of files) for (const o of presets) {
    const r = await run(n, d, o);
    if (!r.verified) continue;
    checked++; risky += r.left.filter(x => x.risky).length;
    for (const f of r.left.filter(x => x.risky)) {
      assert.ok(o.keepCategories.includes(f.category as never) || !!o.keepFields?.includes(f.id),
        `${n}: ${f.id} (${f.category}) left behind although not kept`);
    }
    assert.ok(r.untouched, `${n}: verified but the content changed`);
  }
  // the property must actually have been exercised: many verified runs, including presets that keep risky details
  assert.ok(checked >= files.length * 3, `only ${checked} verified runs`);
  assert.ok(risky > 0, "no preset kept anything risky, so the keep path wasn't tested");
});

test("property: keeping more never removes more (monotonic in keep choices)", async () => {
  for (const { n, d } of files) {
    const before = await fieldIds(n, d);
    if (!before.length) continue;
    for (let k = 0; k < 4; k++) {
      const some = before.filter(() => rnd(2) === 0);
      const more = [...new Set([...some, ...before.filter(() => rnd(2) === 0)])];
      const base: Options = { keepCategories: ["technical"] };
      const a = new Set((await run(n, d, { ...base, keepFields: some })).afterIds);
      const b = new Set((await run(n, d, { ...base, keepFields: more })).afterIds);
      for (const id of a) assert.ok(b.has(id), `${n}: keeping more lost ${id}`);
    }
  }
});

test("property: the picture, frames, sound or document content are untouched for every preset", async () => {
  for (const { n, d } of files) for (const o of presets) {
    const r = await run(n, d, o);
    if (r.verified) assert.ok(r.untouched, `${n} with ${JSON.stringify(o.keepCategories)}`);
  }
});

test("property: random bytes under every supported name never throw out of the photo engine and never hang", async () => {
  const names = ["x.jpg", "x.png", "x.webp", "x.heic", "x.avif", "x.tif", "x.dng", "x.cr3"];
  const start = Date.now();
  for (let k = 0; k < 400; k++) {
    const len = rnd(4096);
    const d = new Uint8Array(len);
    for (let i = 0; i < len; i++) d[i] = rnd(256);
    // sometimes start with a real signature so deeper parsers run
    const sig = [[0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0x49, 0x49, 0x2a, 0], [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]][k % 4];
    if (k % 2 && len > sig.length) d.set(sig, 0);
    const n = names[k % names.length];
    const inv = inspect(d, n);   // must not throw
    if (inv.fmt !== "unknown") { try { clean(d, n, PRESETS.everything.options, inv); } catch { /* reported to the user as unreadable */ } }
  }
  assert.ok(Date.now() - start < 15000);
});
