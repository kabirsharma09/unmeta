// Compare a file you uploaded with the copy you downloaded back from an app, using UnMeta's own engine.
//   node engine/tools/compare.ts <original> <downloaded> [platform label]
// Prints which kinds of hidden detail survived, as a Markdown table row ready for a guide.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { inspect } from "../src/inspect.ts";
import { bytesSource, inspectMedia, isMediaName } from "../src/media.ts";

type F = { id: string; category: string; label?: string; value?: string };
async function fields(path: string): Promise<{ fmt: string; fs: F[] }> {
  const d = new Uint8Array(readFileSync(path));
  const name = basename(path);
  if (isMediaName(name)) { const inv = await inspectMedia(bytesSource(d), name); return { fmt: String(inv.fmt ?? "media"), fs: inv.fields as F[] }; }
  const inv = inspect(d, name);
  return { fmt: String(inv.fmt), fs: inv.fields as F[] };
}
const KINDS: [string, (f: F) => boolean][] = [
  ["Location", f => f.category === "location"],
  ["Device and serial", f => f.category === "device"],
  ["Names and dates", f => f.category === "personal"],
  ["AI labels", f => f.category === "ai"],
  ["Hidden thumbnails", f => /thumb|preview|motion|mpf/i.test(f.id)],
];
const [orig, down, label = basename(process.argv[3] ?? "")] = process.argv.slice(2);
if (!orig || !down) { console.error("usage: node engine/tools/compare.ts <original> <downloaded> [platform label]"); process.exit(2); }
const a = await fields(orig), b = await fields(down);
const cells = KINDS.map(([k, test]) => {
  const before = a.fs.filter(test).length, after = b.fs.filter(test).length;
  return before === 0 ? "not in the test file" : after === 0 ? "removed" : `kept (${after} of ${before})`;
});
console.log(`Original: ${a.fmt}, ${a.fs.length} details   Downloaded: ${b.fmt}, ${b.fs.length} details`);
for (const [i, [k]] of KINDS.entries()) console.log(`  ${k.padEnd(18)} ${cells[i]}`);
console.log(`\n| ${label} | ${cells.join(" | ")} |`);
