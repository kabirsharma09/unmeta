// Web worker entry: the UnMeta engine, running inside the visitor's browser.
// Files are read and cleaned here; nothing is sent to any server.
// Photos arrive as an ArrayBuffer. Videos and audio arrive as a File and are read in small slices, so a
// multi-gigabyte video never has to fit in memory: the clean copy is a Blob stitched from slices of the original.
// Build: npm run build:web  (outputs metaclean/static/engine.worker.js)
import { clean, type Options } from "./clean.ts";
import { highlights } from "./highlights.ts";
import { type Inventory, inspect, toReport } from "./inspect.ts";
import { type MediaInventory, type Source, cleanMedia, inspectMedia } from "./media.ts";
import { previewFor } from "./preview.ts";
import { type DocInventory, cleanDocument, detectDoc, docHighlights, inspectDocument, toDocReport } from "./docs.ts";

interface Held { name: string; data?: Uint8Array; file?: Blob; inv: Inventory; type?: string; doc?: boolean }
const held = new Map<number, Held>();

type Msg =
  | { type: "inspect"; id: number; name: string; buffer?: ArrayBuffer; file?: File }
  | { type: "clean"; id: number; options: Options }
  | { type: "forget"; ids: number[] };

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const blobSource = (b: Blob): Source => ({ size: b.size, read: async (o, n) => new Uint8Array(await b.slice(o, o + n).arrayBuffer()) });

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === "inspect") {
      if (m.file && detectDoc(new Uint8Array(await m.file.slice(0, 1024).arrayBuffer()), m.name)) {
        const inv = await inspectDocument(blobSource(m.file), m.name);
        held.set(m.id, { name: m.name, file: m.file, inv, type: m.file.type, doc: true });
        const report = toDocReport(inv);
        post({ type: "inspected", id: m.id, report, found: docHighlights(report) });
        return;
      }
      if (m.file) {
        const inv = await inspectMedia(blobSource(m.file), m.name);
        held.set(m.id, { name: m.name, file: m.file, inv, type: m.file.type });
        const report = toReport(inv);
        post({ type: "inspected", id: m.id, report, found: highlights(report) });
        return;
      }
      const data = new Uint8Array(m.buffer!);
      const inv = inspect(data, m.name);
      held.set(m.id, { name: m.name, data, inv });
      const report = toReport(inv);
      // HEIC and RAW: hand the page the file's own small preview, since most browsers can't show these formats
      const preview = previewFor(inv.fmt, data);
      const transfer: Transferable[] = [];
      if (preview) { preview.data = preview.data.slice(); transfer.push(preview.data.buffer); }
      post({ type: "inspected", id: m.id, report, found: highlights(report), preview }, transfer);
    } else if (m.type === "clean") {
      const h = held.get(m.id);
      if (!h) throw new Error("This file is no longer available. Add it again.");
      if (h.file && h.doc) {
        const r = await cleanDocument(blobSource(h.file), h.name, m.options, h.inv as DocInventory);
        const blob = new Blob(r.parts.map(p => ("bytes" in p ? p.bytes as BlobPart : h.file!.slice(p.from, p.to))), { type: h.type || "" });
        post({ type: "cleaned", id: m.id, verified: r.verified, pixelsUntouched: r.pixelsUntouched, notes: r.notes,
          after: toDocReport(r.after), left: r.after.fields.map(f => f.id), blob });
        return;
      }
      if (h.file) {
        const r = await cleanMedia(blobSource(h.file), h.name, m.options, h.inv as MediaInventory);
        const blob = new Blob(r.parts.map(p => ("bytes" in p ? p.bytes as BlobPart : h.file!.slice(p.from, p.to))), { type: h.type || "" });
        post({ type: "cleaned", id: m.id, verified: r.verified, pixelsUntouched: r.pixelsUntouched, notes: r.notes,
          after: toReport(r.after), left: r.after.fields.map(f => f.id), blob });
        return;
      }
      const r = clean(h.data!, h.name, m.options, h.inv);
      const after = toReport(r.after);
      const left = new Set(r.after.fields.map(f => f.id));
      const copy = r.data.slice().buffer;  // keep our copy for zips; transfer this one
      post({ type: "cleaned", id: m.id, verified: r.verified, pixelsUntouched: r.pixelsUntouched,
        notes: r.notes, after, left: [...left], buffer: copy }, [copy]);
    } else if (m.type === "forget") {
      m.ids.forEach(id => held.delete(id));
    }
  } catch (err) {
    post({ type: "error", id: (m as { id?: number }).id, message: err instanceof Error ? err.message : String(err) });
  }
};
