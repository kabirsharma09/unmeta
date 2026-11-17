// Minimal XML parser + XMP flattening/writing (no DOMParser on React Native).
import { NS_PREFIX } from "./taxonomy.ts";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XMLNS = "http://www.w3.org/XML/1998/namespace";

interface Node { ns: string; local: string; attrs: { ns: string; local: string; value: string }[]; children: Node[]; text: string }

const ENT: Record<string, string> = Object.assign(Object.create(null), { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" });
const codePoint = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\ufffd");
const unescape = (s: string) => s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) =>
  e[0] === "#" ? codePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);

// Limits keep a hostile packet from costing more than linear time or a bounded amount of memory.
const MAX_XML = 4 * 1024 * 1024, MAX_NODES = 50_000, MAX_DEPTH = 256;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A small, linear-time XML reader: enough for XMP, safe on hostile input (no backtracking regex over the whole packet). */
function parseXml(input: string): Node | null {
  const xml = input.length > MAX_XML ? input.slice(0, MAX_XML) : input;
  const stack: { node: Node; scope: Record<string, string> }[] = [];
  let root: Node | null = null, nodes = 0, i = 0;
  const base: Record<string, string> = Object.assign(Object.create(null), { xml: XMLNS });
  while (i < xml.length) {
    const top = stack[stack.length - 1];
    if (xml.charCodeAt(i) !== 60 /* < */) {
      const j = xml.indexOf("<", i);
      const end = j < 0 ? xml.length : j;
      if (top) top.node.text += unescape(xml.slice(i, end));
      i = end;
      continue;
    }
    const skip = (open: string, close: string) => {
      if (!xml.startsWith(open, i)) return false;
      const j = xml.indexOf(close, i + open.length);
      if (j < 0) { i = xml.length; return true; }
      if (open === "<![CDATA[" && top) top.node.text += xml.slice(i + open.length, j);
      i = j + close.length;
      return true;
    };
    if (skip("<!--", "-->") || skip("<?", "?>") || skip("<![CDATA[", "]]>") || skip("<!", ">")) continue;
    // find the end of this tag, honouring quoted attribute values
    let j = i + 1, q = 0;
    while (j < xml.length) {
      const c = xml.charCodeAt(j);
      if (q) { if (c === q) q = 0; } else if (c === 34 || c === 39) q = c; else if (c === 62 /* > */) break;
      j++;
    }
    if (j >= xml.length) break;
    const tag = xml.slice(i + 1, j);
    i = j + 1;
    if (tag[0] === "/") { stack.pop(); continue; }
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    if (!name || ++nodes > MAX_NODES || stack.length >= MAX_DEPTH) { if (nodes > MAX_NODES) break; continue; }
    const scope: Record<string, string> = Object.assign(Object.create(null), top?.scope ?? base);
    const rawAttrs: [string, string][] = [];
    ATTR.lastIndex = 0;
    const attrText = sp < 0 ? "" : body.slice(sp);
    let a: RegExpExecArray | null;
    while ((a = ATTR.exec(attrText))) {
      const v = unescape(a[2] ?? a[3] ?? "");
      if (a[1] === "xmlns") scope[""] = v;
      else if (a[1].startsWith("xmlns:")) scope[a[1].slice(6)] = v;
      else rawAttrs.push([a[1], v]);
    }
    const split = (qn: string, attr = false) => {
      const k = qn.indexOf(":");
      return k < 0 ? { ns: attr ? "" : scope[""] ?? "", local: qn } : { ns: scope[qn.slice(0, k)] ?? qn.slice(0, k), local: qn.slice(k + 1) };
    };
    const node: Node = { ...split(name), attrs: rawAttrs.map(([k, v]) => ({ ...split(k, true), value: v })), children: [], text: "" };
    if (top) top.node.children.push(node); else if (!root) root = node;
    if (!selfClosing) stack.push({ node, scope });
  }
  return root;
}

export interface XmpProp { qname: string; ns: string; value: string; kind: "simple" | "seq" | "bag" | "alt" | "struct"; items: string[] }

export function prefixFor(ns: string): string {
  return NS_PREFIX[ns] ?? (ns.replace(/[\/#]+$/, "").split("/").pop() || "ns");
}
const isRdf = (n: { ns: string }) => n.ns === RDF;

function flatten(el: Node): [XmpProp["kind"], string, string[]] {
  for (const [c, kind] of [["Seq", "seq"], ["Bag", "bag"], ["Alt", "alt"]] as const) {
    const box = el.children.find(ch => isRdf(ch) && ch.local === c);
    if (box) {
      const items = box.children.filter(li => isRdf(li) && li.local === "li").map(li => flatten(li)[1]);
      return [kind, items.filter(Boolean).join("; "), items];
    }
  }
  const structAttrs = el.attrs.filter(a => !isRdf(a) && a.ns !== XMLNS);
  if (el.children.length || structAttrs.length) {
    const parts: string[] = structAttrs.map(a => `${prefixFor(a.ns)}:${a.local}=${a.value}`);
    for (const ch of el.children) {
      if (isRdf(ch) && ch.local === "Description") {
        ch.attrs.filter(a => !isRdf(a)).forEach(a => parts.push(`${prefixFor(a.ns)}:${a.local}=${a.value}`));
        ch.children.forEach(g => parts.push(`${prefixFor(g.ns)}:${g.local}=${flatten(g)[1]}`));
      } else parts.push(`${prefixFor(ch.ns)}:${ch.local}=${flatten(ch)[1]}`);
    }
    return ["struct", parts.join(", "), parts];
  }
  const res = el.attrs.find(a => isRdf(a) && a.local === "resource")?.value;
  const text = el.text.trim() || res || "";
  return ["simple", text, [text]];
}

export function parseXmp(packet: string): XmpProp[] {
  const start = packet.search(/<x:xmpmeta|<rdf:RDF/);
  if (start < 0) return [];
  const endTag = packet.includes("</x:xmpmeta>") ? "</x:xmpmeta>" : "</rdf:RDF>";
  const end = packet.lastIndexOf(endTag);
  if (end < 0) return [];
  const root = parseXml(packet.slice(start, end + endTag.length));
  if (!root) return [];
  const rdf = isRdf(root) && root.local === "RDF" ? root : root.children.find(c => isRdf(c) && c.local === "RDF");
  if (!rdf) return [];
  const props: XmpProp[] = [];
  for (const desc of rdf.children.filter(c => isRdf(c) && c.local === "Description")) {
    for (const a of desc.attrs) {
      if (isRdf(a) || a.ns === XMLNS) continue;
      props.push({ qname: `${prefixFor(a.ns)}:${a.local}`, ns: a.ns, value: a.value, kind: "simple", items: [a.value] });
    }
    for (const el of desc.children) {
      const [kind, value, items] = flatten(el);
      props.push({ qname: `${prefixFor(el.ns)}:${el.local}`, ns: el.ns, value, kind, items });
    }
  }
  return props;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildXmp(props: XmpProp[]): string {
  const nss: Record<string, string> = Object.create(null);
  const body = props.map(p => {
    nss[p.qname.split(":")[0]] = p.ns;
    if (p.kind === "seq" || p.kind === "bag" || p.kind === "alt") {
      const tag = { seq: "Seq", bag: "Bag", alt: "Alt" }[p.kind];
      const lang = p.kind === "alt" ? ' xml:lang="x-default"' : "";
      return `<${p.qname}><rdf:${tag}>${p.items.map(i => `<rdf:li${lang}>${esc(i)}</rdf:li>`).join("")}</rdf:${tag}></${p.qname}>`;
    }
    return `<${p.qname}>${esc(p.value)}</${p.qname}>`;
  }).join("");
  const attrs = Object.keys(nss).sort().map(k => ` xmlns:${k}="${esc(nss[k])}"`).join("");
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF}">` +
    `<rdf:Description rdf:about=""${attrs}>${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

export const DC = "http://purl.org/dc/elements/1.1/";
export const XMP_NS = "http://ns.adobe.com/xap/1.0/";
