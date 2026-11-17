# MetaClean — Research, Feature Plan, Stack & Flow

## 1. Research summary

### 1.1 Where metadata lives inside an image

| Block | What it is | Where it sits | Privacy / provenance relevance |
|---|---|---|---|
| **EXIF** (TIFF IFD0, Exif IFD, GPS IFD, Interop IFD, IFD1) | Camera-written tags: Make, Model, LensModel, BodySerialNumber, DateTimeOriginal, OffsetTime, Software, Artist, Copyright, Orientation, GPS lat/long/alt/direction/timestamp | JPEG `APP1 "Exif\0\0"`, PNG `eXIf`, WebP `EXIF` chunk, HEIC/AVIF `Exif` item, TIFF/RAW native IFDs | GPS = home address. Serial numbers link photos to one physical camera. Timestamps + timezone offsets reveal routine. |
| **Maker notes** | Vendor-private blob inside Exif IFD (tag 0x927C). Can hold serials, shutter count, owner name, face-detection data, even GPS copies | Inside EXIF | Often missed by "remove GPS only" tools; must go with EXIF. |
| **Embedded thumbnail** | IFD1 JPEG preview, plus MPF secondary images (APP2 `MPF`), Photoshop thumbnails (8BIM 0x040C) | EXIF IFD1, APP2, APP13 | A thumbnail can show the **un-cropped / un-redacted** original. |
| **IPTC IIM** | Legacy newsroom record: By-line, Credit, Copyright, Caption, Keywords, City, Country, Contact | JPEG `APP13 "Photoshop 3.0"` → 8BIM resource 0x0404 | Personal names, contact info, location text. |
| **XMP** | RDF/XML packet. Dublin Core, Photoshop, xmpMM edit history (DocumentID, History, DerivedFrom), Iptc4xmpExt (DigitalSourceType), Lightroom develop settings | JPEG `APP1 "http://ns.adobe.com/xap/1.0/"` (+ Extended XMP), PNG `iTXt XML:com.adobe.xmp`, WebP `XMP ` chunk, HEIC `mime` item, TIFF tag 700 | Edit history reveals source files and software; DigitalSourceType is **the** AI signal used by Meta/Google. |
| **ICC profile** | Colour profile | JPEG `APP2 ICC_PROFILE`, PNG `iCCP`, WebP `ICCP`, HEIC `colr` | Needed for correct colours (Display P3!). Device-specific profiles are a weak fingerprint. Keep by default for sharing. |
| **C2PA / Content Credentials** | Cryptographically signed manifest store in **JUMBF** boxes (`jumb`/`jumd`, label `c2pa`), with claims, assertions (`c2pa.actions` incl. `digitalSourceType`, `c2pa.ai_generative_training`), signer certificate | JPEG `APP11` (JP/JUMBF segments), PNG `caBX` chunk, WebP `C2PA` chunk, HEIF/AVIF `uuid` box, TIFF tag | Signals "made with AI" to LinkedIn, TikTok, Google Photos, Adobe. Also contains the issuer, tool and edit actions. |
| **Generator text chunks** | Stable Diffusion/A1111 `parameters`, ComfyUI `prompt` + `workflow`, NovelAI `Comment`/`Description`/`Software`, InvokeAI `invokeai_metadata`, Fooocus `fooocus_scheme`, Midjourney `Description` + IPTC | PNG `tEXt`/`iTXt`/`zTXt`, JPEG `COM`, EXIF UserComment | Full prompt, seed, model hash, LoRA names — a very loud AI flag and sometimes private prompt text. |
| **Other** | PNG `tIME`, Photoshop IRBs (APP13), Adobe `APP14`, Ducky `APP12`, JPEG comments `COM`, file-system xattrs (macOS `com.apple.quarantine`, `kMDItemWhereFroms`) | various | xattrs leak download URLs; not inside the file but travel with AirDrop/zip. |

### 1.2 Fields that signal AI involvement

* **IPTC DigitalSourceType** (XMP `Iptc4xmpExt:DigitalSourceType`, and inside C2PA `c2pa.actions`): values
  `trainedAlgorithmicMedia` (fully generated), `compositeWithTrainedAlgorithmicMedia` (AI inpaint/outpaint/generative fill),
  `algorithmicMedia`, `compositeSynthetic`, `algorithmicallyEnhanced`, plus `digitalCapture` (genuine camera).
* **C2PA manifest** presence, `claim_generator` (e.g. "Adobe Firefly", "OpenAI", "Google Pixel Studio", "Microsoft Designer"), and actions such as `c2pa.created` with an AI digitalSourceType.
* **XMP / EXIF Software, CreatorTool, HistorySoftwareAgent**: "Adobe Firefly", "DALL·E", "Midjourney", "Stable Diffusion", "ComfyUI", "Imagen", "Gemini", "Pixel Studio".
* **IPTC Credit / XMP photoshop:Credit**: Google writes "Made with Google AI" / "Edited with Google AI".
* **PNG text chunks**: `parameters`, `prompt`, `workflow`, `Comment` (JSON with `steps`, `sampler`, `seed`), `Software: NovelAI`, `invokeai_metadata`.
* **EXIF UserComment / ImageDescription** containing generation parameters (A1111 JPEG/WebP saves).

### 1.3 How platforms read these signals (as of late 2026, from public reporting)

| Platform | What it reads | Notes |
|---|---|---|
| **Meta (Facebook/Instagram/Threads)** | IPTC DigitalSourceType in XMP and C2PA; plus invisible watermarks from its own tools | "Made with AI" (May 2024) renamed "AI info" (Jul 2024) after real photos edited with Generative Fill got flagged. IPTC's own testing found Instagram reading DigitalSourceType. Label can be self-applied too. |
| **Google (Photos, Search "About this image", Gemini)** | IPTC DigitalSourceType + Credit "Made with Google AI"; C2PA (Pixel 10 / Photos added Content Credentials in 2025); **SynthID** pixel watermark | SynthID lives in the pixels, so no metadata tool touches it. |
| **LinkedIn** | C2PA only (shows the "CR" badge) | IPTC testing found LinkedIn ignores IPTC DigitalSourceType. |
| **TikTok** | C2PA Content Credentials at upload, auto-labels AI content from other platforms; also attaches its own credentials on export | First platform to auto-label off-platform AI content (2024). |
| **X** | Strips EXIF on the standard photo upload. No public C2PA commitment; "Made with AI" labelling reported inconsistently | Sending as a file attachment reportedly keeps the original bytes. |

**Takeaway:** metadata is the *only* layer most platforms check for third-party content, so a cleaner that misses XMP DigitalSourceType or the C2PA JUMBF box gives a false sense of a clean file. Pixel-domain watermarks (SynthID, Meta's Stable Signature, TikTok's invisible watermark) are a different layer that **no metadata tool removes**. MetaClean says this in the report instead of claiming the image is "undetectable".

### 1.4 Existing tools

| Tool | Strengths | Gaps / user complaints |
|---|---|---|
| **ExifTool** (Phil Harvey) | Gold standard: reads/writes ~everything, lossless, batch, scripting | CLI only, steep syntax (`-all= -tagsfromfile @ -icc_profile`), leaves `_original` files, no plain-language risk report, AI/C2PA signals not summarised; JUMBF removal needs explicit `-jumbf:all=` in older versions. |
| **ExifCleaner** (Electron) | Drag-drop, batch, simple; v4 added preserve-orientation, save-as-copy, folder recursion | Earlier versions dropped rotation; no "what's inside" view before cleaning; no selective keep; partial removal on TIFF/AVIF reported; heavy Electron app; HEIC handling only recently fixed. |
| **ImageOptim** (macOS) | Excellent lossless compression, strips metadata as a side effect | Mac only; not a privacy tool: no report, no verification, strips ICC (colour shifts on P3 photos), cannot keep copyright. |
| **Metapho** (iOS/macOS) | Beautiful viewer, map preview, share-sheet extension | Removal is paywalled; saves a new copy to the library (duplicates); limited batch; little AI/C2PA awareness. |
| **Scrambled Exif** (Android) | Share-sheet "clean then share", zero permissions, open source | No preview of what was removed, JPEG-focused, no presets, no desktop. |
| **Built-in OS options** (iOS "Location: Off", Windows "Remove properties") | Zero install | Location only (iOS) or inconsistent per-format (Windows leaves XMP/IPTC). |

### 1.5 Gaps MetaClean fills

1. **AI / provenance awareness**: detects and removes C2PA/JUMBF (APP11, `caBX`, `C2PA`), DigitalSourceType, generator PNG chunks and CreatorTool, and labels them in plain language.
2. **See before you clean**: grouped report (Location / Device / Personal / AI-Provenance / Technical) with risk badges and before/after diff.
3. **Verification**: every output is re-scanned and the result shown, rather than assumed clean.
4. **Lossless and colour-safe by default**: JPEG/PNG/WebP are rewritten at the container level (pixel data byte-identical), the ICC profile is kept unless "Full wipe" is chosen, and orientation is preserved through a minimal EXIF, with an option to bake the rotation in.
5. **Selective keep plus editing**: presets, per-category and per-field keep, copyright/author re-injection.
6. **Local-only, account-free, cross-platform**: Python core + local web UI on 127.0.0.1; also a CLI, JSON API, and watch folder.

---

## 2. Feature list

### MVP (implemented in this repo)
| # | Feature | Status |
|---|---|---|
| 1 | Drag-drop files / batches / whole folders (web UI) and paths/globs/folders (CLI) | ✅ |
| 2 | "What's in this image?" grouped report with risk badges and AI-signal callouts | ✅ |
| 3 | One-click **Clean everything** + Advanced toggle | ✅ |
| 4 | Selective removal: by category or individual field | ✅ |
| 5 | Presets: Full wipe, Social media share, Keep copyright only, Keep camera info; user presets saved locally | ✅ |
| 6 | Lossless container rewrite for JPEG, PNG, WebP; re-encode with quality control for HEIC/HEIF, AVIF, TIFF; RAW (DNG/CR2/NEF/ARW/ORF/RW2/PEF/RAF) inspected and exported as a clean TIFF/JPEG | ✅ |
| 7 | Orientation: keep the Orientation tag only (lossless) or bake the rotation into the pixels | ✅ |
| 8 | Metadata editing: Artist, Copyright, Description, DateTimeOriginal, plus XMP dc:creator/rights | ✅ |
| 9 | Before/after comparison + post-clean verification re-scan | ✅ |
| 10 | Export report as JSON, CSV, PDF | ✅ |
| 11 | Batch with progress; keep originals (suffix/output folder) or overwrite | ✅ |
| 12 | CLI + local JSON API + watch folder | ✅ |
| 13 | Strip macOS extended attributes (`kMDItemWhereFroms`, quarantine) on output | ✅ |

### Later
* macOS Finder Quick Action / Windows Explorer context-menu installer (CLI already provides the command they would call).
* iOS/Android share-sheet extension (port the container strippers to Swift/Kotlin; the logic is small and dependency-free).
* Video (MP4/MOV `udta`, `©xyz` GPS atoms, C2PA in BMFF).
* PDF / Office docs.
* Map preview for GPS (needs offline tiles to keep the no-network promise).
* Native packaged app (PyInstaller / Tauri shell around the same UI).

---

## 3. Recommended tech stack

| Layer | Choice | Why |
|---|---|---|
| Core engine | **Python 3.11+**, own pure-Python container parsers for JPEG/PNG/WebP/TIFF/ISO-BMFF | Lossless, byte-level control, no ExifTool binary dependency, easy to test. |
| Decoding / re-encoding | **Pillow 13** (JPEG/PNG/WebP/TIFF/AVIF) + **pillow-heif** (HEIC/HEIF) | Mature, wheels for all OSes. |
| UI | **Flask** bound to `127.0.0.1` + one static HTML/JS page (no build step, no CDN, no telemetry) | Everything stays on the machine; works in any browser; easy to wrap in a native shell later. |
| PDF reports | **ReportLab** | Pure Python. |
| Tests | **pytest** with synthetic fixtures generated at test time | No binary blobs in the repo. |
| Optional | ExifTool as a "deep scan" cross-check, if installed | Not required. |

---

## 4. UI flow / wireframes

```
┌──────────────────────────────────────────────────────────────┐
│ MetaClean                     🔒 Local only · nothing uploaded│
├──────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────┐  │
│  │      Drop images or folders here   [Choose files]      │  │   ① DROP
│  └────────────────────────────────────────────────────────┘  │
├───────────────┬──────────────────────────────────────────────┤
│ Files (12)    │  IMG_2041.jpg   4032×3024 · JPEG · 3.1 MB      │
│ ● IMG_2041 HI │  ┌─ What's in this image? ──────────────────┐  │   ② INSPECT
│ ● gen_01  AI  │  │ 📍 Location     HIGH  GPS 51.50, -0.12     │  │
│ ● scan.tif LO │  │ 📷 Device       MED   iPhone 15 Pro · S/N  │  │
│               │  │ 👤 Personal     MED   Artist, Copyright    │  │
│               │  │ 🤖 AI/Provenance HIGH C2PA · trainedAlgo.. │  │
│               │  │ ⚙︎ Technical    LOW   Orientation, ICC     │  │
│               │  └──────────────────────────────────────────┘  │
│               │  [ Clean everything ]   ☐ Advanced options     │   ③ CLEAN
│               │   └ preset ▾ · keep categories · per-field ☐   │
│               │     orientation ◉ keep tag ○ bake · quality ▭ │
│               │     edit: author / copyright / date            │
│               ├──────────────────────────────────────────────┤
│               │  Before │ After   ✅ Verified: 0 risky fields  │   ④ COMPARE
│               │  [Download] [Download all .zip] [Share]       │   ⑤ SAVE/SHARE
│               │  [Report: JSON · CSV · PDF]                    │
└───────────────┴──────────────────────────────────────────────┘
```

Flow: **Drop → Inspect (auto) → Clean (one button, or Advanced) → Verify + compare (auto) → Save / Share / Export report.**

## 5. Sources
- IPTC: [AI disclosure on social media — a work in progress](https://iptc.org/news/ai-disclosure-on-social-media-a-work-in-progress/), [Google AI transparency based on IPTC standards](https://iptc.org/news/google-ai-transparency-based-on-iptc-standards/)
- [The Decoder — Meta "Imagined with AI" labels](https://the-decoder.com/meta-introduces-imagined-with-ai-labels-for-ai-generated-content-on-its-social-media-platforms/)
- [Google blog — gen-AI transparency with C2PA](https://blog.google/innovation-and-ai/products/google-gen-ai-content-transparency-c2pa/), [Google Photos help — information stored on your photos](https://support.google.com/photos/answer/15532903), [9to5Google — Photos AI edit info](https://9to5google.com/2024/10/24/google-photos-ai-edit-info/)
- [MediaPost — LinkedIn begins labelling AI content](https://www.mediapost.com/publications/article/396225/linkedin-begins-labeling-ai-generated-content.html), [Maginative — TikTok partners with C2PA](https://www.maginative.com/article/tiktok-partners-with-c2pa-to-label-ai-generated-content-and-promote-media-literacy/)
- [Tim Bray — C2PA investigations](https://www.tbray.org/ongoing/When/202x/2025/09/18/C2PA-Investigations), [roboin.io — X "Made with AI" label testing](https://roboin.io/article/en/2026/03/24/why-x-tags-posts-as-made-with-ai-and-how-to-remove-it-testing-the-conditions/)
- [ExifCleaner GitHub](https://github.com/szTheory/exifcleaner) and [wiki](https://github.com/szTheory/exifcleaner/wiki), [ExifTool forum — rotation issue](https://exiftool.org/forum/index.php?msg=91557)
