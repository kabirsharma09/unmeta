import type { Options } from "./clean.ts";

// "What should stay in your photos?" Every choice keeps the colour profile and rotation, so photos look identical.
export interface Preset { key: string; title: string; detail: string; options: Options }

const COPYRIGHT = ["exif:0:315", "exif:0:33432", "xmp:dc:creator", "xmp:dc:rights", "xmp:xmpRights:Marked",
  "xmp:xmpRights:UsageTerms", "xmp:xmpRights:WebStatement", "iptc:2:80", "iptc:2:116"];
const SERIALS = ["exif:exif:42033", "exif:exif:42037", "exif:exif:42032", "exif:0:316", "xmp:aux:SerialNumber",
  "xmp:exifEX:BodySerialNumber", "xmp:exifEX:LensSerialNumber", "xmp:aux:LensSerialNumber", "exif:exif:42016"];

export const PRESETS = {
  everything: { key: "everything", title: "Nothing private", detail: "Removes location, device, names, dates and AI labels.",
    options: { keepCategories: ["technical"] } },
  copyright: { key: "copyright", title: "My name and copyright", detail: "Keeps your credit. Removes everything else.",
    options: { keepCategories: ["technical"], keepFields: COPYRIGHT } },
  camera: { key: "camera", title: "Camera settings", detail: "Keeps camera, lens and exposure. Removes location and serial numbers.",
    options: { keepCategories: ["technical", "device"], dropFields: SERIALS } },
  location: { key: "location", title: "Everything except location", detail: "Removes only where the photo was taken.",
    options: { keepCategories: ["device", "personal", "ai", "technical", "other"] } },
  ai: { key: "ai", title: "Everything except AI labels", detail: "Removes only AI labels and editing history.",
    options: { keepCategories: ["location", "device", "personal", "technical", "other"] } },
} satisfies Record<string, Preset>;

export type PresetKey = keyof typeof PRESETS;
export const PRESET_LIST: Preset[] = Object.values(PRESETS);
