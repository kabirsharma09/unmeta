// The few things worth telling someone about a photo, in plain words. Everything else stays out of sight.
import type { Field, Report } from "./inspect.ts";

export type HighlightKey = "location" | "device" | "personal" | "ai" | "hidden";
/** title: what it is · value: the actual detail found (one short line) · why: shown on tap */
export interface Highlight { key: HighlightKey; title: string; value: string; why: string; ids: string[] }

const TITLES: Record<HighlightKey, string> = {
  location: "Where it was taken",
  device: "What it was taken with",
  personal: "Who took it and when",
  ai: "AI label",
  hidden: "Hidden copy of the photo",
};
const MEDIA_TITLES: Record<HighlightKey, string> = {
  location: "Where it was recorded",
  device: "What it was recorded with",
  personal: "Who recorded it and when",
  ai: "AI label",
  hidden: "Hidden picture",
};
export const highlightTitle = (k: HighlightKey) => TITLES[k];

const WHY: Record<HighlightKey, string> = {
  location: "Anyone with the photo can see the exact spot, such as your home.",
  device: "Identifies your phone or camera. A serial number can link all your photos together.",
  personal: "Shows who took the photo and when it was taken.",
  ai: "Instagram, LinkedIn and TikTok read this and can show an AI label on your post.",
  hidden: "It can show more than the photo itself, like the original before cropping.",
};
const MEDIA_WHY: Record<HighlightKey, string> = {
  location: "Anyone with the file can see the exact spot, such as your home.",
  device: "Identifies your phone, camera or recorder, and can link your recordings together.",
  personal: "Shows who made the recording and when.",
  ai: "Platforms read this and can show an AI label on your post.",
  hidden: "A picture saved inside the file, which may show more than you meant to share.",
};

const HIDDEN_IDS = ["exif:thumbnail", "jpeg:jfxx", "jpeg:trailer", "jpeg:mpf", "jpeg:photoshop_irb"];
const NAME_FIELDS = /^(Artist|dc:creator|By-line|Author|CameraOwnerName|XPAuthor|©ART|©aut|©wrt|aART|auth|perf|TPE1|TP1|TPE2|TCOM|IART|IENG|ITCH|artist)$|\.(author|artist|displayname)$/;
const PICTURE = (f: Field) => /^(covr|APIC|PIC)$/.test(f.name);

function date(s?: string) {
  const m = s?.match(/(\d{4})[:\-](\d{2})[:\-](\d{2})/);
  if (!m) return undefined;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${+m[3]} ${months[+m[2] - 1]} ${m[1]}`;
}
const and = (a: string[]) => (a.length < 2 ? a[0] ?? "" : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

export function highlights(rep: Report): Highlight[] {
  const all: Field[] = Object.values(rep.groups).flatMap(g => g.fields);
  const get = (id: string) => all.find(f => f.id === id)?.value;
  const out: Highlight[] = [];

  const media = rep.kind && rep.kind !== "photo";
  const push = (key: HighlightKey, value: string, ids: string[]) =>
    out.push({ key, title: (media ? MEDIA_TITLES : TITLES)[key], value, why: (media ? MEDIA_WHY : WHY)[key], ids });

  const loc = all.filter(f => f.category === "location");
  if (loc.length) {
    // place names only: raw coordinates (EXIF GPS, ISO 6709 strings) are shown once, as decimals
    const places = [...new Set(loc.filter(f => !f.id.startsWith("exif:gps")).map(f => f.value)
      .filter(v => v && !/^[+-]?\d+(\.\d+)?[+-]\d/.test(v) && !/^\d+(\.\d+)?,\s*-?\d/.test(v)))];
    const coords = rep.gps ? `${rep.gps[0].toFixed(4)}, ${rep.gps[1].toFixed(4)}` : "";
    push("location", [places.slice(0, 2).join(", "), coords].filter(Boolean).join(" · "), loc.map(f => f.id));
  }

  const dev = all.filter(f => f.category === "device");
  const byLabel = (l: string) => all.find(f => f.label === l && f.category === "device")?.value;
  const make = get("exif:0:271") || get("xmp:tiff:Make") || byLabel("Make"), model = get("exif:0:272") || get("xmp:tiff:Model") || byLabel("Model")
    || all.find(f => f.label === "Recorder")?.value;
  if (dev.length && (make || model || dev.some(f => f.risk === "high" || (f.risk === "medium" && /serial|CAME|SNUM|reference/i.test(f.name + f.label))))) {
    const camera = model ? (make && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : model) : make;
    const extras: string[] = [];
    if (dev.some(f => /Serial|CAME|SNUM|reference/i.test(f.name + f.label))) extras.push("serial number");
    if (get("exif:0:316")) extras.push("device name");
    push("device", [camera || "Camera details", ...extras].join(" · "), dev.map(f => f.id));
  }

  const names = [...new Set(all.filter(f => NAME_FIELDS.test(f.name)).map(f => f.value).filter(Boolean))];
  const when = date(get("exif:exif:36867") || get("exif:0:306") || get("xmp:xmp:CreateDate") || get("png:tIME")
    || all.find(f => /^(Date recorded|Date|Year)$/.test(f.label) && f.category === "personal" && f.id !== "mp4:times")?.value
    || get("mp4:times"));
  if (names.length || when) {
    push("personal", [and(names.slice(0, 2)), when].filter(Boolean).join(" · "),
      all.filter(f => f.category === "personal" && !HIDDEN_IDS.includes(f.id) && !PICTURE(f)).map(f => f.id));
  }

  if (rep.ai_signals.length) {
    const v = rep.ai_signals.map(s => s.verdict);
    const value = v.includes("AI-generated") ? "Made with AI"
      : v.some(x => /AI-edited|Synthetic|generated/i.test(x)) ? "Edited with AI"
        : rep.ai_signals.some(s => s.signal.startsWith("C2PA")) ? "Content Credentials" : "Names an AI app";
    push("ai", value, all.filter(f => f.category === "ai").map(f => f.id));
  }

  const hidden = all.filter(f => (HIDDEN_IDS.includes(f.id) && (f.id !== "jpeg:photoshop_irb" || /Thumbnail/.test(f.value))) || PICTURE(f));
  if (hidden.length) {
    const video = hidden.some(f => f.id === "jpeg:trailer" && /video/.test(f.value));
    push("hidden", video ? "Short video" : media ? "Cover picture" : "Preview image", hidden.map(f => f.id));
  }
  return out;
}
