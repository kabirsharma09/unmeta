# UnMeta

See what's hidden in your images, then remove it locally. UnMeta handles EXIF, GPS, maker notes, thumbnails, IPTC, XMP, ICC,
**C2PA / Content Credentials**, IPTC **DigitalSourceType** and AI-generator prompt chunks (Stable Diffusion, ComfyUI, NovelAI…).

* Research, feature priorities, stack and wireframes: [docs/RESEARCH_AND_PLAN.md](docs/RESEARCH_AND_PLAN.md)
* Website: `unmeta serve` · Engine (TypeScript, runs in the browser): [engine/](engine/) · CLI: `metaclean --help`

## Run it

```bash
cd metaclean
python3 -m venv .venv && .venv/bin/pip install -e ".[raw,dev]"
.venv/bin/unmeta serve            # opens http://127.0.0.1:8765
```

Flow: **drop files or folders → read the report → Clean everything (or Advanced) → before/after + verification → download, zip, share or save back to the folder.**

## CLI

```bash
metaclean inspect photos/ -v                       # grouped, risk-rated report
metaclean inspect photos/ --report report.pdf      # also .json / .csv
metaclean clean photos/ --out cleaned/             # default preset: Social media share
metaclean clean img.jpg --preset full_wipe --overwrite
metaclean clean img.jpg --preset copyright_only --set copyright="© 2026 Me" --set artist="Me"
metaclean clean img.heic --format jpeg --quality 90
metaclean clean img.jpg --keep device,technical --drop-field exif:exif:42033
metaclean watch ~/Downloads/to-share --out ~/Downloads/clean
metaclean presets list | save NAME --keep technical | delete NAME
metaclean demo samples/                            # sample images packed with metadata
```

## How cleaning works (never touches picture quality)

| Format | Method |
|---|---|
| JPEG, PNG, WebP | The file is rebuilt block by block. The compressed picture data is copied byte for byte. |
| HEIC/HEIF, AVIF | Metadata items (EXIF, XMP) and C2PA boxes are blanked in place, so every offset stays valid and the picture is untouched. |
| TIFF, RAW (DNG, CR2, NEF, ARW, ORF, RW2…) | Private tag values are zeroed in place. Camera make and model are kept in RAW files because RAW developers need them to decode colours. |

* Every clean is checked: the output is scanned again from scratch, and the compressed picture data is compared with the original byte for byte.
* Rotation and the colour profile are kept by default, so photos look exactly the same.
* Converting formats or rotating pixels is CLI-only (`--format`, `--orientation bake`), because both re-encode the photo.
* **Limits:** invisible pixel watermarks such as Google SynthID live in the picture itself and are not metadata, so they are not removed. Kept C2PA manifests no longer validate after any edit.

## How the web app works

The web page never sends photos or videos anywhere. `metaclean/static/engine.worker.js` runs the TypeScript engine (`engine/src/`) in a Web Worker inside the visitor's browser; the server only serves the page, so it can be hosted on any website. Rebuild the worker after changing the engine:

```bash
cd engine && npm run build:web
```

The Python server's `/api/*` endpoints remain for local tools and tests, but the web page doesn't use them, and they are switched off whenever a public URL is set.

Videos (MP4, MOV, M4V, 3GP) and audio (M4A, MP3, WAV) are read in slices from the visitor's file, never loaded whole, and the clean copy is stitched from untouched slices of the original plus the patched metadata blocks, so files up to 4 GB work and frames and samples stay byte-for-byte identical.

## Documents

PDF, Word, Excel and PowerPoint files (`engine/src/docs.ts`) are read in slices like videos. UnMeta removes the author, last edited by, company, manager, template path, editing time, dates, custom properties, hidden previews and the app that made them, and cleans the photos inside Office files losslessly. Comments, tracked changes, annotations, form data, attachments and earlier PDF versions are shown and never changed. Office files keep every untouched part byte-for-byte; PDFs are cleaned in place, so they keep their length and cross-reference table. Encrypted files and details inside compressed PDF object streams are reported, not claimed as clean.

## Landing pages

`metaclean/pages.py` holds the keyword landing pages and guides (each with answer-first copy, FAQ, breadcrumbs and structured data); `metaclean/site.py` renders them from the home page template so the working tool is on every page. They appear in the sitemap, `llms.txt`, the footer and the static export.

## Hosting, search and accessibility

- **Local by default.** `unmeta serve` binds to 127.0.0.1 and tells crawlers not to index it (`noindex` and a `robots.txt` that disallows everything).
- **Hosted publicly:** run `unmeta serve --public-url https://your.domain` (or set `METACLEAN_PUBLIC_URL`) behind your reverse proxy. Indexing, the canonical URL, absolute share images, `sitemap.xml` and HSTS turn on, and the upload API is switched off.
- **Choose a host that sends the headers.** Netlify and Cloudflare Pages read the exported `_headers` file. GitHub Pages and plain S3 ignore it: the page still carries its policy in a `<meta>` tag (so it still cannot send data), but framing protection, the stricter worker and service-worker policies and Permissions-Policy are lost. Behind your own server, copy the rules from `_headers`.
- **Vercel:** `scripts/deploy-vercel.sh https://your.domain` exports the site (with a `vercel.json` carrying the same security headers, one Content-Security-Policy per path) and deploys it with the Vercel CLI.
- **Static hosting (recommended):** `unmeta export site --public-url https://your.domain` writes a ready-to-upload folder for Netlify, Cloudflare Pages, GitHub Pages or any static host, including a `_headers` file with the security headers. Each path gets exactly one Content-Security-Policy, so hosts that merge header rules can't accidentally block the service worker. The page also carries its policy in a `<meta>` tag.
- **Previews for HEIC and RAW:** RAW files show their built-in JPEG preview; HEIC photos show their built-in HEVC thumbnail, decoded by the browser's own video decoder (WebCodecs), so no WebAssembly and no change to the security policy. Safari shows HEIC natively.
- **Offline:** a service worker (`/sw.js`, built from `metaclean/static/_sw.js`) saves the app's own files on the first visit, so UnMeta opens and works with no connection. It needs HTTPS (or localhost). It never caches `/api/` and never sees photos or videos. The page loads fresh from the network whenever it's online, so updates arrive on the next visit.
- **Search and AI answer engines (SEO/GEO):** the page content and FAQ are in the HTML itself, with JSON-LD structured data (`SoftwareApplication`, `HowTo`, `FAQPage`), Open Graph and Twitter cards, and `/llms.txt`, a plain-language summary for AI assistants.
- **Accessibility (WCAG 2.2 AA):** skip link and landmarks, one `h1` per screen, live announcements for progress and results, dialogs that make the page behind them `inert`, keyboard support for every control, 24px minimum targets, forced-colours (Windows high contrast) support and reduced motion. `tests/test_design.py` checks every colour pairing in both themes. The screens were audited with axe-core with no violations.
- **Best practices and hardening:** web app manifest and icons, woff2 fonts that are preloaded and cached long-term, no cookies or analytics, no third-party requests, a strict Content-Security-Policy (`connect-src 'none'`), `nosniff`, `DENY` framing, `no-referrer`, cross-origin isolation headers, a Permissions-Policy that turns off camera, microphone, location and payment, and HSTS when hosted over HTTPS. The engines are fuzzed with over a thousand damaged photos, videos and recordings, and media cleans are double-checked by searching the output for any removed text.

## Engine

`engine/` is the TypeScript engine the website runs in a Web Worker. Same lossless approach as the Python engine.

```bash
cd engine
npm install
npm test            # unit, real Apple files, hostile files, property and fuzz tests
npm run build:web   # writes metaclean/static/engine.worker.js
```

## Testing with real files

`engine/src/fixtures/apple.*` are genuine Apple-encoded files (ImageIO HEIC/JPEG, AVFoundation MOV/MP4) carrying GPS, phone model, serial number and owner. Regenerate them, and check cleaned copies with Apple's own frameworks, on a Mac:

```bash
swiftc -O tools/make_apple_fixtures.swift -o /tmp/make && /tmp/make engine/src/fixtures
swiftc -O tools/verify_with_apple.swift -o /tmp/verify && /tmp/verify <folder with apple.* and clean_apple.*>
```

The web app has also been run end to end in Safari on iOS (Simulator): the iOS photo picker, cleaning Apple's sample photos (an iPhone X photo with GPS) and downloading the zip.

## Tests

```bash
.venv/bin/python -m pytest -q
```

## Licence

MIT (see `LICENSE`). The IBM Plex fonts in `metaclean/static/fonts/` are under the SIL Open Font License (the `OFL-*.txt` files beside them).
