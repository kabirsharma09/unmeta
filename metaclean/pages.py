"""Landing pages and guides. Each page targets one search intent, opens with a direct answer (for people and for
AI answer engines), keeps the working tool at the top, and is honest about what UnMeta can't do.

Every page is rendered from static/index.html by server.render_page(): the hero headline and lead, the body sections,
the FAQ and the structured data all come from here, so the visible FAQ and the FAQPage schema can never drift apart.
"""
from __future__ import annotations

UPDATED = "2026-11-17"
PUBLISHED = "2026-11-17"   # when the site launched; guides carry it as datePublished

# The short promise repeated on every page, so each one can be read on its own.
PROMISE = ("UnMeta works inside your browser: the file is never uploaded, the page is blocked from sending anything, "
           "and the picture or sound itself is never re-encoded.")


def ul(*items: str) -> str:
    return "<ul>" + "".join(f"<li>{i}</li>" for i in items) + "</ul>"


def sec(title: str, html: str, sid: str = "") -> str:
    """One section: headline beside the text on wide screens. Lists get ticks under "what it removes" and crosses
    under "what it can't do"; a paragraph that starts "Short answer:" is set as the answer card."""
    ident = f' id="{sid}"' if sid else ""
    plain = title.lower()
    cant = ("can’t", "can't", "doesn’t", "won’t", "limits",                    # English
            "no puede", "não pode", "nicht kann", "kann nicht", "kann es nicht", "grenzen",  # es, pt, de
            "ne peut pas", "ne peut", "limites", "नहीं कर")                            # fr, hi
    kind = " cant" if any(w in plain for w in cant) else (
        " ok" if plain.startswith(("what unmeta removes", "what it removes", "what gets removed", "what unmeta finds")) else "")
    html = html.replace("<p><strong>Short answer:</strong>", '<p class="answer"><strong>Short answer:</strong>')
    return (f'<section class="sec"{ident}><div class="split"><h2 class="headline reveal">{title}</h2>'
            f'<div class="prose{kind} reveal">{html}</div></div></section>')


def table(head: list[str], rows: list[list[str]]) -> str:
    th = "".join(f'<th scope="col">{h}</th>' for h in head)
    body = "".join("<tr>" + "".join((f'<th scope="row">{c}</th>' if i == 0 else f"<td>{c}</td>") for i, c in enumerate(r)) + "</tr>"
                   for r in rows)
    return f'<div class="table-wrap" role="region" aria-label="{head[0]} table" tabindex="0"><table class="facts-table"><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table></div>'


PAGES: list[dict] = [
    {
        "slug": "remove-metadata-from-photos",
        "nav": "Remove metadata from photos",
        "title": "Remove Metadata from Photos Online, Free and No Upload | UnMeta",
        "description": "Remove EXIF, GPS location, camera details and AI labels from JPEG, HEIC, PNG and RAW photos in your browser. Nothing uploaded, no sign-up, no quality loss.",
        "h1": "Remove <mark class=\"swipe\">metadata</mark> from photos, without uploading them",
        "lead": "Pick a photo and UnMeta lists what it gives away: where it was taken, the phone and its serial number, your name, the date and any AI label. Then it removes those details in your browser and leaves the picture exactly as it was.",
        "body": [
            sec("What a photo’s metadata says about you",
                "<p><strong>Short answer:</strong> photo metadata is information your phone or camera saves inside the file, next to "
                "the picture. It travels with the photo whenever the file itself is shared, and it can include:</p>"
                + ul("<strong>Location:</strong> GPS coordinates, often accurate to a few metres, plus altitude and direction",
                     "<strong>Device:</strong> phone or camera model, lens, and serial numbers that link every photo from one device",
                     "<strong>Identity and time:</strong> your name, the device’s name, the date, time and time zone",
                     "<strong>AI labels:</strong> C2PA Content Credentials, IPTC Digital Source Type and AI prompts",
                     "<strong>Hidden copies:</strong> thumbnails and motion-photo video that can show what you cropped out")),
            sec("What UnMeta removes",
                ul("EXIF, XMP and IPTC details, including GPS location, maker notes and serial numbers",
                   "C2PA Content Credentials and AI generator prompts saved by Stable Diffusion and ComfyUI",
                   "Embedded thumbnails, previews and the video part of Live and Motion Photos",
                   "Comments and text chunks that apps leave behind")
                + "<p>Colours and rotation stay, so the photo looks the same everywhere. You can also keep your name and copyright, "
                  "or remove only the location.</p>" + f"<p>{PROMISE}</p>"),
            sec("Formats",
                table(["Kind", "Formats", "Stays as"], [
                    ["Phone photos", "HEIC, HEIF, JPEG", "The same format: HEIC stays HEIC"],
                    ["Web images", "PNG, WebP, AVIF", "The same format"],
                    ["Camera RAW", "DNG, CR2, CR3, NEF, ARW, ORF, RW2, RAF, PEF, SRW", "The same file, edited in place"],
                    ["Scans and print", "TIFF", "The same file"],
                ])),
            sec("What it can’t do",
                ul("It can’t remove what’s visible in the picture: faces, street signs, screens, reflections.",
                   "It can’t remove invisible watermarks woven into the pixels, such as Google SynthID.",
                   "It can’t clean a copy you already shared. Share the clean copy instead.")),
        ],
        "steps": [("Choose photos", "Pick photos from your phone or computer, or drop a whole folder."),
                  ("See what they reveal", "Each photo lists its location, device, name, dates and AI labels in plain words."),
                  ("Clean and download", "Press Clean. Each copy is read again to check nothing private stayed, then you download it.")],
        "faq": [
            ("How do I remove metadata from a photo for free?",
             "Open UnMeta, choose the photo and press Clean. It runs in your browser, so it’s free with no sign-up, and the photo is never uploaded."),
            ("Does removing metadata reduce photo quality?",
             "No. UnMeta never re-saves the picture. It removes the details around it and checks the picture data is byte-for-byte identical before you download."),
            ("Can I remove metadata from many photos at once?",
             "Yes. Choose or drop as many photos as you like, or a whole folder, and download them all as one zip. There’s no daily limit."),
            ("Does it work on iPhone and Android?",
             "Yes. UnMeta works in Safari, Chrome and other modern browsers on phones, tablets and computers. On iPhone, HEIC photos stay HEIC."),
        ],
        "related": ["remove-location-from-photos", "exif-remover", "check-photo-metadata"],
    },
    {
        "slug": "remove-ai-info-instagram",
        "nav": "Instagram “AI info”",
        "title": "Remove the Data Behind Instagram’s “AI info” Label | UnMeta",
        "description": "Real photo labelled “AI info” on Instagram? It’s usually hidden Content Credentials or IPTC data from an editing app. See it and remove it in your browser, losslessly.",
        "h1": "Remove the data behind Instagram’s <mark class=\"swipe\">AI info</mark> label",
        "lead": "Instagram adds “AI info” when a photo’s hidden details say an AI tool touched it, even a one-click clean-up in Photoshop or Magic Editor. UnMeta shows those details and removes them before you post, without changing a pixel.",
        "body": [
            sec("Why a real photo gets labelled",
                "<p><strong>Short answer:</strong> Instagram and Facebook read two kinds of hidden labels inside the file: "
                "<strong>C2PA Content Credentials</strong> and the <strong>IPTC Digital Source Type</strong>. Editing apps write them "
                "whenever a generative tool is used, however small the edit.</p>"
                + ul("Adobe Photoshop and Lightroom: Generative Fill, Generative Expand, the Remove tool",
                     "Google Photos and Pixel: Magic Editor, Best Take, Reimagine",
                     "Samsung Galaxy AI photo edits",
                     "Image generators such as ChatGPT, DALL·E, Adobe Firefly and Midjourney")
                + "<p>Meta renamed its “Made with AI” label to “AI info” in 2024 after photographers complained about real photos "
                  "being flagged, but it still reads the same hidden data.</p>"),
            sec("What UnMeta removes",
                ul("C2PA Content Credentials (the signed record of which tools were used)",
                   "IPTC Digital Source Type, such as <code>compositeWithTrainedAlgorithmicMedia</code>",
                   "Editing history and “creator tool” fields in XMP",
                   "AI prompts and settings saved by Stable Diffusion, ComfyUI and similar tools",
                   "Everything else private while it’s there: location, phone model, serial numbers, your name")
                + f"<p>{PROMISE}</p>"),
            sec("What it can’t do",
                ul("It can’t remove invisible watermarks woven into the pixels, such as Google SynthID or Meta’s own watermark on Meta AI images.",
                   "It can’t stop Instagram labelling a post through its own detection, or when you tick the AI label yourself.",
                   "It can’t change a post that’s already published. Delete it and post the clean copy instead.")
                + "<p><strong>If an image really was made or substantially changed with AI, disclose it.</strong> Meta asks you to label "
                  "photorealistic AI content, and some laws require it. UnMeta is for photos that are yours and real, or for keeping "
                  "your location and device private.</p>"),
        ],
        "steps": [("Choose the photo", "Open UnMeta and pick the photo you want to post."),
                  ("See the AI label", "The “AI label” line shows what the hidden data says, such as “Edited with AI”."),
                  ("Clean it", "Keep “Nothing private” and press Clean. The copy is checked again afterwards."),
                  ("Post the clean copy", "Upload the downloaded copy to Instagram, not the original.")],
        "faq": [
            ("Will this stop Instagram showing “AI info”?",
             "If the label came from the photo’s hidden details, removing them leaves Instagram nothing to read. Instagram can still add the label through its own detection, through invisible watermarks, or if you choose to label the post yourself."),
            ("Why does Instagram say “AI info” on a photo I took?",
             "Usually because an editing app wrote Content Credentials or an IPTC Digital Source Type into the file after you used a generative tool, such as Photoshop’s Remove tool or Google’s Magic Editor, even for a small fix."),
            ("Is it allowed to remove the AI label data?",
             "Removing hidden details from your own photos is allowed. Meta’s rules still ask you to disclose photorealistic content made or significantly altered with AI, so only remove the label from photos that are genuinely real."),
            ("Can I remove “AI info” from a post that’s already up?",
             "No. The label is decided when the post is uploaded. Delete the post, clean the original photo with UnMeta, and post the clean copy."),
        ],
        "related": ["remove-ai-label", "remove-content-credentials", "check-photo-metadata"],
    },
    {
        "slug": "remove-ai-label",
        "nav": "AI labels on Facebook, TikTok, LinkedIn",
        "title": "Remove AI Label Data for Facebook, Threads, TikTok, LinkedIn | UnMeta",
        "description": "Which platforms read AI labels from your files, and how to see and remove that hidden data before you post. Free, lossless, in your browser.",
        "h1": "See and remove the <mark class=\"swipe\">AI label</mark> data platforms read",
        "lead": "Facebook, Threads, Instagram, TikTok, LinkedIn, Pinterest and YouTube read hidden labels inside photos and videos to decide whether to show an AI badge. UnMeta shows you what your file says and removes it, losslessly.",
        "body": [
            sec("Which platforms read what",
                "<p>Platforms mainly read two industry standards: <strong>C2PA Content Credentials</strong> and the "
                "<strong>IPTC Digital Source Type</strong>. What they show differs:</p>"
                + table(["Platform", "Reads", "What people may see"], [
                    ["Facebook, Instagram, Threads", "C2PA, IPTC", "“AI info”"],
                    ["TikTok", "C2PA", "“AI-generated” label"],
                    ["LinkedIn", "C2PA", "A “CR” Content Credentials icon with the editing history"],
                    ["Pinterest", "IPTC, C2PA", "“AI modified” label"],
                    ["YouTube", "C2PA", "“Captured with a camera” for verified real footage"],
                ])
                + "<p>Platforms change these rules often, and most also run their own detection. Treat the table as how they "
                  "worked at the time of writing.</p>"),
            sec("What UnMeta removes, and what stays",
                ul("Removed: Content Credentials (C2PA), IPTC Digital Source Type, XMP editing history, AI prompts and settings.",
                   "Removed too, unless you choose to keep them: location, phone or camera model, serial numbers, names and dates.",
                   "Never removed: anything visible or audible, and invisible watermarks such as Google SynthID.")
                + "<p>Want to keep your location private but your Content Credentials intact? Choose “Everything except AI labels” "
                  "to keep the labels and remove the rest, or “Everything except location” for the opposite.</p>"
                + f"<p>{PROMISE}</p>"),
        ],
        "faq": [
            ("Does removing metadata remove the AI label on TikTok or LinkedIn?",
             "If the label comes from Content Credentials or IPTC data inside the file, removing that data means there is nothing to read. Platforms can still label content through their own detection, invisible watermarks, or your own disclosure."),
            ("Do videos carry AI labels too?",
             "Yes. Video generators and editors can add Content Credentials to MP4 and MOV files. UnMeta removes them from videos up to 4 GB without re-encoding."),
            ("Should I disclose AI content anyway?",
             "Yes, when it’s really made or significantly altered with AI. Most platforms require it for realistic content, and some laws do too. Removing data doesn’t change how something was made."),
        ],
        "related": ["remove-ai-info-instagram", "remove-content-credentials", "remove-metadata-from-video"],
    },
    {
        "slug": "remove-location-from-photos",
        "nav": "Remove location from photos",
        "title": "Remove Location (GPS) from Photos on iPhone, Android or PC | UnMeta",
        "description": "Photos can carry the exact spot where they were taken. See the location in your photo and remove it, free and in your browser, without losing quality.",
        "h1": "Remove the <mark class=\"swipe\">location</mark> from your photos",
        "lead": "Phones save the exact spot, often to within a few metres, inside every photo. UnMeta shows you the location and removes it, along with the phone model and your name, without changing the picture.",
        "body": [
            sec("When your location travels with a photo",
                "<p><strong>Short answer:</strong> most social apps hide the location from other people, but the original file "
                "keeps it. It goes along whenever you share the file itself:</p>"
                + ul("sending a photo as a file or document (WhatsApp, Telegram, Slack, Teams)",
                     "email attachments, AirDrop, Bluetooth and USB transfers",
                     "cloud links (Google Drive, Dropbox, iCloud links)",
                     "marketplaces, forums and websites that keep the original file")
                + "<p>Location can also live in more than one place inside the file, such as EXIF GPS and XMP. "
                  "UnMeta finds and removes every copy it can read, then reads the clean copy again to check.</p>"),
            sec("iPhone and Android: what the built-in options do",
                ul("iPhone: Share → Options → turn off Location. This affects only that share; the photo in your library keeps its location.",
                   "Android (Google Photos): you can remove the estimated location, and the camera app has a setting to stop saving location.",
                   "Neither cleans a file you already sent, or removes the phone model, serial numbers or AI labels.")
                + f"<p>{PROMISE}</p>"),
        ],
        "steps": [("Choose photos", "Pick one or many photos, or a whole folder."),
                  ("Check the location", "The “Where it was taken” line shows the coordinates found."),
                  ("Clean and download", "Press Clean, then download the clean copies and share those.")],
        "faq": [
            ("Does Instagram or Facebook remove location from photos?",
             "They hide it from other people, but they receive your original file with its location first. Removing it yourself means it never leaves your device."),
            ("Does WhatsApp remove location from photos?",
             "Photos sent the normal way are compressed and lose most hidden details. Photos sent as a document are sent as the original file, location included."),
            ("Will removing the location lower the quality?",
             "No. UnMeta removes the hidden details around the picture and never re-saves the picture itself. It checks that the picture data is identical before you download."),
        ],
        "related": ["check-photo-metadata", "exif-remover", "guides/whatsapp-photo-location"],
    },
    {
        "slug": "exif-remover",
        "nav": "EXIF remover",
        "title": "EXIF Remover Online: No Upload, No Quality Loss | UnMeta",
        "description": "Remove EXIF, XMP, IPTC and GPS data from JPEG, PNG, WebP, HEIC, AVIF, TIFF and RAW files in your browser. Lossless: the picture is never re-encoded.",
        "h1": "An <mark class=\"swipe\">EXIF remover</mark> that never re-saves your photo",
        "lead": "Many online EXIF removers re-encode the picture or convert it to JPEG to strip the data. UnMeta removes EXIF, XMP, IPTC and GPS by editing only the details around the picture, then proves the picture data is identical.",
        "body": [
            sec("Lossless, format by format",
                table(["Format", "How UnMeta cleans it", "Picture data"], [
                    ["JPEG", "Rebuilds the header segments; copies the compressed image as is", "Byte-for-byte identical"],
                    ["PNG", "Rebuilds the chunk list; copies IDAT as is", "Byte-for-byte identical"],
                    ["WebP", "Rebuilds the RIFF chunks; copies VP8/VP8L as is", "Byte-for-byte identical"],
                    ["HEIC, HEIF, AVIF", "Blanks metadata items in place; stays HEIC/AVIF", "Byte-for-byte identical"],
                    ["TIFF, DNG, CR2, CR3, NEF, ARW, ORF, RW2, RAF", "Blanks metadata fields in place", "Byte-for-byte identical"],
                ])
                + "<p>Colour profile and rotation are kept by default, so the photo looks the same everywhere.</p>"),
            sec("What counts as EXIF, and what else it removes",
                ul("EXIF: camera and phone model, lens, serial numbers, date and time, GPS location, maker notes, thumbnails",
                   "XMP: editing history, creator tool, ratings, AI labels",
                   "IPTC: author, copyright, captions, keywords, Digital Source Type",
                   "C2PA Content Credentials, JPEG comments, PNG text chunks with AI prompts, embedded previews and motion-photo video")
                + "<p>Choose what to keep: your name and copyright, camera settings, or everything except location.</p>"),
        ],
        "faq": [
            ("Does removing EXIF data reduce image quality?",
             "Not with UnMeta. It never decodes or re-encodes the picture. It compares the picture data before and after, and only offers the download when they match."),
            ("Can I keep my copyright but remove GPS?",
             "Yes. Choose “My name and copyright” to keep your credit and remove everything else, or “Everything except location” to remove only the location."),
            ("Is there a command-line version?",
             "Yes. UnMeta also comes as a command-line tool for cleaning folders and for scripts, using the same lossless method."),
        ],
        "related": ["remove-location-from-photos", "heic-metadata", "check-photo-metadata"],
    },
    {
        "slug": "remove-metadata-from-video",
        "nav": "Remove metadata from videos",
        "title": "Remove Metadata from Videos (MP4, MOV) up to 4 GB | UnMeta",
        "description": "Remove location, phone model, recording date and AI labels from MP4 and MOV videos without re-encoding. Files up to 4 GB, processed in your browser.",
        "h1": "Remove metadata from <mark class=\"swipe\">videos</mark>, without re-encoding",
        "lead": "Phone videos store where they were recorded, the phone model and the exact time. UnMeta removes them from MP4 and MOV files up to 4 GB. Every frame is copied as is, and the file keeps its exact size.",
        "body": [
            sec("What a phone video carries",
                ul("iPhone: location (ISO 6709), make and model, iOS version, creation date, and a link to its Live Photo",
                   "Android: location in the movie header, recording date, sometimes the device model",
                   "Action cameras: GoPro and DJI serial numbers and firmware in vendor blocks",
                   "Editors and AI video tools: XMP editing history and C2PA Content Credentials")),
            sec("How it stays lossless, even for big files",
                "<p>UnMeta reads only the small metadata blocks of the file, in slices, and never loads the whole video. "
                "It blanks the details in place, so every byte offset stays valid, and stitches the clean copy from the untouched "
                "frames of the original. The result plays exactly as before and has the same size.</p>"
                + ul("Formats: MP4, MOV, M4V, 3GP; audio in M4A, MP3 and WAV", "Size: up to 4 GB per video",
                     "Checked: the clean copy is read again, and also searched for any text that was removed")
                + f"<p>{PROMISE}</p>"),
        ],
        "faq": [
            ("Does removing video metadata re-encode the video?",
             "No. UnMeta changes only the metadata blocks and copies the video and sound data exactly. The clean MP4 or MOV has the same size as the original."),
            ("Do iPhone videos contain location?",
             "Yes, when Location Services are on for the Camera. iPhone videos store the location in Apple’s metadata keys, along with the phone model and the creation date."),
            ("How big a video can I clean?",
             "Up to 4 GB per file. Videos are read in slices, so even large files don’t need to fit in memory."),
        ],
        "related": ["remove-location-from-photos", "remove-ai-label", "check-photo-metadata"],
    },
    {
        "slug": "remove-metadata-from-audio",
        "nav": "Remove metadata from audio",
        "title": "Remove Metadata from MP3, M4A Voice Memos and WAV Files | UnMeta",
        "description": "Remove ID3 tags, recording location, device and names from MP3, M4A voice memos and WAV files in your browser. The sound is never re-encoded.",
        "h1": "Remove <mark class=\"swipe\">metadata</mark> from audio and voice memos",
        "lead": "Voice memos can carry where they were recorded and the phone that made them. Music and podcast files carry names, comments and software tags. UnMeta removes them in your browser and copies the sound exactly.",
        "body": [
            sec("What an audio file can carry",
                "<p><strong>Short answer:</strong> iPhone voice memos (M4A) can save the recording location and device. MP3 files "
                "keep ID3 tags, and some also have APE tags or a second ID3 tag at the end. WAV files can hold INFO lists and notes "
                "written by recorders and editors.</p>"
                + table(["Format", "Where the details live", "What UnMeta does"], [
                    ["M4A, voice memos", "MP4 boxes: location, device, dates, names", "Removes the boxes, copies the sound as is"],
                    ["MP3", "ID3v1, ID3v2 (all of them), APEv2, Lyrics3", "Removes every tag, copies the audio frames as is"],
                    ["WAV", "INFO and label lists, iXML, bext", "Removes the lists, copies the samples as is"],
                ])),
            sec("What UnMeta removes",
                ul("Recording location and the phone or recorder model",
                   "Names: artist, author, encoded by, comments, and the device’s name",
                   "Dates, software tags and AI labels from voice and music generators",
                   "Cover pictures, which can be personal photos")
                + f"<p>{PROMISE}</p>"),
            sec("What it can’t do",
                ul("It can’t change what’s audible: voices, names said aloud, background sounds.",
                   "It can’t remove audio watermarks woven into the sound itself.")),
        ],
        "steps": [("Choose recordings", "Pick MP3, M4A or WAV files, up to 4 GB each."),
                  ("See what they reveal", "Each recording lists its location, device, names and tags."),
                  ("Clean and download", "Press Clean. The sound is copied exactly; only the details around it change.")],
        "faq": [
            ("Do iPhone voice memos contain location?",
             "They can. Voice Memos can save where a recording was made, and the file also records the device and date. UnMeta shows and removes them."),
            ("How do I remove ID3 tags from an MP3?",
             "Choose the MP3 in UnMeta and press Clean. It removes every ID3 tag, including ones at the end of the file and APE tags, without re-encoding the audio."),
            ("Will removing metadata change the sound?",
             "No. UnMeta copies the audio data byte for byte. Only the tags and boxes around it are removed."),
        ],
        "related": ["remove-metadata-from-video", "remove-metadata-from-photos", "check-photo-metadata"],
    },
    {
        "slug": "heic-metadata",
        "nav": "HEIC metadata",
        "title": "Remove HEIC Metadata Without Converting to JPEG | UnMeta",
        "description": "Remove location and camera data from iPhone HEIC photos and keep them as HEIC: no conversion, no quality loss. In your browser.",
        "h1": "Clean <mark class=\"swipe\">HEIC</mark> photos and keep them HEIC",
        "lead": "iPhones save photos as HEIC. Many tools convert them to JPEG to remove the hidden details, which loses quality and doubles the size. UnMeta removes the details in place and the photo stays HEIC, byte for byte.",
        "body": [
            sec("Why converting is the wrong fix",
                ul("Converting to JPEG re-compresses the picture and can lose detail and colour depth.",
                   "The JPEG is usually larger, and HDR and depth information can be lost.",
                   "UnMeta blanks the location, phone model, serial numbers and names inside the HEIC file and leaves every picture tile untouched.")
                + "<p>HEIC previews: most browsers can’t display HEIC, so UnMeta shows the photo’s own built-in thumbnail instead. Safari shows HEIC directly.</p>"
                + f"<p>{PROMISE}</p>"),
        ],
        "faq": [
            ("Can I remove metadata from HEIC without converting it?",
             "Yes. UnMeta edits the metadata items inside the HEIC file in place, so the photo stays HEIC and the picture data is identical."),
            ("Does iPhone HEIC contain location?",
             "Yes, when the Camera has location access. It also stores the phone model, lens, date and time, and sometimes a depth map."),
        ],
        "related": ["exif-remover", "remove-location-from-photos", "check-photo-metadata"],
    },
    {
        "slug": "remove-content-credentials",
        "nav": "C2PA Content Credentials",
        "title": "Remove C2PA Content Credentials from Images and Videos | UnMeta",
        "description": "What C2PA Content Credentials are, which apps add them, when to keep them, and how to remove them from photos and videos in your browser.",
        "h1": "Remove <mark class=\"swipe\">Content Credentials</mark> (C2PA)",
        "lead": "Content Credentials are a signed record inside a file saying how it was made and edited. They’re useful for proving where an image came from, and they’re also what platforms read to show AI labels. UnMeta shows them and lets you remove or keep them.",
        "body": [
            sec("What’s inside a Content Credential",
                ul("The app that made or edited the file (“claim generator”), such as Photoshop, Firefly, ChatGPT or a camera",
                   "Actions taken, such as “generative fill” or “edited”",
                   "Ingredients: earlier versions of the image the edit was based on",
                   "A cryptographic signature. Any later edit to the file breaks it.")),
            sec("When to keep them",
                "<p>Photojournalists and brands may want to keep Content Credentials to prove an image is authentic. "
                "Choose “Everything except AI labels” to keep them while removing your location and other private details.</p>"
                + f"<p>{PROMISE}</p>"),
        ],
        "faq": [
            ("What is C2PA?",
             "C2PA (Coalition for Content Provenance and Authenticity) is an open standard for Content Credentials: a signed record, stored inside a file, of how it was created and edited."),
            ("Does removing C2PA change the picture?",
             "No. Content Credentials are stored next to the picture. UnMeta removes them without re-encoding anything."),
            ("Will a kept Content Credential still verify?",
             "Only if nothing else in the file changes. Removing any other detail invalidates the signature, and UnMeta tells you so."),
        ],
        "related": ["remove-ai-info-instagram", "remove-ai-label", "exif-remover"],
    },
    {
        "slug": "check-photo-metadata",
        "nav": "See what a photo reveals",
        "title": "Photo Metadata Viewer: See What Your Photo Reveals | UnMeta",
        "description": "Check a photo or video for hidden location, phone model, serial numbers, names, dates and AI labels, in plain words. Free, private and in your browser.",
        "h1": "See what your photo <mark class=\"swipe\">reveals</mark>",
        "lead": "Drop a photo or video to see the hidden details it carries, explained in plain words: where it was taken, what took it, who and when, AI labels and hidden copies. Nothing is uploaded, and you don’t have to clean anything.",
        "body": [
            sec("Plain words first, every detail if you want it",
                "<p>UnMeta lists only what matters, most sensitive first. Open a line to see why it matters, or choose "
                "“Show every detail” for the full technical list, the same detail a forensics tool shows. "
                "You can also download a report as CSV or JSON.</p>"
                + f"<p>{PROMISE}</p>"),
        ],
        "faq": [
            ("How do I check if a photo has location data?",
             "Drop it into UnMeta. If it has a location, the first line, “Where it was taken”, shows the coordinates. You can then remove it or leave the photo as it is."),
            ("Can I see metadata without changing the photo?",
             "Yes. Viewing never changes the file. Nothing happens to it unless you press Clean, and even then you get a copy and your original stays as it is."),
        ],
        "related": ["remove-location-from-photos", "exif-remover", "remove-ai-info-instagram"],
    },
    {
        "slug": "documents",
        "nav": "Clean a document",
        "title": "Remove Metadata from PDF, Word, Excel and PowerPoint | UnMeta",
        "description": "See and remove the author, company, template path, editing time and hidden preview from PDF, Word, Excel and PowerPoint files. Comments stay. In your browser.",
        "h1": "Clean a document <mark class=\"swipe\">before</mark> you send it",
        "lead": "Documents carry more than their text: who wrote and last edited them, your company, the folder of the template you used, how long you spent on it, and a preview of the first page. UnMeta removes those and leaves everything you can read exactly as it is.",
        "body": [
            sec("What a document reveals",
                table(["Detail", "Where it hides", "Removed?"], [
                    ["Author and last edited by", "Word, Excel, PowerPoint properties; PDF Info and XMP", "Yes"],
                    ["Company and manager", "Office app properties", "Yes"],
                    ["Template path, e.g. <code>C:\\Users\\jane\\…</code>", "Office app properties", "Yes"],
                    ["Total editing time, dates, last printed", "Office and PDF properties", "Yes"],
                    ["The app that made it", "Office and PDF properties", "Yes"],
                    ["Hidden first-page preview", "Office thumbnail", "Yes"],
                    ["Location and camera in pictures inside", "Each embedded photo", "Yes, losslessly"],
                    ["Comments and tracked changes", "The document itself", "No, shown so you can decide"],
                    ["Earlier saved versions", "Inside the PDF", "No, shown so you can decide"],
                ])),
            sec("Comments and tracked changes stay",
                "<p>Comments, tracked changes, annotations and earlier versions are part of what you wrote, so UnMeta never changes them. "
                "It shows you how many there are and who made them. If you don’t want to share them, accept or delete them in Word, "
                "Excel, PowerPoint or your PDF app first.</p>"
                "<p>Everything you can read is byte-for-byte identical after cleaning: Office files keep every untouched part exactly as it was, "
                "and PDFs are cleaned in place, so the file keeps the same size and structure.</p>"
                f"<p>{PROMISE.replace('the picture or sound itself is never re-encoded', 'what you wrote is never changed')}</p>"),
            sec("What it can’t clean, and says so",
                ul("Password-protected PDFs and Office files: unlock them first.",
                   "PDF details stored in compressed blocks: UnMeta shows them and tells you it couldn’t remove them.",
                   "Anything written in the text itself, such as a name in a header or footer.")),
        ],
        "steps": [("Choose the document", "PDF, Word, Excel or PowerPoint, up to 200 MB."),
                  ("See what it reveals", "Author, company, template path, editing time, and the comments that will stay."),
                  ("Clean and send the copy", "Press Clean and send the downloaded copy. Your original is untouched.")],
        "faq": [
            ("How do I remove the author name from a Word document?",
             "Drop the .docx into UnMeta and press Clean. It removes the author, last edited by, company, manager and template path from the file’s properties, and keeps the text, comments and tracked changes exactly as they are."),
            ("Does UnMeta remove comments and tracked changes?",
             "No. They are part of what you wrote, so UnMeta shows how many there are and who made them, and leaves them alone. Delete or accept them in your editor if you don’t want to share them."),
            ("Can I remove metadata from a PDF without changing it?",
             "Yes. UnMeta overwrites the author, creator and date fields in place, so the PDF keeps its size, layout and text, and it reads the clean copy again to check."),
            ("Does it clean pictures inside a document?",
             "Yes. Photos inside Word, Excel and PowerPoint files are checked for location and camera details and cleaned losslessly."),
        ],
        "related": ["remove-metadata-from-pdf", "remove-author-from-word", "check-photo-metadata"],
    },
    {
        "slug": "remove-metadata-from-pdf",
        "nav": "PDF metadata",
        "title": "Remove Metadata from a PDF: Author, Creator, Dates | UnMeta",
        "description": "Remove the author, creator app, producer, dates and XMP from a PDF in your browser. The PDF keeps its exact size and layout. Comments and versions are shown, not changed.",
        "h1": "Remove <mark class=\"swipe\">metadata</mark> from a PDF",
        "lead": "A PDF records who wrote it, the app that made it, when it was created and changed, and often an XMP block with the same details again. UnMeta removes them in place, so the PDF keeps its exact size, layout and text.",
        "body": [
            sec("What a PDF carries",
                ul("Info dictionary: Author, Creator, Producer, Title, Subject, Keywords, creation and modification dates",
                   "XMP metadata: often the same details again, plus document IDs and editing history",
                   "Earlier versions: PDFs saved with incremental updates keep previous versions inside the file",
                   "Annotations, form data and attachments, which can include names")
                + "<p>UnMeta removes the Info and XMP details from every version inside the file. It shows earlier versions, comments, "
                  "form data and attachments, and doesn’t change them, because they’re part of the document.</p>"),
        ],
        "faq": [
            ("How do I see a PDF’s metadata?",
             "Drop it into UnMeta. It lists the author, creator app, dates and anything else stored, in plain words, without changing the file."),
            ("Does removing PDF metadata change the document?",
             "No. UnMeta blanks the details in place, so every page, link and comment stays exactly where it was, and the file keeps the same size."),
            ("What if my PDF is password-protected?",
             "UnMeta can’t clean encrypted PDFs and will tell you so. Remove the password in your PDF app first, then clean it."),
        ],
        "related": ["documents", "remove-author-from-word", "remove-content-credentials"],
    },
    {
        "slug": "remove-author-from-word",
        "nav": "Word, Excel, PowerPoint author",
        "title": "Remove Author and Company from Word, Excel, PowerPoint | UnMeta",
        "description": "Remove the author, last edited by, company, manager, template path and editing time from .docx, .xlsx and .pptx files, without opening Office. Free, in your browser.",
        "h1": "Remove the <mark class=\"swipe\">author</mark> from Word, Excel and PowerPoint",
        "lead": "Office files remember who created and last saved them, your company, the template folder (which often contains your username) and how many minutes you spent editing. UnMeta removes them without opening Office, and leaves the content untouched.",
        "body": [
            sec("Beyond File → Info → Remove personal information",
                "<p>Office’s own Document Inspector works one file at a time, and it’s easy to remove comments and tracked changes along with the properties. "
                "UnMeta works in any browser, on many files at once, removes only the hidden properties and a hidden preview image, "
                "and cleans photos inside the document too.</p>"
                + ul("Removed: author, last edited by, company, manager, template path, hyperlink base, total editing time, dates, custom properties, hidden preview",
                     "Kept as they are: text, layout, comments, tracked changes, macros",
                     f"{PROMISE}")),
        ],
        "faq": [
            ("How do I remove my name from a PowerPoint file?",
             "Drop the .pptx into UnMeta and press Clean. Your name is removed from the author and last edited by properties; slides, notes and comments stay as they are."),
            ("Why does my Word file show a different company name?",
             "Office stores the company from your computer or organisation’s settings in every file you save. UnMeta shows it and removes it."),
        ],
        "related": ["documents", "remove-metadata-from-pdf", "exif-remover"],
    },
    {
        "slug": "guides/does-instagram-remove-metadata",
        "kind": "guide",
        "nav": "Does Instagram remove metadata?",
        "title": "Does Instagram Remove Metadata? What It Keeps and What It Reads | UnMeta",
        "description": "Instagram removes location and camera data from the copies other people see, but it receives your original file first, and reads AI labels before removing them.",
        "h1": "Does Instagram remove <mark class=\"swipe\">metadata</mark>?",
        "lead": "Yes and no. Instagram removes EXIF, including location, from the copies other people can download. But it receives your original file with everything in it first, and it reads AI labels from it to decide whether to show “AI info”.",
        "body": [
            sec("What happens to your photo’s details on Instagram",
                table(["Detail", "Shown to others?", "Received by Instagram?"], [
                    ["GPS location", "No", "Yes, in the uploaded original"],
                    ["Phone model and serial numbers", "No", "Yes"],
                    ["Date and time", "No", "Yes"],
                    ["AI labels (C2PA, IPTC)", "As an “AI info” label", "Yes, and read"],
                ])
                + "<p>To keep these details private from the platform too, remove them before you upload. "
                  "Facebook, Threads, X and most large social apps work the same way: they strip the public copy, not the upload.</p>"),
        ],
        "faq": [
            ("Can people get my location from an Instagram photo?",
             "Not from the file they can download, because Instagram removes it. Instagram itself still receives the original with the location."),
            ("Does Instagram read Content Credentials?",
             "Yes. Meta reads C2PA Content Credentials and the IPTC Digital Source Type to decide whether to show “AI info”."),
        ],
        "related": ["remove-ai-info-instagram", "remove-location-from-photos", "check-photo-metadata"],
    },
    {
        "slug": "guides/whatsapp-photo-location",
        "kind": "guide",
        "nav": "Does WhatsApp share location?",
        "title": "Does WhatsApp Remove Location from Photos? | UnMeta",
        "description": "Photos sent the normal way on WhatsApp are compressed and lose hidden details. Photos sent as a document keep everything, including the exact location.",
        "h1": "Does WhatsApp keep your photo’s <mark class=\"swipe\">location</mark>?",
        "lead": "It depends how you send it. Photos sent the normal way are compressed, and most hidden details, location included, are dropped. Photos sent as a document go as the original file, with the exact location and phone model.",
        "body": [
            sec("Normal photo vs document",
                table(["How you send it", "Picture quality", "Hidden details"], [
                    ["As a photo", "Compressed", "Mostly removed"],
                    ["As a document or file", "Original", "All kept, including location"],
                ])
                + "<p>People often send photos as documents to keep full quality. To keep the quality <em>and</em> your privacy, "
                  "clean the photo with UnMeta first and send the clean copy as a document.</p>"),
        ],
        "faq": [
            ("Does WhatsApp send the location of a photo sent as a document?",
             "Yes. A document is sent as the original file, so the location saved by the camera goes with it."),
            ("How do I send a full-quality photo without the location?",
             "Clean it with UnMeta first. It removes the location without re-compressing, so you can send the clean copy as a document at full quality."),
        ],
        "related": ["remove-location-from-photos", "check-photo-metadata", "exif-remover"],
    },
    {
        "slug": "compare",
        "kind": "guide",
        "nav": "UnMeta vs other removers",
        "title": "UnMeta vs metadata2go, AI Metadata Cleaner, MetaClean, PrivMeta",
        "description": "How UnMeta compares with other online metadata removers on uploads, limits, quality, ads and accounts, from each site’s own pages in November 2026.",
        "h1": "UnMeta compared with other <mark class=\"swipe\">metadata removers</mark>",
        "lead": "Every tool here removes metadata. They differ in where your file goes, what they do to the picture, and what they ask of you. This is how they compared on 17 November 2026, from each site’s own pages.",
        "body": [
            sec("Side by side",
                table(["What we compared", "UnMeta", "metadata2go", "AI Metadata Cleaner", "MetaClean", "PrivMeta"], [
                    ["Where your file is cleaned", "Your browser", "Their server", "Browser for photos; server for videos, PDFs, RAW", "Your browser", "Your browser"],
                    ["Free limits", "No daily limit; photos 200 MB, videos 4 GB", "5 files, 75 MB each", "3 photos a day, 10 MB", "50 files per batch", "10 files, 500 MB per batch"],
                    ["Account", "None", "For more files", "For videos, PDFs, RAW and more photos", "None", "None"],
                    ["Ads", "None", "Yes", "Yes", "None", "Yes"],
                    ["Picture quality", "Never re-encoded, checked byte for byte", "Says no quality loss", "Redrawn by default", "Says lossless; converts HEIC to JPEG", "JPEG lossless; PNG and WebP re-encoded"],
                    ["Video, audio, documents", "All three, in the browser", "Yes, uploaded", "Video and PDF on their server", "Video, PDF, Office", "Video, audio, PDF, Word"],
                ])
                + "<p>Services change their limits and features. Check each site before you rely on a detail here, and tell us if "
                  "something has changed.</p>"),
            sec("Where UnMeta is different",
                ul("<strong>Nothing leaves your device.</strong> The page’s security policy blocks it from sending data, and it works with Wi-Fi off.",
                   "<strong>Nothing is re-encoded.</strong> Photos, video frames and sound are copied byte for byte, and every clean copy is read again to check.",
                   "<strong>It reads AI labels.</strong> C2PA Content Credentials, IPTC Digital Source Type and AI prompts are found and named in plain words.",
                   "<strong>It says what it can’t do.</strong> Invisible watermarks and anything visible in the picture stay.")),
            sec("When another tool may suit you better",
                ul("You need to edit metadata, not just remove it: metadata2go and MetaClean offer editors.",
                   "You want to change a photo’s fingerprint for reverse image search: that needs re-encoding, which UnMeta deliberately never does.")),
        ],
        "faq": [
            ("What is the best free metadata remover?",
             "One that doesn’t upload your file, doesn’t re-encode it and doesn’t limit you. UnMeta runs in your browser, keeps the picture byte-for-byte identical, and has no account, ads or daily limit."),
            ("Is there a metadata2go alternative that doesn’t upload files?",
             "Yes. UnMeta cleans photos, videos, audio and documents inside your browser, so the file never reaches a server."),
        ],
        "related": ["remove-metadata-from-photos", "exif-remover", "about"],
    },
    {
        "slug": "guides/which-apps-remove-photo-metadata",
        "kind": "guide",
        "nav": "Which apps remove metadata?",
        "title": "Which Apps Remove Photo Metadata? Instagram, WhatsApp, Discord and More",
        "description": "Which apps and sharing methods remove a photo’s location and other metadata, and which send the original file with everything in it.",
        "h1": "Which apps remove photo <mark class=\"swipe\">metadata</mark>?",
        "lead": "Most social apps remove location from the copy other people see. Anything that sends the original file, such as email, AirDrop, cloud links or “send as document”, keeps every detail.",
        "body": [
            sec("App by app",
                "<p><strong>Short answer:</strong> if an app compresses or re-sizes your photo, the copy others get has usually lost "
                "its metadata. If it sends the original file, the metadata goes too.</p>"
                + table(["App or method", "What other people receive", "Notes"], [
                    ["Instagram, Facebook, Threads", "Metadata removed", "Meta receives the original and reads AI labels first"],
                    ["X (Twitter)", "Metadata removed", "The platform receives the original"],
                    ["WhatsApp, as a photo", "Mostly removed (compressed)", "As a document, the original goes, location included"],
                    ["Telegram, as a photo", "Removed (compressed)", "As a file, the original goes, location included"],
                    ["Discord", "Removed from pictures", "Videos and other files are sent as they are"],
                    ["Signal", "Removed", "Signal strips photo metadata before sending"],
                    ["iMessage, AirDrop", "The original, with location", "Unless you turn off Location under Options"],
                    ["Email attachments", "The original", "Every detail goes"],
                    ["Google Drive, Dropbox, iCloud links", "The original", "Every detail goes"],
                ])
                + "<p>Apps change how they handle files. Treat this as how they worked at the time of writing.</p>"),
            sec("The safe habit",
                "<p>Clean the photo before you share it, whatever the app. Then it doesn’t matter whether the app strips "
                "metadata, keeps it, or reads it before removing it.</p>" + f"<p>{PROMISE}</p>"),
        ],
        "faq": [
            ("Do apps that remove metadata still see it?",
             "Usually yes. Social apps receive your original file and remove the details from the copy they show others. Cleaning it first means they never get them."),
            ("Does sending a photo by email keep the location?",
             "Yes. Email sends the original file, so its location, device and dates go with it."),
        ],
        "related": ["guides/does-instagram-remove-metadata", "guides/whatsapp-photo-location", "guides/does-discord-remove-metadata"],
    },
    {
        "slug": "guides/does-discord-remove-metadata",
        "kind": "guide",
        "nav": "Does Discord remove metadata?",
        "title": "Does Discord Remove Metadata and Location from Photos and Videos?",
        "description": "Discord removes EXIF data from pictures you upload, but videos and other files are sent as they are, with location and device details inside.",
        "h1": "Does Discord remove <mark class=\"swipe\">metadata</mark>?",
        "lead": "For pictures, mostly yes: Discord removes EXIF data, including GPS location, from images you upload. Videos and other files are sent as the original file, so a phone video can still carry where it was recorded.",
        "body": [
            sec("What Discord keeps",
                "<p><strong>Short answer:</strong> image EXIF is removed; video and file metadata is not.</p>"
                + table(["What you send", "Location and device details", "What to do"], [
                    ["JPEG or PNG picture", "Removed by Discord", "Nothing, though Discord receives the original"],
                    ["MP4 or MOV video from a phone", "Kept in the file", "Clean it with UnMeta first"],
                    ["PDF, Word or other files", "Kept in the file", "Clean it with UnMeta first"],
                ])),
            sec("Clean it before you send it",
                "<p>Videos recorded on phones often store the location in the file. UnMeta removes it, along with the phone model "
                "and dates, without re-encoding the video, so it stays the same size and quality.</p>" + f"<p>{PROMISE}</p>"),
        ],
        "faq": [
            ("Can someone get my location from a Discord video?",
             "They can if the video file contains it. Discord sends videos as they are, and phones often save the location inside the video. Clean it first."),
            ("Does Discord remove metadata from images?",
             "Yes. Discord removes EXIF data, including GPS, from images you upload. The original still reaches Discord."),
        ],
        "related": ["remove-metadata-from-video", "guides/which-apps-remove-photo-metadata", "remove-location-from-photos"],
    },
    {
        "slug": "guides/does-telegram-remove-metadata",
        "kind": "guide",
        "nav": "Does Telegram remove metadata?",
        "title": "Does Telegram Remove Metadata? Photo vs File, Explained",
        "description": "Telegram compresses photos sent the normal way and drops their metadata. Sent as a file, the original goes with its location, device and dates.",
        "h1": "Does Telegram remove <mark class=\"swipe\">metadata</mark>?",
        "lead": "It depends how you send it. A photo sent the normal way is compressed and loses its hidden details. A photo or video sent as a file is the original, with the location and device inside.",
        "body": [
            sec("Photo vs file",
                "<p><strong>Short answer:</strong> compressed photos lose metadata; files keep it.</p>"
                + table(["How you send it", "Quality", "Hidden details"], [
                    ["As a photo (compressed)", "Lower", "Removed"],
                    ["As a file", "Original", "Kept, including location"],
                    ["Video without compression", "Original", "Kept, including location"],
                ])
                + "<p>To keep full quality without the details, clean the file with UnMeta and send the clean copy as a file.</p>"),
            sec("What UnMeta removes",
                ul("Location, phone model and serial numbers", "Names, dates and editing history", "AI labels and hidden thumbnails")
                + f"<p>{PROMISE}</p>"),
        ],
        "faq": [
            ("Does Telegram keep location when sending a photo as a file?",
             "Yes. A file is sent as the original, so any location saved by the camera goes with it."),
            ("How do I send a full-quality photo on Telegram without the location?",
             "Clean it with UnMeta first. It removes the location without re-compressing, so you can send the clean copy as a file."),
        ],
        "related": ["guides/whatsapp-photo-location", "guides/which-apps-remove-photo-metadata", "remove-location-from-photos"],
    },
    {
        "slug": "guides/what-is-exif-data",
        "kind": "guide",
        "nav": "What is EXIF data?",
        "title": "What Is EXIF Data? What It Reveals and How to Remove It",
        "description": "EXIF data is information a camera or phone saves inside a photo: device, settings, date and often GPS location. What it shows, and how to see and remove it.",
        "h1": "What is <mark class=\"swipe\">EXIF data</mark>?",
        "lead": "EXIF (Exchangeable Image File Format) is the standard cameras and phones use to save details inside a photo: the device, its settings, the date and time, and often the exact location.",
        "body": [
            sec("What EXIF data contains",
                "<p><strong>Short answer:</strong> EXIF is a block of labelled fields stored inside JPEG, HEIC, TIFF and RAW files. "
                "A typical phone photo has 60 to 100 of them.</p>"
                + table(["Field", "Example", "Why it matters"], [
                    ["GPS latitude and longitude", "51° 30′ 26″ N, 0° 7′ 39″ W", "Where you were, to a few metres"],
                    ["Make and model", "Apple iPhone 15 Pro", "Which device you use"],
                    ["Body serial number", "C39XK1234", "Links every photo from one device"],
                    ["Date and time original", "2026:03:01 09:15:42 +01:00", "When you were there, and your time zone"],
                    ["Artist, copyright", "Jane Doe", "Your name"],
                    ["Thumbnail", "A small JPEG", "Can show what you cropped out"],
                ])),
            sec("EXIF, XMP, IPTC and C2PA",
                ul("<strong>EXIF:</strong> device, settings, time and location, written by the camera.",
                   "<strong>XMP:</strong> editing history and labels, written by apps such as Lightroom and Photoshop.",
                   "<strong>IPTC:</strong> captions, credits, keywords and the Digital Source Type that marks AI images.",
                   "<strong>C2PA Content Credentials:</strong> a signed record of how the image was made and edited.")
                + "<p>UnMeta reads all four, shows them in plain words, and removes them without touching the picture.</p>"),
        ],
        "faq": [
            ("How do I see the EXIF data of a photo?",
             "Open the photo in UnMeta. It lists the details that matter in plain words, and “All details” shows every field, all without uploading the photo."),
            ("Do screenshots have EXIF data?",
             "A screenshot has less, but it still records the device and the time it was taken, and some phones add more."),
            ("Is EXIF data removed when I post online?",
             "Most social apps remove it from the public copy but receive the original. Email, AirDrop, cloud links and “send as file” keep it."),
        ],
        "related": ["check-photo-metadata", "exif-remover", "remove-metadata-from-photos"],
    },
    {
        "slug": "about",
        "kind": "info",
        "nav": "About UnMeta",
        "title": "About UnMeta: How It Works and What It Promises",
        "description": "UnMeta is a free tool that shows and removes hidden details from photos, videos and recordings inside your browser. How it works, and the promises it makes.",
        "h1": "About UnMeta",
        "lead": "UnMeta shows what a photo, video or recording reveals about you, and removes it without uploading the file or changing the picture or sound. It’s free, with no account, no ads and no tracking.",
        "body": [
            sec("Three promises",
                ul("<strong>Nothing is uploaded.</strong> Files are read and cleaned in your browser. The page’s security policy blocks it from sending data anywhere, and it works offline.",
                   "<strong>Nothing is re-encoded.</strong> Only the details around the picture or sound change. UnMeta checks the picture data is identical before you download.",
                   "<strong>Nothing is overstated.</strong> UnMeta says what it can’t remove: anything visible or audible, invisible watermarks, and what platforms detect on their own.")),
            sec("How it works",
                "<p>The UnMeta engine understands the structure of each format, including JPEG segments, PNG chunks, HEIC items, "
                "TIFF fields, MP4 boxes and ID3 tags. It removes only the parts that carry private details, then reads the clean copy "
                "again from scratch to check nothing was left. It has been tested with real Apple-encoded photos and videos, "
                "and with more than a thousand deliberately damaged files.</p>"),
        ],
        "faq": [],
        "related": ["privacy", "check-photo-metadata", "exif-remover"],
    },
    {
        "slug": "privacy",
        "kind": "info",
        "nav": "Privacy",
        "title": "Privacy: UnMeta Never Receives Your Files",
        "description": "UnMeta processes files in your browser and never receives them. No cookies, no analytics, no accounts.",
        "h1": "Privacy",
        "lead": "UnMeta never receives your photos, videos or recordings. They are read and cleaned inside your browser and are forgotten when you start over or close the page.",
        "body": [
            sec("What we collect",
                ul("Your files: nothing. They never leave your device.",
                   "Cookies, analytics, advertising, tracking: none.",
                   "Accounts: none.",
                   "Server logs: like any website, the host may keep standard access logs (such as IP address and page requested) for security. They never include your files.")),
            sec("Offline copy and links",
                "<p>After your first visit, your browser keeps a copy of UnMeta’s own code, styles and fonts so it works offline. "
                "It never contains your files. The “Buy me a coffee” link opens Buy Me a Coffee’s own website, which has its own privacy policy.</p>"),
        ],
        "faq": [],
        "related": ["about", "check-photo-metadata"],
    },
]

BY_SLUG = {p["slug"]: p for p in PAGES}
