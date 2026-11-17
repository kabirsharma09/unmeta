// Field classification. Mirrors metaclean/taxonomy.py so the Python and browser engines agree.

export type Category = "location" | "device" | "personal" | "ai" | "technical" | "other";
export type Risk = "none" | "low" | "medium" | "high";
export const CATEGORIES: Record<Category, string> = {
  location: "Location", device: "Device", personal: "Personal info", ai: "AI / Provenance", technical: "Technical", other: "Other",
};
export const RISK_ORDER: Record<Risk, number> = { none: 0, low: 1, medium: 2, high: 3 };
export const maxRisk = (rs: Risk[]): Risk => rs.reduce<Risk>((a, b) => (RISK_ORDER[b] > RISK_ORDER[a] ? b : a), "none");

const set = (s: string) => new Set(s.trim().split(/\s+/));

const EXIF_DEVICE = set(`Make Model LensMake LensModel LensSpecification LensSerialNumber BodySerialNumber CameraSerialNumber
  HostComputer ExposureTime FNumber ExposureProgram ISOSpeedRatings PhotographicSensitivity ShutterSpeedValue ApertureValue
  BrightnessValue ExposureBiasValue MaxApertureValue SubjectDistance MeteringMode LightSource Flash FocalLength
  FocalLengthIn35mmFilm WhiteBalance ExposureMode SceneCaptureType DigitalZoomRatio Contrast Saturation Sharpness SensingMethod
  SceneType SubjectArea SubjectLocation CompositeImage GainControl SensitivityType RecommendedExposureIndex UniqueCameraModel
  CustomRendered FocalPlaneXResolution FocalPlaneYResolution FocalPlaneResolutionUnit MakerNote ExposureIndex
  SubjectDistanceRange LocalizedCameraModel`);
const EXIF_PERSONAL = set(`Artist Copyright ImageDescription UserComment CameraOwnerName XPTitle XPComment XPAuthor XPKeywords
  XPSubject DateTime DateTimeOriginal DateTimeDigitized OffsetTime OffsetTimeOriginal OffsetTimeDigitized SubsecTime
  SubsecTimeOriginal SubsecTimeDigitized ImageUniqueID DocumentName PageName Rating RatingPercent ImageNumber ImageHistory`);
const EXIF_TECHNICAL = set(`Orientation XResolution YResolution ResolutionUnit ColorSpace YCbCrPositioning YCbCrSubSampling
  ExifVersion FlashPixVersion ComponentsConfiguration CompressedBitsPerPixel ExifImageWidth ExifImageHeight PixelXDimension
  PixelYDimension Gamma InteroperabilityIndex InteroperabilityVersion ImageWidth ImageLength BitsPerSample Compression
  PhotometricInterpretation SamplesPerPixel PlanarConfiguration WhitePoint PrimaryChromaticities YCbCrCoefficients
  ReferenceBlackWhite TransferFunction`);
const EXIF_PROVENANCE = set("Software ProcessingSoftware");
const HIGH_RISK = set("BodySerialNumber CameraSerialNumber LensSerialNumber CameraOwnerName ImageUniqueID MakerNote HostComputer");
const LOW_RISK_DEVICE = set(`ExposureTime FNumber ExposureProgram ISOSpeedRatings PhotographicSensitivity ShutterSpeedValue
  ApertureValue BrightnessValue ExposureBiasValue MaxApertureValue MeteringMode LightSource Flash FocalLength
  FocalLengthIn35mmFilm WhiteBalance ExposureMode SceneCaptureType DigitalZoomRatio Contrast Saturation Sharpness SensingMethod
  SceneType CustomRendered GainControl SensitivityType RecommendedExposureIndex SubjectDistanceRange ExposureIndex`);

export const FRIENDLY: Record<string, string> = {
  Make: "Camera maker", Model: "Camera model", LensModel: "Lens", LensMake: "Lens maker",
  BodySerialNumber: "Camera serial number", LensSerialNumber: "Lens serial number", CameraOwnerName: "Camera owner name",
  Artist: "Author", Copyright: "Copyright", DateTimeOriginal: "Date taken", DateTime: "Date modified",
  DateTimeDigitized: "Date digitised", OffsetTimeOriginal: "Time-zone offset", Software: "Software",
  ImageDescription: "Description", UserComment: "User comment", Orientation: "Orientation", HostComputer: "Computer / phone name",
  ImageUniqueID: "Unique image ID", MakerNote: "Maker note (vendor-private data)", GPSLatitude: "GPS latitude",
  GPSLongitude: "GPS longitude", GPSAltitude: "GPS altitude", GPSImgDirection: "Direction camera faced",
  GPSTimeStamp: "GPS time", GPSDateStamp: "GPS date", GPSSpeed: "Speed", GPSHPositioningError: "GPS accuracy",
};

export const AI_SOURCE_TYPES: Record<string, [string, Risk]> = {
  trainedAlgorithmicMedia: ["AI-generated", "high"],
  compositeWithTrainedAlgorithmicMedia: ["AI-edited (generative fill / composite)", "high"],
  algorithmicMedia: ["Algorithmically generated", "high"],
  compositeSynthetic: ["Synthetic composite", "high"],
  algorithmicallyEnhanced: ["Algorithmically enhanced", "medium"],
  digitalCapture: ["Captured by a camera", "low"],
  computationalCapture: ["Computational capture (phone processing)", "low"],
  digitalArt: ["Digital art", "low"],
  virtualRecording: ["Virtual recording", "medium"],
  compositeCapture: ["Composite of captures", "low"],
  screenCapture: ["Screenshot", "low"],
};

const AI_KEYWORDS = ["firefly", "dall-e", "dall·e", "dalle", "openai", "chatgpt", "gpt-4o", "gpt-image", "sora", "midjourney",
  "stable diffusion", "stablediffusion", "sdxl", "comfyui", "automatic1111", "invokeai", "fooocus", "novelai", "leonardo.ai",
  "ideogram", "imagen", "gemini", "bard", "pixel studio", "made with google ai", "edited with google ai", "magic editor",
  "generative fill", "generative expand", "bing image creator", "microsoft designer", "copilot", "flux", "black forest labs",
  "runway", "playground ai", "nightcafe", "dreamstudio", "kandinsky", "grok", "aurora", "meta ai", "imagine with meta",
  "canva magic", "krea", "recraft", "seedream", "hunyuan", "qwen-image", "nano banana", "photoroom ai", "trained algorithmic",
  "suno", "made with udio", "udio.com", "elevenlabs", "eleven labs", "google veo", "veo 3", "kling ai", "pika labs", "pika.art",
  "luma dream machine", "hailuo", "synthesia", "heygen"];
export const AI_PNG_KEYS = set("parameters prompt workflow invokeai_metadata sd-metadata dream negative_prompt fooocus_scheme generation_data aigc comment");

export function isAiText(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (AI_KEYWORDS.some(k => t.includes(k))) return true;
  return /\b(steps|sampler|cfg scale|seed)\s*:\s*\S/.test(t) && t.includes("seed");
}

export function classifyExif(name: string, text: string): [Category, Risk] {
  if (EXIF_PROVENANCE.has(name)) return ["ai", isAiText(text) ? "high" : "medium"];
  if ((name === "ImageDescription" || name === "UserComment" || name === "XPComment") && isAiText(text)) return ["ai", "high"];
  if (HIGH_RISK.has(name)) return [EXIF_PERSONAL.has(name) ? "personal" : "device", "high"];
  if (EXIF_PERSONAL.has(name)) return ["personal", "medium"];
  if (EXIF_DEVICE.has(name)) return ["device", LOW_RISK_DEVICE.has(name) ? "low" : "medium"];
  if (EXIF_TECHNICAL.has(name)) return ["technical", "none"];
  return ["other", "low"];
}

export const NS_PREFIX: Record<string, string> = {
  "http://purl.org/dc/elements/1.1/": "dc", "http://ns.adobe.com/xap/1.0/": "xmp", "http://ns.adobe.com/xap/1.0/mm/": "xmpMM",
  "http://ns.adobe.com/xap/1.0/rights/": "xmpRights", "http://ns.adobe.com/photoshop/1.0/": "photoshop",
  "http://ns.adobe.com/tiff/1.0/": "tiff", "http://ns.adobe.com/exif/1.0/": "exif", "http://cipa.jp/exif/1.0/": "exifEX",
  "http://ns.adobe.com/exif/1.0/aux/": "aux", "http://ns.adobe.com/camera-raw-settings/1.0/": "crs",
  "http://ns.adobe.com/lightroom/1.0/": "lr", "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/": "Iptc4xmpCore",
  "http://iptc.org/std/Iptc4xmpExt/2008-02-29/": "Iptc4xmpExt", "http://ns.adobe.com/xap/1.0/sType/ResourceEvent#": "stEvt",
  "http://ns.adobe.com/xap/1.0/sType/ResourceRef#": "stRef", "http://ns.google.com/photos/1.0/camera/": "GCamera",
  "http://ns.google.com/photos/1.0/container/": "Container", "http://ns.google.com/photos/1.0/image/": "GImage",
  "http://ns.google.com/photos/1.0/depthmap/": "GDepth", "http://ns.google.com/photos/1.0/panorama/": "GPano",
  "http://ns.apple.com/HDRGainMap/1.0/": "HDRGainMap", "http://ns.useplus.org/ldf/xmp/1.0/": "plus",
  "http://ns.adobe.com/xmp/1.0/DynamicMedia/": "xmpDM", "http://ns.microsoft.com/photo/1.0/": "MicrosoftPhoto",
  "http://www.metadataworkinggroup.com/schemas/regions/": "mwg-rs", "http://ns.adobe.com/hdr-gain-map/1.0/": "hdrgm",
};

const XMP_LOCATION = /^(exif:GPS|photoshop:(City|State|Country)|Iptc4xmpCore:(Location|CountryCode)|Iptc4xmpExt:Location)/;
const XMP_DEVICE = /^(tiff:(Make|Model)|aux:|exif:(FNumber|ExposureTime|ISO|Focal|Flash|Lens|MeteringMode|WhiteBalance|ExposureProgram)|exifEX:(Lens|BodySerial)|GCamera:)/;
const XMP_PERSONAL = /^(dc:(creator|rights|description|title|subject)|xmpRights:|photoshop:(AuthorsPosition|CaptionWriter|Headline|Instructions|Source|TransmissionReference|DateCreated)|Iptc4xmpCore:(CreatorContactInfo|Scene|SubjectCode|IntellectualGenre)|Iptc4xmpExt:(PersonInImage|ArtworkOrObject)|xmp:(CreateDate|ModifyDate|MetadataDate|Rating|Label)|xmpMM:(DocumentID|InstanceID|OriginalDocumentID)|mwg-rs:|MicrosoftPhoto:|plus:|lr:|exif:DateTime)/;
const XMP_AI = /^(Iptc4xmpExt:DigitalSourceType|xmp:CreatorTool|xmpMM:(History|DerivedFrom|Ingredients|Pantry|Manifest)|photoshop:(Credit|History|DocumentAncestors)|tiff:Software|crs:)/;
const XMP_TECH = /^(tiff:(Orientation|XResolution|YResolution|ResolutionUnit|ImageWidth|ImageLength|BitsPerSample|PhotometricInterpretation)|exif:(PixelXDimension|PixelYDimension|ColorSpace|ExifVersion)|photoshop:(ColorMode|ICCProfile)|HDRGainMap:|hdrgm:|GImage:|GDepth:|Container:|xmpDM:|xmp:Thumbnails)/;

export function classifyXmp(q: string, value: string): [Category, Risk] {
  if (q === "Iptc4xmpExt:DigitalSourceType") {
    const key = value.replace(/\/+$/, "").split("/").pop()!;
    return ["ai", AI_SOURCE_TYPES[key]?.[1] ?? "medium"];
  }
  if (XMP_AI.test(q)) return ["ai", isAiText(value) ? "high" : "medium"];
  if (XMP_LOCATION.test(q)) return ["location", "high"];
  // embedded pictures inside XMP: thumbnails, Google portrait/depth images, motion-photo containers. They can show
  // the original, uncropped or unedited picture, so they're private, never "technical".
  if (/^(xmp:Thumbnails|xapGImg:|GImage:|GDepth:|Container:|GContainer:|GCamera:)/.test(q)) return ["personal", "medium"];
  if (isAiText(value) && ["dc", "photoshop", "xmp"].includes(q.split(":")[0])) return ["ai", "high"];
  if (XMP_DEVICE.test(q)) return ["device", q.includes("Serial") ? "high" : "medium"];
  if (XMP_PERSONAL.test(q)) return ["personal", q.startsWith("xmpMM:") || q.startsWith("mwg-rs:") ? "high" : "medium"];
  if (XMP_TECH.test(q)) return ["technical", "none"];
  return ["other", "low"];
}

export const IPTC_NAMES: Record<string, string> = {
  "1:90": "CodedCharacterSet", "2:0": "RecordVersion", "2:5": "ObjectName", "2:7": "EditStatus", "2:10": "Urgency",
  "2:15": "Category", "2:20": "SupplementalCategories", "2:25": "Keywords", "2:40": "SpecialInstructions",
  "2:55": "DateCreated", "2:60": "TimeCreated", "2:62": "DigitalCreationDate", "2:63": "DigitalCreationTime",
  "2:65": "OriginatingProgram", "2:70": "ProgramVersion", "2:80": "By-line", "2:85": "By-lineTitle", "2:90": "City",
  "2:92": "Sub-location", "2:95": "Province-State", "2:100": "Country-PrimaryLocationCode",
  "2:101": "Country-PrimaryLocationName", "2:103": "OriginalTransmissionReference", "2:105": "Headline", "2:110": "Credit",
  "2:115": "Source", "2:116": "CopyrightNotice", "2:118": "Contact", "2:120": "Caption-Abstract", "2:122": "Writer-Editor",
};
const IPTC_LOCATION = new Set([90, 92, 95, 100, 101]);
const IPTC_PERSONAL = new Set([5, 25, 40, 55, 60, 62, 63, 80, 85, 103, 105, 115, 116, 118, 120, 122]);
const IPTC_AI = new Set([65, 70, 110]);

export function classifyIptc(rec: number, ds: number, value: string): [Category, Risk] {
  if (rec !== 2) return ["technical", "none"];
  if (IPTC_AI.has(ds)) return ["ai", isAiText(value) ? "high" : "medium"];
  if (isAiText(value)) return ["ai", "high"];
  if (IPTC_LOCATION.has(ds)) return ["location", "high"];
  if (IPTC_PERSONAL.has(ds)) return ["personal", ds === 118 ? "high" : "medium"];
  if (ds === 0) return ["technical", "none"];
  return ["other", "low"];
}

// Keys come from untrusted files: no prototype, so names like "constructor" or "__proto__" are just unknown.
Object.setPrototypeOf(FRIENDLY, null);
Object.setPrototypeOf(AI_SOURCE_TYPES, null);
Object.setPrototypeOf(NS_PREFIX, null);
Object.setPrototypeOf(IPTC_NAMES, null);
