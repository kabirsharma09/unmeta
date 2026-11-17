# Launch posts

Drafts for getting UnMeta mentioned (and linked) where people look for metadata tools. Post them yourself, from
your own accounts, one place at a time. Every claim here is true of the live site; keep it that way if you edit.

Source: https://github.com/kabirsharma09/unmeta (MIT).

---

## AlternativeTo

Add UnMeta as an alternative to: metadata2go, ExifCleaner, ExifTool, ExifPurge, Metadata Remover, Scrambled Exif.

**Name:** UnMeta
**URL:** https://unmeta.vercel.app
**Category:** Privacy / Photo metadata
**Platforms:** Online (web), works offline after the first visit
**License:** Free, open source (MIT)
**Tags:** exif-remover, metadata-remover, privacy, gps, c2pa, photo-privacy

**Description:**
UnMeta removes hidden metadata (GPS location, phone model and serial number, names, dates, AI labels such as
C2PA Content Credentials) from photos, videos, audio and PDF/Office documents. Everything happens in your browser:
files are never uploaded, and the page is technically blocked from sending data, so it even works with Wi-Fi off.
It never re-encodes the picture or sound; it removes only the details around them and checks the picture data is
byte-for-byte identical afterwards. No account, no ads, no daily limit. Photos up to 200 MB, videos up to 4 GB.

---

## Show HN (Hacker News)

**Title:** Show HN: UnMeta – remove photo/video metadata in the browser, losslessly, with no upload

**Text:**
I built UnMeta because most "remove EXIF online" tools upload your photo to a server to clean it, re-compress it,
or both, which defeats the point for anything sensitive.

UnMeta runs entirely in the browser (a TypeScript engine in a Web Worker). The page's Content-Security-Policy is
`connect-src 'none'`, so it can't send data anywhere even if it wanted to; you can check by turning off Wi-Fi.

What it does differently:
- Lossless: it edits only the metadata structures (JPEG segments, PNG chunks, HEIC/MP4 boxes, TIFF/RAW fields,
  ID3/APE tags, PDF Info/XMP, OOXML docProps). Picture, frames and sound are copied byte for byte, and every
  output is re-parsed from scratch to check nothing private survived.
- It reads AI provenance: C2PA Content Credentials, IPTC DigitalSourceType, Stable Diffusion/ComfyUI prompts.
  That's what drives Instagram's "AI info" label on real photos edited with Generative Fill or Magic Editor.
- Videos up to 4 GB are read in slices, never loaded whole.
- Documents: removes author/company/template paths but deliberately shows (never deletes) comments and tracked
  changes, because silently deleting those changes a document's meaning.

It's been fuzzed with a few thousand damaged files and a set of hostile ones (zip-bomb PNG text chunks, 200k nested
MP4 boxes, prototype-key tricks, appended ID3/APE tags). It won't remove invisible watermarks like SynthID, or
anything visible in the picture, and it says so.

Feedback on formats it gets wrong is very welcome.

---

## Reddit: r/privacy

Read the subreddit rules first; post as a discussion, not an ad, and answer questions.

**Title:** I made a metadata remover that can't upload your files (it works with Wi-Fi off). Feedback welcome

**Body:**
Most online EXIF removers upload your photo to clean it. I wanted one where that's impossible, not just promised:
UnMeta runs in your browser and its security policy blocks all network connections from the page, so you can
literally turn off Wi-Fi and it still works.

It shows what a file reveals in plain words (location, phone + serial number, your name, dates, AI labels,
hidden thumbnails) and removes it without re-compressing anything. Photos, videos up to 4 GB, voice memos, PDFs
and Office files. Free, no account, no ads, no analytics.

Limits I want to be upfront about: it can't touch what's visible in the picture, and it can't remove invisible
watermarks like SynthID.

https://unmeta.vercel.app — I'd love to hear what it misses.

---

## Reddit: r/Instagram (or r/photography, r/AskPhotography)

**Title:** Why your real photo gets the "AI info" label, and how to see the data causing it

**Body:**
If Instagram labels a real photo "AI info", it's usually because an editing app wrote hidden data into the file
when you used a generative tool, even a tiny one: Photoshop's Remove tool, Generative Fill, Google's Magic Editor,
Galaxy AI edits. Instagram reads two things: C2PA Content Credentials and the IPTC "Digital Source Type".

You can see whether your file has them before you post. I made a free tool that shows them in plain words and can
remove them (in your browser, nothing uploaded, no quality loss): https://unmeta.vercel.app/remove-ai-info-instagram/

Please only do this for photos that really are yours and real: if an image was genuinely made with AI, Meta asks
you to label it.

---

## Product Hunt

**Name:** UnMeta
**Tagline (60 chars):** Remove hidden photo & video metadata. Nothing uploaded.
**Topics:** Privacy, Photography, Productivity

**Description:**
See what your photos, videos and documents give away (location, phone serial number, your name, AI labels) and
remove it in your browser. Lossless, free, no sign-up, works offline.

**First comment (maker):**
Hi PH! UnMeta started from a simple worry: "remove EXIF" sites mostly upload your photo to do it. UnMeta never
can: the page is blocked from making network connections, so you can test it with Wi-Fi off. It also doesn't
re-compress anything, and it reads AI labels (C2PA, IPTC) that cause Instagram's "AI info" tag on real photos.
I'd love to know which file it gets wrong.

---

## GitHub lists

Open a pull request adding one line to lists such as "awesome-privacy" (Lissy93/awesome-privacy, under
Metadata / Photo tools) and "privacy-tools" style lists. Follow each list's contributing guide.

**Line:**
`[UnMeta](https://unmeta.vercel.app) - Removes EXIF, GPS, C2PA and document metadata in the browser, losslessly; files are never uploaded. ([Source](https://github.com/kabirsharma09/unmeta))`
