"""Field classification: category, risk and plain-language labels."""
from __future__ import annotations

import re

from PIL import ExifTags

CATEGORIES = {
    "location": "Location",
    "device": "Device",
    "personal": "Personal info",
    "ai": "AI / Provenance",
    "technical": "Technical",
    "other": "Other",
}
RISK_ORDER = {"none": 0, "low": 1, "medium": 2, "high": 3}

# ---- EXIF ------------------------------------------------------------------
EXIF_NAMES = dict(ExifTags.TAGS)
GPS_NAMES = dict(ExifTags.GPSTAGS)

EXIF_DEVICE = {"Make", "Model", "LensMake", "LensModel", "LensSpecification", "LensSerialNumber",
               "BodySerialNumber", "CameraSerialNumber", "HostComputer", "ExposureTime", "FNumber",
               "ExposureProgram", "ISOSpeedRatings", "PhotographicSensitivity", "ShutterSpeedValue",
               "ApertureValue", "BrightnessValue", "ExposureBiasValue", "MaxApertureValue",
               "SubjectDistance", "MeteringMode", "LightSource", "Flash", "FocalLength",
               "FocalLengthIn35mmFilm", "WhiteBalance", "ExposureMode", "SceneCaptureType",
               "DigitalZoomRatio", "Contrast", "Saturation", "Sharpness", "SensingMethod",
               "SceneType", "SubjectArea", "SubjectLocation", "CompositeImage", "GainControl",
               "SensitivityType", "RecommendedExposureIndex", "UniqueCameraModel", "CustomRendered",
               "FocalPlaneXResolution", "FocalPlaneYResolution", "FocalPlaneResolutionUnit",
               "MakerNote", "ExposureIndex", "SubjectDistanceRange", "LocalizedCameraModel"}
EXIF_PERSONAL = {"Artist", "Copyright", "ImageDescription", "UserComment", "CameraOwnerName",
                 "XPTitle", "XPComment", "XPAuthor", "XPKeywords", "XPSubject", "DateTime",
                 "DateTimeOriginal", "DateTimeDigitized", "OffsetTime", "OffsetTimeOriginal",
                 "OffsetTimeDigitized", "SubsecTime", "SubsecTimeOriginal", "SubsecTimeDigitized",
                 "ImageUniqueID", "DocumentName", "PageName", "Rating", "RatingPercent",
                 "ImageNumber", "ImageHistory"}
EXIF_TECHNICAL = {"Orientation", "XResolution", "YResolution", "ResolutionUnit", "ColorSpace",
                  "YCbCrPositioning", "YCbCrSubSampling", "ExifVersion", "FlashPixVersion",
                  "ComponentsConfiguration", "CompressedBitsPerPixel", "ExifImageWidth",
                  "ExifImageHeight", "PixelXDimension", "PixelYDimension", "Gamma",
                  "InteroperabilityIndex", "InteroperabilityVersion", "ImageWidth", "ImageLength",
                  "BitsPerSample", "Compression", "PhotometricInterpretation", "SamplesPerPixel",
                  "PlanarConfiguration", "WhitePoint", "PrimaryChromaticities",
                  "YCbCrCoefficients", "ReferenceBlackWhite", "TransferFunction"}
EXIF_PROVENANCE = {"Software", "ProcessingSoftware"}

HIGH_RISK_NAMES = {"BodySerialNumber", "CameraSerialNumber", "LensSerialNumber", "CameraOwnerName",
                   "ImageUniqueID", "MakerNote", "HostComputer"}
LOW_RISK_DEVICE = {"ExposureTime", "FNumber", "ExposureProgram", "ISOSpeedRatings",
                   "PhotographicSensitivity", "ShutterSpeedValue", "ApertureValue", "BrightnessValue",
                   "ExposureBiasValue", "MaxApertureValue", "MeteringMode", "LightSource", "Flash",
                   "FocalLength", "FocalLengthIn35mmFilm", "WhiteBalance", "ExposureMode",
                   "SceneCaptureType", "DigitalZoomRatio", "Contrast", "Saturation", "Sharpness",
                   "SensingMethod", "SceneType", "CustomRendered", "GainControl", "SensitivityType",
                   "RecommendedExposureIndex", "SubjectDistanceRange", "ExposureIndex"}

FRIENDLY = {
    "Make": "Camera maker", "Model": "Camera model", "LensModel": "Lens", "LensMake": "Lens maker",
    "BodySerialNumber": "Camera serial number", "LensSerialNumber": "Lens serial number",
    "CameraOwnerName": "Camera owner name", "Artist": "Author", "Copyright": "Copyright",
    "DateTimeOriginal": "Date taken", "DateTime": "Date modified", "DateTimeDigitized": "Date digitised",
    "OffsetTimeOriginal": "Time-zone offset", "Software": "Software", "ImageDescription": "Description",
    "UserComment": "User comment", "Orientation": "Orientation", "HostComputer": "Computer / phone name",
    "ImageUniqueID": "Unique image ID", "MakerNote": "Maker note (vendor-private data)",
    "GPSLatitude": "GPS latitude", "GPSLongitude": "GPS longitude", "GPSAltitude": "GPS altitude",
    "GPSImgDirection": "Direction camera faced", "GPSTimeStamp": "GPS time", "GPSDateStamp": "GPS date",
    "GPSSpeed": "Speed", "GPSHPositioningError": "GPS accuracy",
}


def classify_exif(name: str, value_text: str) -> tuple[str, str]:
    """Return (category, risk) for an IFD0/Exif-IFD tag name."""
    if name in EXIF_PROVENANCE:
        return "ai", "high" if is_ai_text(value_text) else "medium"
    if name in ("ImageDescription", "UserComment", "XPComment") and is_ai_text(value_text):
        return "ai", "high"
    if name in HIGH_RISK_NAMES:
        return ("personal" if name in EXIF_PERSONAL else "device"), "high"
    if name in EXIF_PERSONAL:
        return "personal", "medium"
    if name in EXIF_DEVICE:
        return "device", "low" if name in LOW_RISK_DEVICE else "medium"
    if name in EXIF_TECHNICAL:
        return "technical", "none"
    return "other", "low"


# ---- AI signals ---------------------------------------------------------------
AI_SOURCE_TYPES = {
    "trainedAlgorithmicMedia": ("AI-generated", "high"),
    "compositeWithTrainedAlgorithmicMedia": ("AI-edited (generative fill / composite)", "high"),
    "algorithmicMedia": ("Algorithmically generated", "high"),
    "compositeSynthetic": ("Synthetic composite", "high"),
    "algorithmicallyEnhanced": ("Algorithmically enhanced", "medium"),
    "digitalCapture": ("Captured by a camera", "low"),
    "computationalCapture": ("Computational capture (phone processing)", "low"),
    "digitalArt": ("Digital art", "low"),
    "virtualRecording": ("Virtual recording", "medium"),
    "compositeCapture": ("Composite of captures", "low"),
    "screenCapture": ("Screenshot", "low"),
}

AI_KEYWORDS = [
    "firefly", "dall-e", "dall·e", "dalle", "openai", "chatgpt", "gpt-4o", "gpt-image", "sora", "midjourney",
    "stable diffusion", "stablediffusion", "sdxl", "comfyui", "automatic1111", "invokeai", "fooocus",
    "novelai", "leonardo.ai", "ideogram", "imagen", "gemini", "bard", "pixel studio", "made with google ai",
    "edited with google ai", "magic editor", "generative fill", "generative expand", "bing image creator",
    "microsoft designer", "copilot", "flux", "black forest labs", "runway", "playground ai", "nightcafe",
    "dreamstudio", "kandinsky", "grok", "aurora", "meta ai", "imagine with meta", "canva magic", "krea",
    "recraft", "seedream", "hunyuan", "qwen-image", "nano banana", "photoroom ai", "trained algorithmic",
]
AI_PNG_KEYS = {"parameters", "prompt", "workflow", "invokeai_metadata", "sd-metadata", "dream",
               "negative_prompt", "fooocus_scheme", "generation_data", "aigc", "comment"}


def is_ai_text(text: str) -> bool:
    t = (text or "").lower()
    if any(k in t for k in AI_KEYWORDS):
        return True
    return bool(re.search(r"\b(steps|sampler|cfg scale|seed)\s*:\s*\S", t) and "seed" in t)


# ---- XMP ---------------------------------------------------------------------
NS_PREFIX = {
    "http://purl.org/dc/elements/1.1/": "dc",
    "http://ns.adobe.com/xap/1.0/": "xmp",
    "http://ns.adobe.com/xap/1.0/mm/": "xmpMM",
    "http://ns.adobe.com/xap/1.0/rights/": "xmpRights",
    "http://ns.adobe.com/photoshop/1.0/": "photoshop",
    "http://ns.adobe.com/tiff/1.0/": "tiff",
    "http://ns.adobe.com/exif/1.0/": "exif",
    "http://cipa.jp/exif/1.0/": "exifEX",
    "http://ns.adobe.com/exif/1.0/aux/": "aux",
    "http://ns.adobe.com/camera-raw-settings/1.0/": "crs",
    "http://ns.adobe.com/lightroom/1.0/": "lr",
    "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/": "Iptc4xmpCore",
    "http://iptc.org/std/Iptc4xmpExt/2008-02-29/": "Iptc4xmpExt",
    "http://ns.adobe.com/xap/1.0/sType/ResourceEvent#": "stEvt",
    "http://ns.adobe.com/xap/1.0/sType/ResourceRef#": "stRef",
    "http://ns.google.com/photos/1.0/camera/": "GCamera",
    "http://ns.google.com/photos/1.0/container/": "Container",
    "http://ns.google.com/photos/1.0/image/": "GImage",
    "http://ns.google.com/photos/1.0/depthmap/": "GDepth",
    "http://ns.google.com/photos/1.0/panorama/": "GPano",
    "http://ns.apple.com/HDRGainMap/1.0/": "HDRGainMap",
    "http://ns.useplus.org/ldf/xmp/1.0/": "plus",
    "http://ns.adobe.com/xmp/1.0/DynamicMedia/": "xmpDM",
    "http://ns.microsoft.com/photo/1.0/": "MicrosoftPhoto",
    "http://www.metadataworkinggroup.com/schemas/regions/": "mwg-rs",
    "http://ns.adobe.com/hdr-gain-map/1.0/": "hdrgm",
}

XMP_LOCATION_RE = re.compile(r"^(exif:GPS|photoshop:(City|State|Country)|Iptc4xmpCore:(Location|CountryCode)"
                             r"|Iptc4xmpExt:Location)")
XMP_DEVICE_RE = re.compile(r"^(tiff:(Make|Model)|aux:|exif:(FNumber|ExposureTime|ISO|Focal|Flash|Lens|"
                           r"MeteringMode|WhiteBalance|ExposureProgram)|exifEX:(Lens|BodySerial)|GCamera:)")
XMP_PERSONAL_RE = re.compile(r"^(dc:(creator|rights|description|title|subject)|xmpRights:|photoshop:"
                             r"(AuthorsPosition|CaptionWriter|Headline|Instructions|Source|TransmissionReference|"
                             r"DateCreated)|Iptc4xmpCore:(CreatorContactInfo|Scene|SubjectCode|IntellectualGenre)|"
                             r"Iptc4xmpExt:(PersonInImage|ArtworkOrObject)|xmp:(CreateDate|ModifyDate|MetadataDate|"
                             r"Rating|Label)|xmpMM:(DocumentID|InstanceID|OriginalDocumentID)|mwg-rs:|"
                             r"MicrosoftPhoto:|plus:|lr:|exif:DateTime)")
XMP_AI_RE = re.compile(r"^(Iptc4xmpExt:DigitalSourceType|xmp:CreatorTool|xmpMM:(History|DerivedFrom|Ingredients|"
                       r"Pantry|Manifest)|photoshop:(Credit|History|DocumentAncestors)|tiff:Software|crs:)")
XMP_TECH_RE = re.compile(r"^(tiff:(Orientation|XResolution|YResolution|ResolutionUnit|ImageWidth|ImageLength|"
                         r"BitsPerSample|PhotometricInterpretation)|exif:(PixelXDimension|PixelYDimension|ColorSpace|"
                         r"ExifVersion)|photoshop:(ColorMode|ICCProfile)|HDRGainMap:|hdrgm:|GImage:|GDepth:|"
                         r"Container:|xmpDM:|xmp:Thumbnails)")


def classify_xmp(qname: str, value: str) -> tuple[str, str]:
    if qname == "Iptc4xmpExt:DigitalSourceType":
        key = value.rstrip("/").rsplit("/", 1)[-1]
        return "ai", AI_SOURCE_TYPES.get(key, ("", "medium"))[1]
    if XMP_AI_RE.match(qname):
        return "ai", "high" if is_ai_text(value) else "medium"
    if XMP_LOCATION_RE.match(qname):
        return "location", "high"
    if is_ai_text(value) and qname.split(":")[0] in ("dc", "photoshop", "xmp"):
        return "ai", "high"
    if XMP_DEVICE_RE.match(qname):
        serial = "Serial" in qname
        return "device", "high" if serial else "medium"
    if XMP_PERSONAL_RE.match(qname):
        tracking = qname.startswith("xmpMM:") or qname.startswith("mwg-rs:")
        return "personal", "high" if tracking else "medium"
    if XMP_TECH_RE.match(qname):
        return "technical", "none"
    return "other", "low"


# ---- IPTC IIM -----------------------------------------------------------------
IPTC_NAMES = {
    (1, 90): "CodedCharacterSet", (2, 0): "RecordVersion", (2, 5): "ObjectName", (2, 7): "EditStatus",
    (2, 10): "Urgency", (2, 15): "Category", (2, 20): "SupplementalCategories", (2, 25): "Keywords",
    (2, 40): "SpecialInstructions", (2, 55): "DateCreated", (2, 60): "TimeCreated",
    (2, 62): "DigitalCreationDate", (2, 63): "DigitalCreationTime", (2, 65): "OriginatingProgram",
    (2, 70): "ProgramVersion", (2, 80): "By-line", (2, 85): "By-lineTitle", (2, 90): "City",
    (2, 92): "Sub-location", (2, 95): "Province-State", (2, 100): "Country-PrimaryLocationCode",
    (2, 101): "Country-PrimaryLocationName", (2, 103): "OriginalTransmissionReference",
    (2, 105): "Headline", (2, 110): "Credit", (2, 115): "Source", (2, 116): "CopyrightNotice",
    (2, 118): "Contact", (2, 120): "Caption-Abstract", (2, 122): "Writer-Editor",
}
IPTC_LOCATION = {90, 92, 95, 100, 101}
IPTC_PERSONAL = {5, 25, 40, 55, 60, 62, 63, 80, 85, 103, 105, 115, 116, 118, 120, 122}
IPTC_AI = {65, 70, 110}


def classify_iptc(record: int, ds: int, value: str) -> tuple[str, str]:
    if record != 2:
        return "technical", "none"
    if ds in IPTC_AI:
        return "ai", "high" if is_ai_text(value) else "medium"
    if is_ai_text(value):
        return "ai", "high"
    if ds in IPTC_LOCATION:
        return "location", "high"
    if ds in IPTC_PERSONAL:
        return "personal", "high" if ds == 118 else "medium"
    if ds == 0:
        return "technical", "none"
    return "other", "low"
